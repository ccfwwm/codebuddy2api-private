#!/usr/bin/env python3
"""Measure each model's real output limit through the gateway.

Upstream catalogs advertise ``maxOutputTokens`` values that are often far higher than
what a model really emits. A larger ``max_tokens`` is not rejected; the output is just
cut at the real cap (silent clamping), so only the usage of a forced-long reply shows it.

Each model is asked to count far enough to fill the requested tier, and the stop tells
two very different stories apart:

  finish=length, output < request  -> upstream truncated: the output IS the real cap
  finish=length, output = request  -> supports at least this much: climb to the next tier
  finish=stop,   output < request  -> the model chose to stop: no verdict, retry harder

Prompt size must match the tier. Asking to count to 999999 makes models give up after a
few thousand tokens; a target around max_tokens/3 lines keeps them writing until cut.

Tiers never exceed the claimed limit, because the gateway's capability pre-check rejects
a max_tokens above the declaration. Probing spends real credits: an uncapped 100K reply
can take many minutes, so every model has a wall-clock budget and models run in parallel.

Results go to a JSONL log (``--resume`` skips models already measured) and, with
``--panel-out``, are merged into the file the management UI reads, by default
``auth/output_probes.json`` beside ``control.sqlite3``. A rerun replaces only the models
it measured; the UI picks the file up on its next request without a gateway restart.

  python3 scripts/probe_max_tokens.py --key "$CODEBUDDY2API_KEY" --panel-out auth/output_probes.json
  python3 scripts/probe_max_tokens.py --models glm-5.2,kimi --resume --panel-out auth/output_probes.json
  python3 scripts/probe_max_tokens.py --dry-run
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import threading
import time
import urllib.error
import urllib.request

FULL_RATIO = 0.98   # Usage counts may sit a few tokens under max_tokens on a full reply.


def long_prompt(tokens, hard=False):
    target = max(2000, min(200000, tokens // 3))
    if hard:
        return (f"Count from 1 to {target}, one number per line, incrementing by 1. Output digits only, "
                "one per line. Do not summarize, do not explain, do not skip numbers, do not stop early.")
    return (f"请从 1 开始，每行输出一个数字，依次递增，一直数到 {target}。"
            "严格只输出数字本身，每行一个；不要解释、不要总结、不要省略、不要合并、不要提前结束。")


def _request(base, key, path, body=None, timeout=20):
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers.update({"Content-Type": "application/json", "Accept": "text/event-stream"})
    return urllib.request.urlopen(urllib.request.Request(base.rstrip("/") + path, data=data, headers=headers,
                                                         method="POST" if body is not None else "GET"),
                                  timeout=timeout)


def fetch_models(base, key):
    """[{id, claimed}] from the gateway's /v1/models; claimed is None when undeclared or mixed."""
    with _request(base, key, "/models") as response:
        items = json.loads(response.read().decode("utf-8")).get("data") or []
    out = []
    for item in items:
        if not isinstance(item, dict) or not item.get("id") or item["id"] == "auto":
            continue
        limit = ((item.get("limits") or {}).get("maxOutputTokens") or {})
        claimed = limit.get("value") if limit.get("state") == "known" else None
        out.append({"id": item["id"], "claimed": claimed if isinstance(claimed, int) and claimed > 0 else None})
    return out


def probe_once(base, key, model, max_tokens, prompt, timeout):
    """One forced-long streamed request: (output_tokens, finish_reason, error)."""
    body = {"model": model, "stream": True, "stream_options": {"include_usage": True},
            "max_tokens": max_tokens, "messages": [{"role": "user", "content": prompt}]}
    output = finish = None
    try:
        with _request(base, key, "/chat/completions", body, timeout) as response:
            buffer = ""
            while chunk := response.read(8192):
                buffer += chunk.decode("utf-8", "replace")
                *lines, buffer = buffer.split("\n")
                for line in lines:
                    line = line.strip()
                    if not line.startswith("data:") or line[5:].strip() in ("", "[DONE]"):
                        continue
                    try:
                        event = json.loads(line[5:])
                    except ValueError:
                        continue
                    usage = event.get("usage")
                    if isinstance(usage, dict) and isinstance(usage.get("completion_tokens"), int):
                        output = usage["completion_tokens"]
                    for choice in event.get("choices") or []:
                        if isinstance(choice, dict) and choice.get("finish_reason"):
                            finish = choice["finish_reason"]
    except urllib.error.HTTPError as error:
        return None, None, f"HTTP {error.code}: {error.read().decode('utf-8', 'replace')[:200]}"
    except Exception as error:
        return None, None, f"{type(error).__name__}: {str(error)[:150]}"
    return output, finish, None


def probe_model(base, key, model, claimed, tiers, retries, timeout, budget, log):
    """Climb the tiers for one model and return its structured verdict."""
    started = time.time()
    result = {"model": model, "claimed": claimed, "measured": None, "verdict": "inconclusive",
              "note": "", "evidence": []}
    full = None
    plan = sorted({min(tier, claimed) if claimed else tier for tier in tiers})

    def finish(verdict, measured, note):
        result.update(verdict=verdict, measured=measured, note=note,
                      elapsed=round(time.time() - started, 1), time=time.strftime("%Y-%m-%d %H:%M:%S"))
        return result

    for tier in plan:
        for attempt in range(1, retries + 1):
            remaining = budget - (time.time() - started)
            if remaining <= 5:
                return finish("at_least" if full else "inconclusive", full,
                              f"超出时间预算 {budget}s" + (f"，已知至少 {full}" if full else ""))
            output, reason, error = probe_once(base, key, model, tier, long_prompt(tier, hard=attempt > 1),
                                               int(min(timeout, remaining)))
            if error:
                result["evidence"].append(f"tier={tier}: {error}")
                log(f"  [{model}] tier={tier} 失败 {error[:80]}")
                return finish("at_least" if full else "inconclusive", full, f"请求失败：{error[:120]}")
            log(f"  [{model}] tier={tier} #{attempt}: 输出 {output} finish={reason}")
            if reason == "length" and isinstance(output, int):
                if output < tier * FULL_RATIO:
                    note = f"请求 {tier} 只输出 {output}（finish=length，上游截断）"
                    result["evidence"].append(note)
                    return finish("clamped", output, note)
                full = tier
                result["evidence"].append(f"tier={tier}: 满额输出 {output}")
                break
            result["evidence"].append(f"tier={tier} #{attempt}: finish={reason}，输出 {output}")
            if attempt == retries:
                return finish("at_least" if full else "inconclusive", full,
                              "模型主动收尾，未测到截断点" + (f"；已知至少 {full}" if full else ""))
    return finish("at_least", full, "最高档位仍满额输出，未触顶")


def write_panel(path, results):
    """Merge results into the UI file: models not re-measured keep their old record."""
    path = Path(path)
    data = {"version": 1, "probes": {}}
    try:
        old = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(old.get("probes"), dict):
            data["probes"].update(old["probes"])
    except (OSError, ValueError, AttributeError):
        pass   # A broken old file is rebuilt rather than blocking new results.
    for row in results:
        data["probes"][row["model"]] = {key: row.get(key) for key in ("claimed", "measured", "verdict", "note")}
        data["probes"][row["model"]].update(tested_at=row.get("time") or "", source="probe_max_tokens.py")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    temporary.replace(path)
    print(f"面板探测数据已写入 {path}（共 {len(data['probes'])} 条）")


def select(models, wanted):
    """Exact ids win over substrings, so 'glm-5.2' does not also pull in 'glm-5.2-x'."""
    if not wanted:
        return models
    keys = [key.strip().lower() for key in wanted.split(",") if key.strip()]
    exact = [model for model in models if model["id"].lower() in keys]
    return exact or [model for model in models if any(key in model["id"].lower() for key in keys)]


def main():
    parser = argparse.ArgumentParser(description="探测模型真实输出上限（区分静默钳制与模型主动收尾）")
    parser.add_argument("--base", default="http://127.0.0.1:8787/v1", help="网关 /v1 基址")
    parser.add_argument("--key", default=None, help="API key（也读环境变量 PROBE_API_KEY / CODEBUDDY2API_KEY）")
    parser.add_argument("--models", default=None, help="逗号分隔；完整 id 优先，否则按子串匹配")
    parser.add_argument("--tiers", default="40000,100000", help="阶梯 max_tokens，超过声称值时按声称值封顶")
    parser.add_argument("--retries", type=int, default=3, help="finish=stop 时的重试次数")
    parser.add_argument("--timeout", type=int, default=900, help="单次请求超时秒数")
    parser.add_argument("--budget", type=int, default=600, help="单模型总时间预算秒数")
    parser.add_argument("--jobs", type=int, default=4, help="并行探测的模型数")
    parser.add_argument("--limit", type=int, default=0, help="只测前 N 个模型（0 为全部）")
    parser.add_argument("--out", default="probe-max-tokens.jsonl", help="结果 JSONL，--resume 从这里续测")
    parser.add_argument("--panel-out", default=None, help="合并写入面板文件，如 auth/output_probes.json")
    parser.add_argument("--resume", action="store_true", help="跳过 JSONL 里已有结果的模型")
    parser.add_argument("--dry-run", action="store_true", help="只列出计划，不发请求")
    parser.add_argument("--quiet", action="store_true", help="不打印每次尝试")
    args = parser.parse_args()

    key = args.key or os.environ.get("PROBE_API_KEY") or os.environ.get("CODEBUDDY2API_KEY") or ""
    if not key:
        raise SystemExit("[!] 需要 --key 或环境变量 PROBE_API_KEY / CODEBUDDY2API_KEY")
    tiers = sorted(int(value) for value in args.tiers.split(",") if value.strip())
    targets = select(fetch_models(args.base, key), args.models)
    if args.limit:
        targets = targets[:args.limit]
    if not targets:
        raise SystemExit("[!] 没有匹配的模型")

    out_path = Path(args.out)
    done = {}
    if args.resume and out_path.is_file():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
                done[row["model"]] = row
            except (ValueError, KeyError, TypeError):
                pass
    todo = [model for model in targets if model["id"] not in done]
    print(f"目标 {args.base} | 待测 {len(todo)}/{len(targets)} 个模型 | 阶梯 {tiers} | 并行 {args.jobs}")
    if args.dry_run:
        for model in targets:
            plan = sorted({min(tier, model["claimed"]) if model["claimed"] else tier for tier in tiers})
            skip = "（已有结果，跳过）" if model["id"] in done else ""
            print(f"  {model['id']:40} 声称 {str(model['claimed'] or '-'):>8}  阶梯 {plan}{skip}")
        return

    lock = threading.Lock()
    counter = [0]
    log = (lambda message: None) if args.quiet else (lambda message: print(message, flush=True))

    def work(model):
        row = probe_model(args.base, key, model["id"], model["claimed"], tiers, args.retries,
                          args.timeout, args.budget, log)
        with lock:
            counter[0] += 1
            with out_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
            print(f"[{counter[0]}/{len(todo)}] {row['model']}（声称 {row['claimed'] or '-'}）→ "
                  f"{row['verdict']} {row['measured'] or '-'} | {row['note']} | {row['elapsed']}s", flush=True)
        return row

    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        results = [*done.values(), *pool.map(work, todo)]
    clamped = [row for row in results if row["verdict"] == "clamped" and row.get("claimed")
               and row["measured"] < row["claimed"]]
    if clamped:
        print(f"\n⚠ {len(clamped)} 个模型被静默钳制：")
        for row in clamped:
            print(f"    {row['model']}: 声称 {row['claimed']} → 实际 {row['measured']}")
    if args.panel_out:
        write_panel(args.panel_out, [row for row in results if row["model"] in {m["id"] for m in targets}])


if __name__ == "__main__":
    main()
