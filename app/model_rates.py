"""Gateway glue for effective model rates: sample refresh, manual overrides and probes."""
from __future__ import annotations

import time
import uuid

from fastapi import HTTPException

from . import model_policy, rate_measurement
from .background_jobs import JobBoard

PROBE_WORKERS = 4
# Probe requests use their own conversation per request, all under this prefix.
PROBE_CONVERSATION_PREFIX = "rate-probe-"
REFERENCE_ATTEMPTS = 3
REFRESH_MAX_AGE_S = 300
_manual_cache = (None, {})
# All probes share one job: a model probe and "probe all" never spend credits side by side.
JOB_KEY = "rate-probe"
jobs = JobBoard()


def manual_rates(config):
    """{(profile, upstream model): rate} from rule overrides, cached per policy revision."""
    global _manual_cache
    key = (id(config.get("control_store")), model_policy.revision(config))
    if _manual_cache[0] == key:
        return _manual_cache[1]
    rates = {}
    for source, rule in model_policy.snapshot(config)["models"].items():
        for profile, rate in (rule.get("credits_override") or {}).items():
            rates[(profile, rule.get("upstream_id", source))] = rate
    _manual_cache = (key, rates)
    return rates


def refresh(gateway, *, max_age=None):
    """Re-read billing samples; a change in what is billed republishes the model tables."""
    config = gateway.CONFIG
    book = config.get("rate_book")
    if book is None:
        return
    if max_age is not None and book.refreshed_at is not None and time.time() - book.refreshed_at < max_age:
        return
    since = time.time() - rate_measurement.WINDOW_S
    samples = []
    for name, method in (("audit_store", "credit_samples"), ("control_store", "rate_probes")):
        reader = getattr(config.get(name), method, None)
        if callable(reader):
            try:
                samples.extend(reader(since))
            except Exception as error:
                gateway._log(f"[rates] {name} 计费样本读取失败: {error}")
    if book.refresh(samples):
        gateway.invalidate_model_table()


def _accounts_serving(gateway, model, profile):
    """Enabled, healthy accounts of one product whose own catalog serves the model."""
    config, pool = gateway.CONFIG, gateway.CONFIG.get("cred_pool")
    if pool is None:
        return []
    catalogs = config.get("account_catalogs") or {}
    routed = gateway._upstream_model(model, profile)
    out = []
    with pool._lock:
        for entry in pool.entries():
            account = catalogs.get(entry.get("account_key")) or {}
            if (entry.get("profile") != profile or account.get("profile") != profile
                    or not model_policy.credential_enabled(config, entry) or not pool._healthy(entry)):
                continue
            items = gateway._usable_models(gateway._effective_account_scope(account, "serves", model_id=routed))
            if any(item.get("id") == routed for item in items):
                out.append(entry)
    # Prefer accounts with balance: an empty account would be refused before any charge shows.
    out.sort(key=lambda entry: not pool._has_credit(entry, profile))
    return out


def targets(gateway, model=None):
    """(model, profile) pairs to probe: one model on every product, or every nominally free one."""
    config, pool = gateway.CONFIG, gateway.CONFIG.get("cred_pool")
    catalogs = config.get("account_catalogs") or {}
    pairs = set()
    for entry in pool.entries() if pool is not None else []:
        account = catalogs.get(entry.get("account_key")) or {}
        profile = account.get("profile")
        if profile != entry.get("profile") or not model_policy.credential_enabled(config, entry):
            continue
        # Declared rates come from the raw catalog: the overlay would hide what upstream claims.
        for item in gateway._usable_models(gateway._catalog_account_scope(account, "serves")):
            if model is not None and item["id"] == model:
                pairs.add((model, profile))
            elif model is None and gateway._free_multiplier(item.get("credits")):
                pairs.add((item["id"], profile))
    return sorted(pairs)


def _send(gateway, entry, model, profile):
    """One probe request in a fresh conversation, so neither side hits the prompt cache.

    Every probe lands in the request log like regular traffic, with what it cost; the fixed
    conversation prefix and the ``rate_probe`` protocol tell it apart there.
    """
    cm = entry["cm"]
    with cm._lock:
        headers = cm.get_headers()
    headers.update(gateway._dynamic_request_headers(None))
    headers["X-Conversation-ID"] = PROBE_CONVERSATION_PREFIX + uuid.uuid4().hex
    routed = gateway._upstream_model(model, profile)
    started, clock = time.time(), time.monotonic()
    try:
        sample = rate_measurement.probe_once(gateway.chat_url_for_headers(headers), headers, routed)
    except Exception as error:
        _log_request(gateway, entry, model, routed, profile, headers, started, clock, None, error)
        raise
    _log_request(gateway, entry, model, routed, profile, headers, started, clock, sample, None)
    return sample


def _log_request(gateway, entry, model, routed, profile, headers, started, clock, sample, error):
    """Write one probe into the audit request log; logging must never fail the probe."""
    store = gateway.CONFIG.get("audit_store")
    if not callable(getattr(store, "record_request", None)):
        return
    usage = sample or {}
    status = 200 if sample is not None else getattr(error, "status_code", None)
    record = {
        "id": uuid.uuid4().hex, "started_at": started, "model": model, "public_model": model,
        "upstream_model": routed, "profile": profile, "credential": entry.get("account_key"),
        "protocol": "rate_probe", "streaming": True, "stream_mode": "realtime",
        "outcome": "success" if sample is not None else "error", "status_code": status,
        "error_code": None if sample is not None else getattr(error, "code", None) or "probe_failed",
        "duration_ms": (time.monotonic() - clock) * 1000,
        "attempts": [{"stage": "upstream_attempt", "upstream_model": routed, "profile": profile,
                      "credential": entry.get("account_key"), "conversation_id": headers["X-Conversation-ID"],
                      "upstream_request_id": headers.get("X-Request-ID"), "attempt_index": 1}],
    }
    if sample is not None:
        record.update(credit=usage["credit"], input_tokens=usage["input_tokens"],
                      cache_read_tokens=usage["cache_read_tokens"], output_tokens=usage["output_tokens"],
                      total_tokens=usage["input_tokens"] + usage["output_tokens"], usage_source="upstream_hook",
                      usage_sources={key: "upstream_hook" for key in
                                     ("credit", "input_tokens", "cache_read_tokens", "output_tokens")})
    try:
        store.record_request(record)
    except Exception as error:
        gateway._log(f"[rates] 探测请求日志写入失败: {error}")


def probe(gateway, model, profile, progress=lambda _step: None):
    """Probe one model; when charged, calibrate its rate against a declared paid model."""
    result = {"model": model, "profile": profile, "ok": False, "billed": None, "credit": None,
              "rate": None, "reference": None, "message": ""}
    entries = _accounts_serving(gateway, model, profile)
    if not entries:
        result["message"] = "该产品没有可用于探测的健康账号"
        return result
    entry = entries[0]
    progress("目标模型")
    try:
        sample = _send(gateway, entry, model, profile)
    except Exception as error:
        result["message"] = f"探测失败：{error}"
        return result
    billed = sample["credit"] > 0
    result.update(ok=True, billed=billed, credit=sample["credit"], input_tokens=sample["input_tokens"])
    rate, note = None, ""
    if billed:
        # Declared rates come from the raw catalog of the same account the target used.
        account = (gateway.CONFIG.get("account_catalogs") or {}).get(entry.get("account_key")) or {}
        items = gateway._usable_models(gateway._catalog_account_scope(account, "serves"))
        candidates = rate_measurement.reference_candidates(items, gateway._multiplier_value, model)
        note = "；该产品没有已声明倍率的参考模型，倍率待估"
        failures = []
        for reference, reference_rate in candidates[:REFERENCE_ATTEMPTS]:
            progress(f"对照 {reference}（{reference_rate}x）")
            try:
                baseline = _send(gateway, entry, reference, profile)
            except Exception as error:
                failures.append(f"{reference}: {error}")   # A refused model is not charged; try the next.
                continue
            rate = rate_measurement.calibrated_rate(sample, baseline, reference_rate)
            result["reference"] = {"model": reference, "rate": reference_rate, "credit": baseline["credit"]}
            note = (f"，对照 {reference}（{reference_rate}x，扣 {baseline['credit']}）估算 ≈{rate}x"
                    if rate is not None else f"；参考模型 {reference} 未扣费，倍率待估")
            break
        else:
            if failures:
                note = f"；参考模型均不可用（{'；'.join(failures)}），倍率待估"
    control = gateway.CONFIG.get("control_store")
    if control is not None:
        control.record_rate_probe(profile, model, sample, rate=rate)
    result.update(rate=rate, message=f"已扣费 {sample['credit']} 积分{note}" if billed else "未扣费：确认为 0 倍率")
    return result


def job_view(gateway):
    """The shared probe job with billed / free / failed counts for the banner."""
    view = jobs.view(JOB_KEY)
    if view is None:
        return {"status": "idle", "scope": None, "total": 0, "completed": 0, "billed": 0, "free": 0,
                "failed": 0, "current": [], "results": [], "started_at": None, "finished_at": None}
    results = view["results"]
    return {**view, "failed": sum(not row["ok"] for row in results),
            "billed": sum(row["ok"] and row.get("billed") is True for row in results),
            "free": sum(row["ok"] and row.get("billed") is False for row in results)}


def start_probe(gateway, model=None, scope=None):
    """Probe one model on every product that serves it, or every nominally free model.

    ``scope`` names what the job is for (the rule a drawer asked about, or "all").
    """
    pairs = targets(gateway, model)
    if model is not None and not pairs:
        raise HTTPException(404, "没有账号目录提供该模型")
    jobs.start(JOB_KEY, pairs, lambda pair, progress: probe(gateway, *pair, progress=progress),
               workers=PROBE_WORKERS, meta={"scope": scope or model or "all"},
               label=lambda pair: {"model": pair[0], "profile": pair[1]},
               on_done=lambda _job: refresh(gateway))
    return job_view(gateway)


def details(gateway, model, profiles):
    """Per-product rate provenance for the management view of one upstream model."""
    book = gateway.CONFIG.get("rate_book")
    manual = manual_rates(gateway.CONFIG)
    out = {}
    for profile in profiles:
        row = {"manual": manual.get((profile, model))}
        measured = book.measurement(profile, model) if book is not None else None
        if measured:
            row["measured"] = measured
        out[profile] = row
    return out
