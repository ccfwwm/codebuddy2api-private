import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { list, object, type RecordValue } from "./api";
import s from "./ui.module.scss";

/** A server-side job: it keeps running when the drawer or the page that started it closes. */
export type Job = {
  key: string;
  status: string;
  total: number;
  completed: number;
  current: { item: RecordValue; step: string | null }[];
  results: RecordValue[];
  started_at: number | null;
  finished_at: number | null;
  meta: RecordValue;
};

// An idle job has no rows yet; absent arrays are empty rather than malformed.
const rows = (value: unknown) => (Array.isArray(value) ? list(value) : []);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function jobResponse(value: unknown): Job {
  const data = object(value);
  const { key, status, total, completed, current, results, started_at, finished_at, ...meta } =
    data;
  return {
    key: typeof key === "string" ? key : "",
    status: typeof status === "string" ? status : "idle",
    total: count(total),
    completed: count(completed),
    current: rows(current).map((row) => ({
      item: object(row.item),
      step: typeof row.step === "string" ? row.step : null,
    })),
    results: rows(results),
    started_at: typeof started_at === "number" ? started_at : null,
    finished_at: typeof finished_at === "number" ? finished_at : null,
    meta,
  };
}

/**
 * Poll a job source while anything runs; `onFinished` fires once per job that this page
 * saw running and that has since finished, so the page can reload what the job changed.
 */
export function useJobPolling(
  load: () => Promise<Job[]>,
  onFinished: (job: Job) => void,
  interval = 2000,
) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const running = useRef(new Set<string>());
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const accept = useCallback((next: Job[]) => {
    for (const job of next) {
      if (job.status === "running") running.current.add(job.key);
      else if (running.current.delete(job.key)) finished.current(job);
    }
    setJobs((old) => {
      const merged = new Map(old.map((job) => [job.key, job]));
      for (const job of next) merged.set(job.key, job);
      return [...merged.values()];
    });
  }, []);
  const poll = useCallback(() => {
    void load()
      .then(accept)
      .catch(() => {
        // 被动轮询失败不升级为页面错误；发起任务失败才提示。
      });
  }, [load, accept]);
  useEffect(() => poll(), [poll]);
  const active = jobs.some((job) => job.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(poll, interval);
    return () => clearInterval(timer);
  }, [active, poll, interval]);
  return { jobs, accept };
}

/**
 * A progress banner for work in flight. Without a `total` the bar is indeterminate, for a request
 * that reports no progress of its own.
 */
export function ProgressBanner({
  title,
  completed = 0,
  total,
  children,
}: {
  title: string;
  completed?: number;
  total?: number;
  children: ReactNode;
}) {
  return (
    <div className={s.jobBanner} role="status">
      <div className={s.jobBannerHead}>
        <strong>{title}</strong>
        {total !== undefined && (
          <span>
            {completed}/{total}
          </span>
        )}
      </div>
      {total !== undefined ? <progress value={completed} max={Math.max(total, 1)} /> : <progress />}
      {children}
    </div>
  );
}

/** A progress banner for one running job: what it is, how far along, and what it is doing now. */
export function JobBanner({
  title,
  job,
  describe,
}: {
  title: string;
  job: Job;
  describe: (item: RecordValue, step: string | null) => string;
}) {
  return (
    <ProgressBanner title={title} completed={job.completed} total={job.total}>
      {job.current.length ? (
        job.current.map((row, index) => (
          <small key={index}>正在{describe(row.item, row.step)}</small>
        ))
      ) : (
        <small>正在准备…</small>
      )}
    </ProgressBanner>
  );
}
