#!/usr/bin/env python3
"""Upstream /agenttool/v1/search request shaping and response parsing for REST and MCP consumers."""
from __future__ import annotations

DEFAULT_RESULTS = 5
MAX_RESULTS = 10
QUERY_TIMEOUT = 20


def request_body(query: str, max_results: int = DEFAULT_RESULTS) -> dict:
    count = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
    return {"query": query, "type": "text2text", "max_results": count}


def parse_results(payload) -> list:
    """Validate the upstream envelope and return its result items unchanged; raise ValueError on unusable bodies."""
    if not isinstance(payload, dict):
        raise ValueError("search response must be a JSON object")
    code = payload.get("code")
    if code not in (None, 0, "0"):
        raise ValueError(f"search failed: {payload.get('msg') or code}")
    results = payload.get("results")
    if not isinstance(results, list):
        raise ValueError("search response has no results list")
    return [item for item in results
            if isinstance(item, dict) and isinstance(item.get("url"), str) and item["url"]]


def search_text(query: str, results: list) -> str:
    """Render results as numbered markdown links with footnote-style snippets for MCP clients."""
    lines = [f"{index}. [{item.get('title') or item['url']}]({item['url']})"
             for index, item in enumerate(results, 1)]
    snippets = [(index, str(item.get("snippet") or "").strip()) for index, item in enumerate(results, 1)]
    snippets = [(index, snippet) for index, snippet in snippets if snippet]
    if snippets:
        lines.append("")
        lines.extend(f"[{index}] {snippet}" for index, snippet in snippets)
    return "\n".join(lines)
