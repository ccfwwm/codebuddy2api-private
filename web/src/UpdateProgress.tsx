import { useEffect, useState } from "react";
import { api, object } from "./api";
import { ErrorNotice } from "./components";
import { useT } from "./i18n";
import s from "./ui.module.scss";

export type UpdateJob = {
  status: string;
  step: string | null;
  target: string | null;
  message: string | null;
  backup: string | null;
  received: number | null;
  total: number | null;
};

export const UPDATE_STEPS = [
  "download",
  "verify",
  "extract",
  "backup",
  "dependencies",
  "replace",
  "restart",
];
// The download dominates the wall time, so it fills most of the bar.
const DOWNLOAD_SHARE = 70;
const POLL_INTERVAL = 1500;
const RESTART_TIMEOUT = 3 * 60 * 1000;
const RELOAD_DELAY = 1500;

function megabytes(value: number): string {
  return (value / 1024 / 1024).toFixed(1);
}

/** Poll until the restarted process reports the target version, then load its WebUI. */
function useRestartWatch(target: string | null) {
  const [phase, setPhase] = useState<"waiting" | "ready" | "timeout">("waiting");
  useEffect(() => {
    if (!target) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = () => {
      void api
        .get<unknown>("/update", { timeout: 5000 })
        .then((response) => {
          if (stopped || object(response.data).current !== target) return;
          stopped = true;
          setPhase("ready");
          timer = setTimeout(() => window.location.reload(), RELOAD_DELAY);
        })
        .catch(() => undefined) // The gateway is expected to be unreachable while restarting.
        .finally(() => {
          if (stopped) return;
          if (Date.now() - started > RESTART_TIMEOUT) setPhase("timeout");
          else timer = setTimeout(poll, POLL_INTERVAL);
        });
    };
    timer = setTimeout(poll, POLL_INTERVAL);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [target]);
  return phase;
}

export function UpdateProgress({ job }: { job: UpdateJob }) {
  const t = useT();
  const restarting = job.status === "restarting";
  const phase = useRestartWatch(restarting ? job.target : null);
  if (job.status === "failed")
    return <ErrorNotice message={t("updates.failed", { message: job.message ?? "—" })} />;
  if (job.status !== "running" && !restarting) return null;
  const tag = `v${job.target ?? ""}`;
  const index = Math.max(0, UPDATE_STEPS.indexOf(job.step ?? "download"));
  const downloading = !restarting && index === 0;
  const fraction =
    downloading && job.total
      ? Math.min(1, (job.received ?? 0) / job.total)
      : downloading
        ? null
        : 1;
  const ready = phase === "ready";
  const percent = ready
    ? 100
    : downloading
      ? Math.round((fraction ?? 0) * DOWNLOAD_SHARE)
      : Math.round(DOWNLOAD_SHARE + ((100 - DOWNLOAD_SHARE) * index) / UPDATE_STEPS.length);
  const indeterminate = downloading && fraction === null;
  const title = ready
    ? t("updates.ready", { tag })
    : restarting
      ? t("updates.restarting", { tag })
      : t("updates.stepActive", { step: t(`updates.step.${UPDATE_STEPS[index]}`), tag });
  const received = job.received ?? 0;
  return (
    <section className={s.updateProgress} aria-live="polite">
      <div className={s.progressHead}>
        <strong role="status">{title}</strong>
        {!indeterminate && <span>{percent}%</span>}
      </div>
      <div
        className={s.progressTrack}
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percent}
      >
        <span
          className={`${s.progressFill} ${indeterminate ? s.progressIndeterminate : ""} ${ready ? s.progressDone : ""}`}
          style={indeterminate ? undefined : { width: `${percent}%` }}
        />
      </div>
      {downloading && (
        <small className={s.storageSubtle}>
          {job.total
            ? t("updates.downloaded", {
                received: megabytes(received),
                total: megabytes(job.total),
              })
            : t("updates.downloadedUnknown", { received: megabytes(received) })}
        </small>
      )}
      <ol className={s.stepList}>
        {UPDATE_STEPS.map((step, position) => {
          const state =
            ready || position < index ? s.stepDone : position === index ? s.stepCurrent : "";
          return (
            <li key={step} className={state}>
              <span aria-hidden="true" />
              {t(`updates.step.${step}`)}
            </li>
          );
        })}
      </ol>
      {job.backup && (
        <small className={s.storageSubtle}>
          {t("updates.backupCreated", { file: job.backup })}
        </small>
      )}
      <ErrorNotice message={phase === "timeout" ? t("updates.restartTimeout") : null} />
    </section>
  );
}
