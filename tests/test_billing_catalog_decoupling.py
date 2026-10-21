#!/usr/bin/env python3
"""Verify that billing failures do not block account catalog synchronization."""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter
from app.credits import AuthExpiredError, CreditLedger, ModelCatalogCache
from app.catalog_probe import AggregateCatalog
from app.gateway_management import Management


class BillingCatalogDecouplingTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.dict(os.environ, {"CODEBUDDY_AUTH_DIR": str(self.root)}))
        self.enterContext(patch.object(converter, "_sync_usage", Mock()))
        self.enterContext(patch.object(converter.model_policy, "credential_auto_checkin", return_value=False))
        self.enterContext(patch.object(converter.model_policy, "credential_auto_travel", return_value=False))
        self.cache = ModelCatalogCache(self.root / "models.json")
        self.models = [{"id": "paid-model", "supportsToolCall": True, "credits": "x1 credits"}]

    def build(self, domain):
        uid = "intl-user" if domain.endswith(".ai") else "cn-user"
        value = {"account": {"uid": uid}, "auth": {
            "accessToken": "token-" + uid,
            "domain": domain,
            "expiresAt": (time.time() + 3600) * 1000,
        }}
        path = self.root / (uid + ".info")
        path.write_text(json.dumps(value), encoding="utf-8")
        pool = converter.CredentialPool([path])
        ledger = CreditLedger(self.root / (uid + "-ledger.json"))
        pool.set_ledger(ledger)
        entry = pool.entries()[0]
        ledger.bind_identity(entry["id"], entry["account_key"])
        self.enterContext(patch.dict(converter.CONFIG, {
            "cred_pool": pool,
            "ledger": ledger,
            "model_cache": self.cache,
            "aggregate_catalog": None,
            "catalog_probe_mode": "account",
            "control_store": None,
            "usage_snapshots": None,
            "housekeep_concurrency": 2,
            "log_path": None,
            "account_catalogs": None,
            "model_catalogs": {},
            "catalog_index": None,
            "model_guard": True,
        }))
        converter.invalidate_model_table()
        return pool, ledger, entry

    def run_cycle(self, pool, ledger):
        live = pool.entry_by_id(pool.entries()[0]["id"])
        live["synced_at"] = 0.0
        converter._housekeep_once(pool, ledger)
        converter.invalidate_model_table()

    def catalog_fetch(self):
        return {"picker": self.models, "account": self.models}

    def test_intl_billing_failure_still_fetches_catalog_and_retries(self):
        pool, ledger, entry = self.build("www.codebuddy.ai")
        with patch.object(converter.credits_mod, "fetch_credits",
                          side_effect=RuntimeError("积分查询失败: 积分接口返回缺少 Accounts 结构")), \
             patch.object(converter.credits_mod, "fetch_model_scopes",
                          return_value=self.catalog_fetch()) as catalog:
            self.run_cycle(pool, ledger)
        key = converter.catalog_cache_key(entry["profile"], entry["account_key"])
        self.assertEqual(catalog.call_count, 1)
        self.assertTrue(self.cache.fresh(key))
        self.assertTrue(ledger.entry(entry["id"])["error"].startswith("credits:"))
        self.assertIn(entry["id"], pool._sync_retry)
        self.assertTrue(Management(converter).admin_credential_inventory()[0]["catalog_ready"])

    def test_domestic_billing_failure_keeps_account_eligible_without_balance(self):
        pool, ledger, entry = self.build("www.codebuddy.cn")
        with patch.object(converter.credits_mod, "fetch_credits", side_effect=RuntimeError("billing down")), \
             patch.object(converter.credits_mod, "fetch_model_scopes", return_value=self.catalog_fetch()):
            self.run_cycle(pool, ledger)
        self.assertTrue(pool._eligible(entry, "paid-model"))

    def test_intl_billing_failure_does_not_remove_paid_balance_gate(self):
        pool, ledger, entry = self.build("www.codebuddy.ai")
        with patch.object(converter.credits_mod, "fetch_credits", side_effect=RuntimeError("billing down")), \
             patch.object(converter.credits_mod, "fetch_model_scopes", return_value=self.catalog_fetch()):
            self.run_cycle(pool, ledger)
        self.assertFalse(pool._eligible(entry, "paid-model"))

    def test_auth_expired_does_not_fetch_catalog(self):
        pool, ledger, entry = self.build("www.codebuddy.ai")
        with patch.object(converter.credits_mod, "fetch_credits", side_effect=AuthExpiredError("expired")), \
             patch.object(converter.credits_mod, "fetch_model_scopes", return_value=self.catalog_fetch()) as catalog:
            self.run_cycle(pool, ledger)
        self.assertEqual(catalog.call_count, 0)
        self.assertNotIn(entry["id"], converter.CONFIG["account_catalogs"])

    def test_site_mismatch_preserves_balance_but_fetches_catalog(self):
        pool, ledger, entry = self.build("www.codebuddy.ai")
        ledger.update_credits(entry["id"], {"credits": 9, "intl": True, "segments": []})
        with patch.object(converter.credits_mod, "fetch_credits",
                          return_value={"credits": 1, "intl": False, "segments": []}), \
             patch.object(converter.credits_mod, "fetch_model_scopes", return_value=self.catalog_fetch()) as catalog:
            self.run_cycle(pool, ledger)
        self.assertEqual(ledger.entry(entry["id"])["credits"]["credits"], 9)
        self.assertEqual(catalog.call_count, 1)
        self.assertTrue(ledger.entry(entry["id"])["error"].startswith("credits:"))

    def test_successful_retry_updates_balance_without_refetching_fresh_catalog(self):
        pool, ledger, entry = self.build("www.codebuddy.ai")
        cid = entry["id"]
        with patch.object(converter.credits_mod, "fetch_credits", side_effect=[
            RuntimeError("billing down"), {"credits": 7, "intl": True, "segments": []}
        ]) as credits, patch.object(converter.credits_mod, "fetch_model_scopes",
                                    return_value=self.catalog_fetch()) as catalog:
            self.run_cycle(pool, ledger)
            converter._housekeep_once(pool, ledger, pending_only=True)  # 退避未到期，不得重查积分
            self.assertEqual(credits.call_count, 1)
            pool._sync_retry[cid] = time.monotonic() - 1  # 让退避立即到期
            converter._housekeep_once(pool, ledger, pending_only=True)
        self.assertEqual(credits.call_count, 2)
        self.assertEqual(catalog.call_count, 1)
        self.assertEqual(ledger.entry(cid)["credits"]["credits"], 7)
        self.assertNotIn(cid, pool._sync_retry)
        self.assertFalse(pool.sync_pending())
        self.assertIsNone(ledger.entry(cid)["error"])

    def test_representative_mode_still_fetches_catalog_after_billing_failure(self):
        pool, ledger, entry = self.build("www.codebuddy.ai")
        converter.CONFIG["aggregate_catalog"] = AggregateCatalog(ttl=3600)
        converter.CONFIG["catalog_probe_mode"] = "representative"
        with patch.object(converter.credits_mod, "fetch_credits", side_effect=RuntimeError("billing down")), \
             patch.object(converter.credits_mod, "fetch_model_scopes", return_value=self.catalog_fetch()) as catalog:
            self.run_cycle(pool, ledger)
        self.assertEqual(catalog.call_count, 1)
        key = converter.catalog_cache_key(entry["profile"], entry["account_key"])
        self.assertTrue(self.cache.fresh(key))


if __name__ == "__main__":
    unittest.main(verbosity=2)
