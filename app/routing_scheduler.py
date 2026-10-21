"""Revision-keyed credential shards for request-side selection."""
from __future__ import annotations

import time

from . import perf_metrics

MODES = ("legacy", "shadow", "indexed")
MISMATCH_LIMIT = 20


class RoutingScheduler:
    """Serve the statically eligible entries per model; dynamic health stays per request.

    ``legacy`` evaluates every credential on every request, ``indexed`` reuses a shard built
    for the current revision set, and ``shadow`` does both while returning the legacy answer.
    """

    __slots__ = ("_shards", "mismatches", "_limit")

    def __init__(self, limit=32):
        self._shards: dict[tuple, tuple] = {}
        self.mismatches: list[dict] = []
        self._limit = max(1, limit)   # Aliases share one upstream model, so keep several shards.

    @staticmethod
    def mode(config) -> str:
        """Resolve the configured mode, falling back to the conservative shadow default."""
        value = config.get("routing_scheduler", "shadow")
        return value if value in MODES else "shadow"

    def clear(self):
        self._shards.clear()

    def candidates(self, *, mode, revisions, model, region, entries, evaluate):
        """Return statically eligible entries for one model and region."""
        if mode == "legacy":
            return [entry for entry in entries if evaluate(entry)]  # No shard is built.
        key = (model, region, *revisions)
        shard = self._shards.get(key)
        if shard is None:
            shard = tuple(entry for entry in entries if evaluate(entry))
            if len(self._shards) >= self._limit:
                self._shards.pop(next(iter(self._shards)))  # A moved revision never matches again.
            self._shards[key] = shard
            perf_metrics.inc("shard_builds")
            perf_metrics.inc("shard_size_rebuilt", len(shard))
        else:
            self._shards[key] = self._shards.pop(key)  # LRU: hot models must not evict themselves.
            perf_metrics.inc("shard_hits")
        if mode == "shadow":
            legacy = [entry for entry in entries if evaluate(entry)]
            if legacy != list(shard):
                self.record(model, region, legacy, shard)
            return legacy
        return list(shard)

    def record(self, model, region, legacy, indexed):
        """Retain a bounded, credential-free description of one shadow mismatch."""
        perf_metrics.inc("scheduler_mismatches")
        self.mismatches.append({
            "at": time.time(), "model": model, "region": region,
            "legacy": [entry["id"] for entry in legacy],
            "indexed": [entry["id"] for entry in indexed]})
        del self.mismatches[:-MISMATCH_LIMIT]

    def report(self) -> dict:
        """Describe the active shard set without exposing tokens."""
        # Request threads insert concurrently, so iterate over a stable copy.
        return {"shards": [
                    {"model": key[0], "region": key[1], "size": len(value)}
                    for key, value in list(self._shards.items())],
                "mismatches": list(self.mismatches)}
