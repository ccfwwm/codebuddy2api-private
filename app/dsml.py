#!/usr/bin/env python3
"""Repair native DeepSeek tool-call markup leaked into upstream assistant content.

Upstream renders tool calls as DSML markup blocks only when the request declared tools;
once tools are lost mid-session the markup lands in plain text. Observed variants share
one shape with different separators and block names (``<｜｜DSML｜｜ calls>`` and
``<|DSML|> function_calls`` were both seen live). This module is the last-line repair: a
streaming line rewriter and an aggregated-result repairer that restore standard
``tool_calls``. Byte-exact passthrough invariant: every input byte is emitted except the
markup blocks that were successfully converted; open/close separators must match.
"""
from __future__ import annotations

import json
import re
import secrets

SEPARATORS = ("｜｜", "｜", "|")
BLOCK_NAMES = ("calls", "function_calls")
# (separator, block name) → tag strings; separators must match across a block's tags.
VARIANTS = tuple({"sep": sep, "name": name, "open": f"<{sep}DSML{sep} {name}>",
                  "close": f"</{sep}DSML{sep} {name}>",
                  "invoke_close": f"</{sep}DSML{sep} invoke>",
                  "param_close": f"</{sep}DSML{sep} parameter>"}
                 for sep in SEPARATORS for name in BLOCK_NAMES)
OPENERS = tuple(variant["open"] for variant in VARIANTS)
MAX_OPENER = max(len(opener) for opener in OPENERS)
INVOKE_RES = {sep: re.compile(re.escape(f"<{sep}DSML{sep}")
                              + r'\s+invoke\s+name="([^"]*)"\s*>') for sep in SEPARATORS}
PARAM_RES = {sep: re.compile(re.escape(f"<{sep}DSML{sep}")
                             + r'\s+parameter\s+name="([^"]*)"(?:\s+string="(true|false)")?\s*>')
             for sep in SEPARATORS}
NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$")
PIPE_HINTS = ("｜", "|DSML", "\\u")
# 第三种已观测到的上游原生语法（<tool_calls:opensource>…）；只观测不修复。
OPENSOURCE_RE = re.compile(r"<tool_calls:[A-Za-z0-9_:-]{0,32}>")
MAX_BLOCK_BYTES = 256 * 1024


def ends_partial_opener(text: str) -> bool:
    """True when the tail could still grow into an opener (增量边界截断的起始标记)."""
    return any(opener.startswith(text[-size:]) for size in range(1, min(MAX_OPENER, len(text)) + 1)
               for opener in OPENERS)


class MarkupRepair:
    """Streaming state machine shared by SSE rewriting and aggregated repair.

    Not concurrency-safe: one instance per response stream.
    """

    def __init__(self, allowed: frozenset[str] | set[str] | None):
        self.allowed = allowed or frozenset()
        self.hold = ""
        self.in_block = False
        self.variant: dict = {}
        self.seen = 0
        self.rejected = 0
        self.converted = 0

    def feed(self, text: str) -> tuple[str, list[dict]]:
        """Consume one content increment; return (passthrough text, converted calls)."""
        s = self.hold + text
        self.hold = ""
        emit: list[str] = []
        calls: list[dict] = []
        while True:
            if not self.in_block:
                best, variant = -1, None
                for candidate in VARIANTS:
                    j = s.find(candidate["open"])
                    if j >= 0 and (best < 0 or j < best):
                        best, variant = j, candidate
                if best < 0:
                    if ends_partial_opener(s):
                        self.hold = s     # 整段都可能是被截断的起始标记
                    else:
                        emit.append(s)
                    break
                if ends_partial_opener(s[best:]) and len(s) - best < MAX_OPENER:
                    emit.append(s[:best])
                    self.hold = s[best:]  # 开头被增量边界截断，留待下一片判定
                    break
                emit.append(s[:best])
                s = s[best + len(variant["open"]):]
                self.in_block = True
                self.variant = variant
                continue
            close = self.variant["close"]
            k = s.find(close)
            if k < 0:
                if len(s.encode("utf-8")) > MAX_BLOCK_BYTES:
                    emit.append(self.variant["open"])   # 超长未闭合：不是标记，原文回吐
                    emit.append(s)
                    self.in_block = False
                    break
                self.hold = s
                break
            inner, s = s[:k], s[k + len(close):]
            self.in_block = False
            self.seen += 1
            block_calls, ok = self._parse_block(inner, self.variant)
            if ok:
                calls.extend(block_calls)
                self.converted += len(block_calls)
                continue
            self.rejected += 1
            emit.append(self.variant["open"])
            emit.append(inner)
            emit.append(close)
        return "".join(emit), calls

    def flush(self) -> str:
        """Return the undetermined tail verbatim when the stream ends."""
        out = self.hold
        if self.in_block:
            out = self.variant["open"] + out
        self.hold = ""
        self.in_block = False
        return out

    def _parse_block(self, inner: str, variant: dict) -> tuple[list[dict], bool]:
        strict = bool(self.allowed)
        invoke_re, param_re = INVOKE_RES[variant["sep"]], PARAM_RES[variant["sep"]]
        invoke_close, param_close = variant["invoke_close"], variant["param_close"]
        out: list[dict] = []
        pos = 0
        for match in invoke_re.finditer(inner):
            if inner[pos:match.start()].strip():
                return [], False     # invoke 之前夹带正文
            name = match.group(1)
            body_start = match.end()
            end = inner.find(invoke_close, body_start)
            if end < 0:
                return [], False     # invoke 未闭合
            arguments, ok = self._parse_params(inner[body_start:end], param_re, param_close)
            if not ok:
                return [], False
            if strict:
                if name not in self.allowed:
                    return [], False
            elif not NAME_RE.match(name):
                return [], False
            out.append({"name": name, "arguments": arguments})
            pos = end + len(invoke_close)
        if not out or inner[pos:].strip():
            return [], False
        return out, True

    @staticmethod
    def _parse_params(body: str, param_re, param_close: str) -> tuple[str, bool]:
        args: dict = {}
        pos = 0
        for match in param_re.finditer(body):
            if body[pos:match.start()].strip():
                return "", False
            name, is_string = match.group(1), match.group(2) == "true"
            value_start = match.end()
            end = body.find(param_close, value_start)
            if end < 0:
                return "", False
            raw = body[value_start:end]
            pos = end + len(param_close)
            if is_string:
                args[name] = raw
                continue
            try:
                args[name] = json.loads(raw)
            except (TypeError, ValueError):
                args[name] = raw     # 参数值永不丢失，最坏退化成字符串
        if body[pos:].strip():
            return "", False
        return json.dumps(args, ensure_ascii=False, sort_keys=True, separators=(",", ":")), True


def tool_name_allowlist(body: dict) -> frozenset[str]:
    """Collect trustworthy tool names from the request declaration and message history."""
    if not isinstance(body, dict):
        return frozenset()
    names: set[str] = set()
    for tool in body.get("tools") or []:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        if isinstance(function, dict) and isinstance(function.get("name"), str) and function["name"]:
            names.add(function["name"])
        elif isinstance(tool.get("name"), str) and tool["name"]:
            names.add(tool["name"])
    for function in body.get("functions") or []:
        if isinstance(function, dict) and isinstance(function.get("name"), str) and function["name"]:
            names.add(function["name"])
    for message in body.get("messages") or []:
        if not isinstance(message, dict):
            continue
        for call in message.get("tool_calls") or []:
            function = call.get("function") if isinstance(call, dict) else None
            if isinstance(function, dict) and isinstance(function.get("name"), str) and function["name"]:
                names.add(function["name"])
        function_call = message.get("function_call")
        if isinstance(function_call, dict) and isinstance(function_call.get("name"), str) and function_call["name"]:
            names.add(function_call["name"])
    return frozenset(names)


def _call_id(index: int) -> str:
    return f"call_{secrets.token_hex(8)}_{index}"


def repair_aggregated(result: dict, allowed: frozenset[str]) -> tuple[int, int, int]:
    """Repair one collected chat completion in place; returns (converted, seen, rejected)."""
    repair = MarkupRepair(allowed)
    for choice in result.get("choices") or []:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if not isinstance(message, dict) or message.get("tool_calls"):
            continue     # 不覆盖真实调用
        if choice.get("finish_reason") != "stop":
            continue     # length 截断里的标记必然不完整
        content = message.get("content")
        if not isinstance(content, str) or "<" not in content or "DSML" not in content:
            continue
        emit, calls = repair.feed(content)
        emit += repair.flush()
        if not calls:
            continue
        message["content"] = emit or None
        message["tool_calls"] = [{"id": _call_id(i), "type": "function",
                                  "function": {"name": call["name"], "arguments": call["arguments"]}}
                                 for i, call in enumerate(calls)]
        choice["finish_reason"] = "tool_calls"
    return repair.converted, repair.seen, repair.rejected


class SSERepairer:
    """Rewrite one upstream Chat SSE line stream, restoring markup blocks as tool_calls deltas.

    Lines are parsed only when the cheap prefilter can plausibly match (block active,
    pending tail, separator hints, escaped unicode, finish/tool_calls keys), so clean
    streams pay a few substring scans per line.
    """

    def __init__(self, allowed: frozenset[str]):
        self.repair = MarkupRepair(allowed)
        self.known = len(allowed)
        self.converted = 0
        self.seen = 0
        self.rejected = 0
        self.saw_structured = False
        self.saw_opensource = False
        self._max_index = -1
        self._template: dict = {}
        self._pending = False

    def feed(self, line: str) -> list[str]:
        if not line.startswith("data:"):
            return [line]
        if line.strip() == "data: [DONE]":
            # 残留的字节必须在结束标记之前交还，否则聚合器会判定 done 后仍有输出。
            return [*self.flush(), line]
        needs_parse = (self._pending or self.repair.in_block or bool(self.repair.hold)
                       or any(hint in line for hint in PIPE_HINTS)
                       or "<tool_calls:" in line
                       or '"finish_reason"' in line or '"tool_calls"' in line)
        if not needs_parse:
            return [line]
        try:
            chunk = json.loads(line[5:].strip())
        except ValueError:
            return [line]
        if not isinstance(chunk, dict):
            return [line]
        self._template = {key: chunk[key] for key in ("id", "model") if chunk.get(key) is not None}
        choices = chunk.get("choices") or []
        choice = choices[0] if isinstance(choices[0], dict) else {}
        delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
        mutated = False
        for tool in delta.get("tool_calls") or []:
            if isinstance(tool, dict) and isinstance(tool.get("index"), int):
                self._max_index = max(self._max_index, tool["index"])
            self.saw_structured = True
        content = delta.get("content")
        if isinstance(content, str) and content:
            if OPENSOURCE_RE.search(content):
                self.saw_opensource = True
            emit, calls = self.repair.feed(content)
            if calls:
                base = self._max_index + 1
                synthetic = self._tool_lines(calls, base)
                self._max_index = base + len(calls) - 1
            else:
                synthetic = []
            if emit != content or calls:
                delta["content"] = emit
                mutated = True
            out = ["data: " + json.dumps(chunk, ensure_ascii=False)] if mutated else [line]
            out.extend(synthetic)
        else:
            out = [line]
        if choice.get("finish_reason") == "stop" and self.repair.converted:
            choice["finish_reason"] = "tool_calls"   # 修复出的调用必须有匹配的终止原因
            out = ["data: " + json.dumps(chunk, ensure_ascii=False)]
        self._pending = bool(delta.get("content")) and ends_partial_opener(delta.get("content") or "")
        self.converted, self.seen, self.rejected = (self.repair.converted, self.repair.seen,
                                                    self.repair.rejected)
        return out

    def flush(self) -> list[str]:
        tail = self.repair.flush()
        if not tail:
            return []
        chunk = {**self._template,
                 "choices": [{"index": 0, "delta": {"content": tail}, "finish_reason": None}]}
        return ["data: " + json.dumps(chunk, ensure_ascii=False)]

    def _tool_lines(self, calls: list[dict], base: int) -> list[str]:
        tools = [{"index": base + offset, "id": _call_id(base + offset), "type": "function",
                  "function": {"name": call["name"], "arguments": call["arguments"]}}
                 for offset, call in enumerate(calls)]
        chunk = {**self._template,
                 "choices": [{"index": 0, "delta": {"tool_calls": tools}, "finish_reason": None}]}
        return ["data: " + json.dumps(chunk, ensure_ascii=False)]
