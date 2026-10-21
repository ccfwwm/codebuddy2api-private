"""Process-wide counters and timings for routing and maintenance hot paths."""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager

_COUNTERS: dict[str, int] = {}
_TIMINGS: dict[str, dict[str, float]] = {}
_LOCK = threading.Lock()
_STARTED = time.monotonic()


def inc(name: str, amount: int = 1) -> None:
    """Count one event; the lock only guards the insert that snapshot iterates over."""
    with _LOCK:
        _COUNTERS[name] = _COUNTERS.get(name, 0) + amount


def observe(name: str, seconds: float) -> None:
    """Record one duration sample, creating the series on first use."""
    try:
        sample = max(0.0, float(seconds))
    except (TypeError, ValueError):
        return
    stats = _TIMINGS.get(name)
    if stats is None:
        with _LOCK:
            _TIMINGS.setdefault(name, {"count": 1.0, "total_s": sample, "max_s": sample, "min_s": sample})
        return
    # Samples only ever add to these fields, so a lost update costs one sample, never an error.
    stats["count"] += 1
    stats["total_s"] += sample
    stats["max_s"] = max(stats["max_s"], sample)
    stats["min_s"] = min(stats["min_s"], sample)


@contextmanager
def timed(name: str):
    """Time the enclosed block into one series."""
    start = time.perf_counter()
    try:
        yield
    finally:
        observe(name, time.perf_counter() - start)


def reset() -> None:
    """Clear every series; used by benchmarks and tests, never by a running service."""
    with _LOCK:
        _COUNTERS.clear()
        _TIMINGS.clear()


def snapshot() -> dict:
    """Return a read-only copy with millisecond timings for the management view."""
    with _LOCK:
        counters = dict(_COUNTERS)
        timings = {name: {"count": int(stats["count"]),
                          "total_ms": round(stats["total_s"] * 1000, 3),
                          "avg_ms": round(stats["total_s"] * 1000 / stats["count"], 3),
                          "max_ms": round(stats["max_s"] * 1000, 3),
                          "min_ms": round(stats["min_s"] * 1000, 3)}
                   for name, stats in _TIMINGS.items()}
    return {"uptime_seconds": round(time.monotonic() - _STARTED, 1),
            "counters": counters, "timings": timings}
