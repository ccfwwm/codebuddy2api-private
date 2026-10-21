"""One policy revision per routing decision, indexed catalogs and a revision-keyed model table."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import json
import os
import tempfile
import time
import unittest
from unittest.mock import patch

import converter
from app import model_policy, perf_metrics
from app.control_store import ControlStore
from app.credits import CreditLedger

MODELS = [{"id": "glm-5.3-flash", "supportsToolCall": True, "credits": "x0 credits"},
          {"id": "deepseek-v4-flash", "supportsToolCall": True, "credits": "x1 credits"}]


class RoutingSnapshotTests(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.dict(os.environ, {"CODEBUDDY_AUTH_DIR": temporary}))
        self.enterContext(patch.object(perf_metrics, "_COUNTERS", {}))
        self.enterContext(patch.object(perf_metrics, "_TIMINGS", {}))
        self.root = Path(temporary)
        self.store = ControlStore(self.root / "control.sqlite3")
        self.addCleanup(self.store.close)
        self.path = self.write_credential("account.info", "synthetic")
        self.pool = converter.CredentialPool([self.path])
        self.ledger = CreditLedger(self.root / "ledger.json")
        self.pool.set_ledger(self.ledger)
        entry = self.pool.entries()[0]
        self.identity = entry["account_key"]
        self.ledger.bind_identity(entry["id"], self.identity)
        self.ledger.update_credits(entry["id"], {"credits": 100, "intl": False, "segments": []})
        self.accounts = {self.identity: {"profile": "cn-cli",
                                         "models": [dict(item) for item in MODELS],
                                         "serves": [dict(item) for item in MODELS]}}
        converter.invalidate_model_table()
        converter._configured_cache.clear()
        self.enterContext(patch.dict(converter.CONFIG, {
            "cred_pool": self.pool, "ledger": self.ledger, "control_store": self.store,
            "account_catalogs": self.accounts, "catalog_index": converter._publish_catalog_index(self.accounts),
            "model_catalogs": {}, "model_cache": None, "model_guard": True, "log_path": None,
            "max_inflight_per_account": 0}))

    def write_credential(self, name, uid):
        path = self.root / name
        path.write_text(json.dumps({"account": {"uid": uid}, "auth": {
            "accessToken": "synthetic-token", "domain": "www.codebuddy.cn",
            "expiresAt": (time.time() + 3600) * 1000}}), encoding="utf-8")
        return path

    def test_one_policy_snapshot_per_decision(self):
        self.assertIsNotNone(self.pool.headers_for(None, "glm-5.3-flash"))
        self.assertEqual(perf_metrics.snapshot()["counters"]["policy_snapshot_calls"], 1)
        self.assertIsNotNone(self.pool.pick("session", "glm-5.3-flash"))
        self.assertEqual(perf_metrics.snapshot()["counters"]["policy_snapshot_calls"], 2)

    def test_policy_view_reuses_one_revision_and_sees_new_publishes(self):
        policy = model_policy.view(converter.CONFIG)
        entry = self.pool.entries()[0]
        self.assertEqual(policy.revision, self.store.revision)
        self.assertTrue(model_policy.credential_enabled(converter.CONFIG, entry, policy))
        self.store.set_credential(self.identity, False)
        self.assertTrue(model_policy.credential_enabled(converter.CONFIG, entry, policy))  # Old revision kept.
        self.assertFalse(model_policy.view(converter.CONFIG).credential(entry)["enabled"])
        self.assertIsNone(self.pool.pick("session", "glm-5.3-flash"))

    def test_revision_reads_do_not_copy_the_snapshot(self):
        self.assertEqual(model_policy.revision(converter.CONFIG), self.store.revision)
        self.assertEqual(perf_metrics.snapshot()["counters"].get("policy_snapshot_calls", 0), 0)
        self.assertEqual(self.store.revision, self.store.snapshot()["revision"])

    def test_model_table_is_reused_until_a_revision_moves(self):
        first = converter.current_models()
        self.assertEqual(first[:2], ["glm-5.3-flash", "deepseek-v4-flash"])
        self.assertEqual(converter.current_models(), first)
        counters = perf_metrics.snapshot()["counters"]
        self.assertEqual(counters["model_table_builds"], 1)
        self.assertEqual(counters["model_table_hits"], 1)
        entry = self.pool.entries()[0]
        self.ledger.update_credits(entry["id"], {"credits": 0, "intl": False, "segments": []})
        self.assertEqual(converter.current_models()[:1], ["glm-5.3-flash"])  # Zero balance keeps free models only.
        self.assertEqual(perf_metrics.snapshot()["counters"]["model_table_builds"], 2)

    def test_catalog_republish_rebuilds_the_model_table(self):
        converter.current_models()
        accounts = {self.identity: {"profile": "cn-cli", "models": [dict(MODELS[1])],
                                    "serves": [dict(MODELS[1])]}}
        converter.CONFIG["account_catalogs"] = accounts
        converter.CONFIG["catalog_index"] = converter._publish_catalog_index(accounts)
        self.assertEqual(converter.current_models()[:1], ["deepseek-v4-flash"])

    def test_configured_profiles_are_cached_between_decisions(self):
        converter._configured_profiles(None)
        with patch.object(self.pool, "entries", wraps=self.pool.entries) as entries:
            self.assertEqual(set(converter._configured_profiles(None)), {"cn-cli"})
            self.assertEqual(entries.call_count, 0)
        self.store.set_credential(self.identity, False)
        self.assertEqual(set(converter._configured_profiles(None)), set())


if __name__ == "__main__":
    unittest.main(verbosity=2)
