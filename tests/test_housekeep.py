"""Bounded background maintenance: worker limits, endpoint semaphores and backoff jitter."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import json
import os
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

import converter
from app import perf_metrics
from app.credits import CreditLedger, ModelCatalogCache


def model(*names):
    return [{"id": name, "supportsToolCall": True, "credits": "x1 credits"} for name in names]


class HousekeepConcurrencyTests(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.dict(os.environ, {"CODEBUDDY_AUTH_DIR": temporary}))
        self.enterContext(patch.object(perf_metrics, "_COUNTERS", {}))
        self.root = Path(temporary)
        self.enterContext(patch.object(converter, "_sync_usage", Mock()))
        self.enterContext(patch.object(converter, "_sync_model_catalogs", Mock()))

    def build(self, count):
        paths = []
        for index in range(count):
            path = self.root / f"account-{index}.info"
            path.write_text(json.dumps({"account": {"uid": f"maintain-{index}"}, "auth": {
                "accessToken": f"token-{index}", "domain": "www.codebuddy.cn",
                "expiresAt": (time.time() + 3600) * 1000}}), encoding="utf-8")
            paths.append(path)
        pool = converter.CredentialPool(paths)
        ledger = CreditLedger(self.root / "ledger.json")
        pool.set_ledger(ledger)
        for entry in pool.entries():
            ledger.bind_identity(entry["id"], entry["account_key"])
            ledger.update_credits(entry["id"], {"credits": 100, "intl": False, "segments": []})
        self.enterContext(patch.dict(converter.CONFIG, {
            "cred_pool": pool, "ledger": ledger, "model_cache": None, "aggregate_catalog": None,
            "account_catalogs": {}, "model_catalogs": {}, "model_guard": True, "log_path": None,
            "control_store": None, "usage_snapshots": None, "housekeep_concurrency": 4}))
        return pool, ledger

    def sync_with_delay(self, delay):
        def sync(*_args, **_kwargs):
            time.sleep(delay)
            return None
        return sync

    def test_bounded_workers_shorten_a_fixed_rtt_cycle(self):
        pool, ledger = self.build(8)
        observed = {}
        for limit in (1, 4):
            for entry in pool._entries:
                entry["synced_at"] = 0.0
            with patch.dict(converter.CONFIG, {"housekeep_concurrency": limit}), \
                    patch.object(converter, "_sync_credits", side_effect=self.sync_with_delay(0.05)) as sync:
                started = time.monotonic()
                converter._housekeep_once(pool, ledger)
                observed[limit] = time.monotonic() - started
                self.assertEqual(sync.call_count, 8)
        self.assertGreaterEqual(observed[1], 0.35)  # Serial: eight sequential 50 ms calls.
        self.assertLess(observed[4], observed[1] * 0.6)

    def test_endpoint_semaphores_are_independent_per_limit(self):
        with patch.dict(converter.CONFIG, {"housekeep_concurrency": 2}):
            models = converter._endpoint_semaphore("models")
            credits = converter._endpoint_semaphore("credits")
            usage = converter._endpoint_semaphore("usage")
            self.assertIs(models, converter._endpoint_semaphore("models"))  # Reused within a limit.
        self.assertIsNot(models, credits)
        self.assertIsNot(models, usage)
        with patch.dict(converter.CONFIG, {"housekeep_concurrency": 1}):
            self.assertIsNot(models, converter._endpoint_semaphore("models"))  # Rebuilt on a new limit.

    def test_full_cycle_skips_accounts_synced_recently(self):
        pool, ledger = self.build(3)
        with patch.object(converter, "_sync_credits", return_value=None) as sync:
            converter._housekeep_once(pool, ledger)
            self.assertEqual(sync.call_count, 3)
            sync.reset_mock()
            converter._housekeep_once(pool, ledger)
            self.assertEqual(sync.call_count, 0)  # Recently synced accounts are not repeated.
            for entry in pool._entries:
                entry["synced_at"] = 0.0
            converter._housekeep_once(pool, ledger)
            self.assertEqual(sync.call_count, 3)

    def test_failed_accounts_back_off_with_jitter(self):
        pool, _ = self.build(2)
        ids = {entry["id"] for entry in pool.entries()}
        pool.begin_sync(all_entries=True)
        before = time.monotonic()
        pool.end_sync(ids, failed=ids)
        first = dict(pool._sync_retry)
        pool.end_sync(ids, failed=ids)
        second = dict(pool._sync_retry)
        for cid in ids:
            self.assertGreaterEqual(first[cid] - before, 60)
            self.assertGreater(second[cid] - first[cid], 40)  # Exponential growth.
            self.assertLess(first[cid] - before, 60 * 1.25 + 1)  # Bounded jitter only.

    def test_manual_scan_runs_on_bounded_workers(self):
        pool, _ = self.build(6)
        cache = ModelCatalogCache(self.root / "catalog.json", ttl=60)
        self.enterContext(patch.dict(converter.CONFIG, {
            "model_cache": cache, "housekeep_concurrency": 3,
            "aggregate_catalog": converter.AggregateCatalog(ttl=3600)}))

        spans, lock = [], threading.Lock()

        def slow_fetch(_token, **_kwargs):
            started = time.monotonic()
            time.sleep(0.05)
            with lock:
                spans.append((started, time.monotonic()))
            return {"picker": model("hy3"), "account": model("hy3")}
        with patch.object(converter.credits_mod, "fetch_model_scopes", side_effect=slow_fetch):
            converter.start_catalog_scan()
            for _ in range(300):
                view = converter.catalog_scan_view()
                if view["status"] != "running":
                    break
                time.sleep(0.01)
        self.assertEqual(view["status"], "completed")
        self.assertEqual(view["completed"], 6)
        # Overlapping fetch windows prove bounded concurrency; a serial regression keeps
        # every span disjoint, so the check never depends on runner wall-clock jitter.
        spans.sort()
        self.assertTrue(any(spans[i][1] > spans[j][0]
                            for i in range(len(spans)) for j in range(i + 1, len(spans))))

if __name__ == "__main__":
    unittest.main(verbosity=2)
