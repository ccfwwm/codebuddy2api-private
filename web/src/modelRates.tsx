import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, object, type ModelRule, type RecordValue } from "./api";
import { profileLabel } from "./components";
import { jobResponse, useJobPolling, type Job } from "./jobs";
import { formatTokens } from "./modelMetadata";
import s from "./ui.module.scss";

export type Measured = {
  billed: boolean;
  rate: number | null;
  samples: number;
  charged: number;
  avg_credit: number | null;
  last_charged_at: number | null;
  rated_at: number | null;
};
export type RateDetail = { manual: number | null; declared?: number | null; measured?: Measured };
export type RateSource = "manual" | "measured" | "declared";

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Per-product rate provenance from the management inventory. */
export function rateDetails(model: Pick<ModelRule, "rate_details">): Record<string, RateDetail> {
  const raw = model.rate_details;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, RateDetail> = {};
  for (const [profile, value] of Object.entries(raw as RecordValue)) {
    const row = value && typeof value === "object" ? (value as RecordValue) : {};
    const detail: RateDetail = { manual: finite(row.manual) };
    if ("declared" in row) detail.declared = finite(row.declared);
    const measured =
      row.measured && typeof row.measured === "object" ? (row.measured as RecordValue) : null;
    if (measured)
      detail.measured = {
        billed: measured.billed === true,
        rate: finite(measured.rate),
        samples: finite(measured.samples) ?? 0,
        charged: finite(measured.charged) ?? 0,
        avg_credit: finite(measured.avg_credit),
        last_charged_at: finite(measured.last_charged_at),
        rated_at: finite(measured.rated_at),
      };
    out[profile] = detail;
  }
  return out;
}

/** A declared value is only reported where the gateway replaced it, i.e. measured billing. */
export function rateSource(detail: RateDetail | undefined): RateSource {
  if (detail?.manual != null) return "manual";
  return detail && "declared" in detail ? "measured" : "declared";
}

/** Two significant digits: small estimates such as 0.037x must not round to 0.04x. */
export function formatEstimate(value: number): string {
  return `${value >= 1 ? Math.round(value * 100) / 100 : Number(value.toPrecision(2))}x`;
}

export function measuredNote(detail: RateDetail): string {
  const m = detail.measured;
  if (!m) return "";
  const average = m.avg_credit != null ? `，平均 ≈${m.avg_credit} 积分/次` : "";
  return (
    `上游目录声明 ${detail.declared ?? 0}x，但对该模型实际扣费（近 7 天 ${m.charged}/${m.samples} 次计费${average}）；` +
    (m.rate != null
      ? "倍率来自探测：同一请求对照本产品已声明倍率的参考模型折算"
      : "日常流量多命中会话缓存，单次扣费不能折算倍率；点「一键探测倍率」测出")
  );
}

export type OutputProbe = {
  claimed: number | null;
  measured: number | null;
  verdict: "clamped" | "at_least" | "inconclusive";
  note: string;
  tested_at: string;
};

/** Measured output limits written by scripts/probe_max_tokens.py; empty when never probed. */
export function useOutputProbes(): Record<string, OutputProbe> {
  const [probes, setProbes] = useState<Record<string, OutputProbe>>({});
  useEffect(() => {
    void api
      .get("/models/output-probes")
      .then((response) => {
        const raw = object(response.data).probes;
        setProbes(raw && typeof raw === "object" ? (raw as Record<string, OutputProbe>) : {});
      })
      .catch(() => {
        // 实测标注只是叠加信息，读取失败时最大输出列退回声称值。
      });
  }, []);
  return probes;
}

export function OutputProbeNote({ probe }: { probe: OutputProbe | undefined }) {
  if (!probe) return null;
  const tip = [
    `声称 ${probe.claimed ? formatTokens(probe.claimed) : "?"}`,
    `实测 ${probe.measured ? formatTokens(probe.measured) : "?"}`,
    probe.note,
    probe.tested_at && `探测于 ${probe.tested_at}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const { claimed, measured } = probe;
  if (measured && claimed && probe.verdict === "clamped" && measured < claimed) {
    const times = claimed / measured;
    return (
      <span className={s.probeNote} title={tip}>
        <strong className={s.probeClamped}>{formatTokens(measured)} ⚠</strong>
        <small>钳制 {times >= 10 ? Math.round(times) : Math.round(times * 10) / 10}×</small>
      </span>
    );
  }
  if (measured && claimed && probe.verdict !== "inconclusive" && measured >= claimed * 0.98)
    return (
      <span className={s.probeNote} title={tip}>
        <strong className={s.probeOk}>
          {formatTokens(measured)} {measured > claimed * 1.02 ? "↑" : "✓"}
        </strong>
      </span>
    );
  if (measured && probe.verdict !== "inconclusive")
    return (
      <span className={s.probeNote} title={tip}>
        <strong className={s.probeMuted}>
          {probe.verdict === "at_least" ? "≥" : ""}
          {formatTokens(measured)}
        </strong>
      </span>
    );
  return (
    <span className={s.probeNote} title={tip}>
      <strong className={s.probeMuted}>?</strong>
      <small>未测出</small>
    </span>
  );
}

type ProbeResult = {
  profile: string;
  ok: boolean;
  billed: boolean | null;
  rate: number | null;
  message: string;
};
function probeResults(rows: RecordValue[], upstream: string): ProbeResult[] {
  return rows
    .filter((row) => row.model === upstream)
    .map((row) => ({
      profile: typeof row.profile === "string" ? row.profile : "",
      ok: row.ok === true,
      billed: typeof row.billed === "boolean" ? row.billed : null,
      rate: finite(row.rate),
      message: typeof row.message === "string" ? row.message : "",
    }));
}

/** The shared probe job; one runs at a time for "probe all" and single-model probes alike. */
export type RateProbeControl = {
  job: Job | null;
  error: string | null;
  start: (modelId?: string) => void;
};

/** Manual per-product rates and a one-request probe for one catalog model. */
export function RateOverrideFields({
  model,
  value,
  onChange,
  probe,
  disabled,
}: {
  model: ModelRule;
  value: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
  probe?: RateProbeControl;
  disabled: boolean;
}) {
  const details = rateDetails(model);
  const prices =
    model.credits_by_profile && typeof model.credits_by_profile === "object"
      ? (model.credits_by_profile as RecordValue)
      : {};
  const served = [...new Set([...Object.keys(details), ...Object.keys(prices)])].sort();
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(value).map(([profile, rate]) => [profile, String(rate)])),
  );
  const job = probe?.job ?? null;
  const running = job?.status === "running";
  // Results for this model, whichever job produced them; they survive closing the drawer.
  const results = job ? probeResults(job.results, model.upstream_id ?? model.id) : [];
  const edit = (profile: string, text: string) => {
    setDrafts((old) => ({ ...old, [profile]: text }));
    const next = { ...value };
    const rate = Number(text);
    if (text.trim() === "" || !Number.isFinite(rate) || rate < 0) delete next[profile];
    else next[profile] = rate;
    onChange(next);
  };
  return (
    <fieldset className={s.fieldset}>
      <legend>消费倍率</legend>
      <p>留空按上游目录或实测计费；手填后路由与 /v1/models 均以手填值为准。0 表示确认免费。</p>
      {!served.length && <p>当前没有账号目录提供该模型。</p>}
      <div className={s.formGrid}>
        {served.map((profile) => {
          const detail = details[profile];
          const source = rateSource(detail);
          const effective = finite(prices[profile]);
          const hint =
            source === "measured"
              ? `实测计费 ${detail?.measured?.rate != null ? formatEstimate(detail.measured.rate) : "倍率待估"}（目录 ${detail?.declared ?? 0}x）`
              : effective != null
                ? `目录 ${formatEstimate(source === "manual" ? (detail?.declared ?? effective) : effective)}`
                : "目录倍率未知";
          return (
            <label className={s.field} key={profile}>
              {profileLabel(profile)}
              <input
                type="number"
                min={0}
                max={1000}
                step="any"
                inputMode="decimal"
                aria-label={`手填倍率 ${profileLabel(profile)}`}
                placeholder="自动"
                value={drafts[profile] ?? ""}
                disabled={disabled}
                onChange={(e) => edit(profile, e.target.value)}
              />
              <small>{hint}</small>
            </label>
          );
        })}
      </div>
      {probe && (
        <div className={s.actions}>
          <button
            type="button"
            disabled={disabled || running || !served.length}
            title="后台任务：每个产品发起一次 ≈8K token 对话；有扣费即为实测计费，未扣费才是真 0 倍率。关闭抽屉不影响执行"
            onClick={() => probe.start(model.id)}
          >
            {running
              ? job?.meta.scope === model.id
                ? "探测中…"
                : "其他探测进行中…"
              : "一键探测倍率"}
          </button>
        </div>
      )}
      {probe?.error && <p className={s.warning}>{probe.error}</p>}
      {results.map((row) => (
        <div className={s.actions} key={row.profile}>
          <small>
            {profileLabel(row.profile)}：{row.message}
          </small>
          {row.rate != null && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => edit(row.profile, String(row.rate))}
            >
              填入 {formatEstimate(row.rate)}
            </button>
          )}
        </div>
      ))}
    </fieldset>
  );
}

/** Banner text for one in-flight probe: which model, which product, which step. */
export function describeProbe(item: RecordValue, step: string | null): string {
  const model = typeof item.model === "string" ? item.model : "?";
  const profile = typeof item.profile === "string" ? profileLabel(item.profile) : "";
  return `探测 ${model}（${profile}）${step ? ` · ${step}` : ""}`;
}

export function useRateProbeJob(onFinished: (job: Job) => void) {
  const load = useCallback(
    async () => [jobResponse((await api.get("/models/rate-probe")).data)],
    [],
  );
  const { jobs, accept } = useJobPolling(load, onFinished);
  const [error, setError] = useState<string | null>(null);
  const job = jobs.find((row) => row.status !== "idle") ?? null;
  const start = (modelId?: string) => {
    setError(null);
    void api
      .post(
        modelId ? `/models/${encodeURIComponent(modelId)}/rate-probe` : "/models/rate-probe",
        {},
      )
      .then((response) => {
        const started = jobResponse(response.data);
        accept([started]);
        // A job with nothing to probe can finish before the start request returns.
        if (started.status !== "running") onFinished(started);
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };
  return { job, error, start };
}
