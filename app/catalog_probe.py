"""Representative per-profile catalog probes with rotation, backoff and diff status."""
from __future__ import annotations

import math
import random
import threading
import time

SCHEMA_VERSION = 1
PROFILES = ("cn-cli", "cn-work", "intl-cli", "intl-work")
MAX_PROFILES = 8
MAX_MODEL_IDS = 2000
RETRY_BASE_S = 60
RETRY_MAX_S = 1800
_MAX_FAILURES = 16
_FIELDS = {"source", "source_generation", "fetched_at", "retry_at", "failures", "status", "models"}


def _time(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def _token(value):
    return isinstance(value, str) and 0 < len(value) <= 160 and value.isprintable() and not any(c.isspace() for c in value)


def valid_row(row):
    """Validate one persisted profile probe row without ever touching credential material."""
    if not isinstance(row, dict) or set(row) - _FIELDS:
        return False
    if "source" in row and row["source"] is not None and not _token(row["source"]):
        return False
    if not _time(row.get("fetched_at")) or not _time(row.get("retry_at")):
        return False
    failures = row.get("failures", 0)
    if type(failures) is not int or not 0 <= failures <= _MAX_FAILURES:
        return False
    if row.get("status") not in ("ok", "error", "fresh"):
        return False
    if "source_generation" in row and type(row["source_generation"]) is not int:
        return False
    models = row.get("models", [])
    return (isinstance(models, list) and len(models) <= MAX_MODEL_IDS
            and all(isinstance(model, str) and 0 < len(model) <= 160 for model in models))


class AggregateCatalog:
    """One representative source per product profile, with rotation and retry backoff."""

    def __init__(self, *, ttl=6 * 3600, store=None, clock=time.time):
        self.ttl = max(60.0, float(ttl or 0))
        self._store = store
        self._clock = clock
        self._lock = threading.Lock()
        self._data = self._load()

    def _load(self):
        raw = self._store.get("catalog_probe") if self._store is not None else None
        if (not isinstance(raw, dict) or raw.get("version") != SCHEMA_VERSION
                or not isinstance(raw.get("profiles"), dict)):
            return {"version": SCHEMA_VERSION, "profiles": {}}
        profiles = {name: dict(row) for name, row in raw["profiles"].items()
                    if name in PROFILES and valid_row(row)}
        return {"version": SCHEMA_VERSION, "profiles": profiles}

    def _save(self):
        if self._store is not None:
            self._store.put_cache("catalog_probe", {"version": SCHEMA_VERSION, "profiles": self._data["profiles"]})

    def row(self, profile):
        """Return a copy of one profile row."""
        with self._lock:
            return dict(self._data["profiles"].get(profile) or {})

    def profiles(self):
        """Return a copy of every profile row for the management view."""
        with self._lock:
            return {name: dict(row) for name, row in self._data["profiles"].items()}

    def due(self, profile, now=None):
        """Whether this profile may probe again; a retry backoff keeps failures quiet."""
        now = self._clock() if now is None else now
        row = self.row(profile)
        return not row or now >= float(row.get("retry_at") or 0.0)

    @staticmethod
    def _age(candidate, age_of):
        """Treat an unknown catalog age as infinitely stale so a new account is probed."""
        value = age_of(candidate)
        return math.inf if value is None else float(value)

    def choose(self, profile, candidates, *, age_of, now=None):
        """Select the account to probe: unknown catalogs first, then the source, else the stalest."""
        now = self._clock() if now is None else now
        due = [candidate for candidate in candidates if self._age(candidate, age_of) >= self.ttl]
        if not due:
            return None
        # An account without any catalog cannot be routed at all, so it outranks reuse.
        unknown = [candidate for candidate in due if self._age(candidate, age_of) == math.inf]
        if unknown:
            return unknown[0]
        source = self.row(profile).get("source")
        for candidate in due:
            if candidate["account_key"] == source:
                return candidate
        # Oldest catalogs first, so rotation eventually covers every account.
        return max(due, key=lambda candidate: self._age(candidate, age_of))

    def success(self, profile, *, source, generation, models, now=None):
        """Record one probe result and schedule the next TTL check."""
        now = self._clock() if now is None else now
        with self._lock:
            self._data["profiles"][profile] = {
                "source": source, "source_generation": int(generation or 0),
                "fetched_at": now, "retry_at": now + self.ttl, "failures": 0, "status": "ok",
                "models": sorted({str(model)[:160] for model in models if model})[:MAX_MODEL_IDS]}
            self._save()

    def fresh(self, profile, now=None):
        """Record that the representative catalog is still inside its TTL."""
        now = self._clock() if now is None else now
        with self._lock:
            row = dict(self._data["profiles"].get(profile) or {})
            if not row:
                return
            row.update(status="fresh", fetched_at=now, retry_at=now + self.ttl, failures=0)
            self._data["profiles"][profile] = row
            self._save()

    def failure(self, profile, *, source=None, now=None):
        """Back off an unusable probe and keep the previous aggregate for the next attempt."""
        now = self._clock() if now is None else now
        with self._lock:
            row = dict(self._data["profiles"].get(profile) or {})
            failures = min(int(row.get("failures") or 0) + 1, _MAX_FAILURES)
            delay = min(RETRY_BASE_S * 2 ** (failures - 1), RETRY_MAX_S)
            row.update(source=source if source is not None else row.get("source"),
                       failures=failures, status="error",
                       # Jitter keeps several failing profiles from retrying in lockstep.
                       retry_at=now + delay * random.uniform(1.0, 1.25))
            row.setdefault("fetched_at", 0.0)
            row.setdefault("models", [])
            self._data["profiles"][profile] = row
            self._save()

    def model_ids(self, profile):
        """Return the model identifiers the last successful probe advertised."""
        return set(self.row(profile).get("models") or ())

    def view(self, now=None):
        """Describe probe state for the management API without exposing credentials."""
        now = self._clock() if now is None else now
        rows = {}
        for profile, row in self.profiles().items():
            rows[profile] = {
                "source": row.get("source"), "status": row.get("status", "unknown"),
                "models": len(row.get("models") or []), "failures": row.get("failures", 0),
                "fetched_at": row.get("fetched_at"),
                "next_probe_in": max(0, round(float(row.get("retry_at") or 0.0) - now))}
        return {"ttl_seconds": self.ttl, "profiles": rows}
