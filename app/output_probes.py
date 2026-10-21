"""Read-only view of measured output limits written by scripts/probe_max_tokens.py.

Upstream catalogs advertise ``maxOutputTokens`` values that are often higher than what a
model really emits: a larger ``max_tokens`` is silently clamped instead of rejected. The
probe script measures the real cap and merges its findings into one JSON file next to the
control database; the management view reads it on every request, so a rerun shows up
without restarting the gateway. Models never probed are simply absent.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path

FILENAME = "output_probes.json"
MAX_BYTES = 2 * 1024 * 1024
VERDICTS = ("clamped", "at_least", "inconclusive")


def default_path(control_path):
    """The probe file lives beside the control database (the state directory)."""
    return Path(control_path).parent / FILENAME if control_path else None


def _tokens(value):
    return value if type(value) is int and 0 < value < 2**31 else None


def _text(value, limit):
    return value[:limit] if isinstance(value, str) else ""


def _record(raw):
    if not isinstance(raw, dict) or raw.get("verdict") not in VERDICTS:
        return None
    return {"claimed": _tokens(raw.get("claimed")), "measured": _tokens(raw.get("measured")),
            "verdict": raw["verdict"], "note": _text(raw.get("note"), 300),
            "tested_at": _text(raw.get("tested_at"), 32), "source": _text(raw.get("source"), 80)}


def read(path):
    """Return {exists, probes, updated_at}; a missing or broken file yields no annotations."""
    empty = {"exists": False, "probes": {}, "updated_at": None}
    if path is None:
        return empty
    try:
        stat = os.stat(path)
        if stat.st_size > MAX_BYTES:
            return {**empty, "exists": True, "error": "探测文件过大"}
        data = json.loads(Path(path).read_text(encoding="utf-8"),
                          parse_constant=lambda _value: math.nan)
    except FileNotFoundError:
        return empty
    except (OSError, ValueError, RecursionError):
        return {**empty, "exists": True, "error": "探测文件无法解析"}
    probes = data.get("probes") if isinstance(data, dict) else None
    if not isinstance(probes, dict):
        return {**empty, "exists": True, "error": "探测文件缺少 probes"}
    clean = {}
    for model, raw in probes.items():
        record = _record(raw)
        if isinstance(model, str) and 0 < len(model) <= 160 and record is not None:
            clean[model] = record
    return {"exists": True, "probes": clean, "updated_at": stat.st_mtime}
