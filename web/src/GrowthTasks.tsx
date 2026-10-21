import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, list, object, text, type Credential, type RecordValue } from "./api";
import { jobResponse, useJobPolling, type Job } from "./jobs";
import s from "./ui.module.scss";

type GrowthTask = {
  task_code: string;
  title: string;
  description: string;
  credit: number;
  energy: number;
  locked: boolean;
  accept_status: string;
  target: number;
  current: number;
  claimable: boolean;
  claimed: boolean;
  group: string;
  automatable: boolean;
};

type GrowthView = {
  supported: boolean;
  auto_growth: boolean;
  growth_auto: Record<string, boolean>;
  tasks: GrowthTask[];
  message?: string;
  stale?: boolean;
};

const GROUP_LABELS: Record<string, string> = {
  behavior: "行为上报",
  chat: "真实对话",
  miniprogram: "小程序",
};

/** Every account's growth job; runs are server-side, so they survive closing the drawer. */
export function useGrowthJobs() {
  const load = useCallback(
    async () => list(object((await api.get("/growth-jobs")).data).jobs).map(jobResponse),
    [],
  );
  const { jobs, accept } = useJobPolling(load, () => {});
  const start = useCallback(
    async (identity: string, code?: string) => {
      const base = `/credentials/${encodeURIComponent(identity)}/growth-tasks`;
      const response = code
        ? await api.post(`${base}/auto`, { task_code: code })
        : await api.post(`${base}/auto-all`, {});
      accept([jobResponse(response.data)]);
    },
    [accept],
  );
  const byAccount = (identity: string) => jobs.find((job) => job.key === `growth:${identity}`);
  return { jobs, start, byAccount };
}

/** Banner text for the task a growth job is running now. */
export function describeGrowth(item: RecordValue): string {
  return `执行 ${text(item.title ?? item.task_code)}`;
}

function summary(job: Job): string {
  const results = job.results;
  if (!results.length) return "没有可执行的任务（均已领取或未解锁）";
  if (job.meta.kind === "single") return text(results[0].message) || "已执行";
  const failed = results.filter((row) => row.ok !== true);
  return (
    `已执行 ${results.length} 个任务，其中 ${results.filter((row) => row.claimed === true).length} 个领奖` +
    (failed.length
      ? `；未完成：${failed.map((row) => `${text(row.title ?? row.task_code)}（${text(row.message)}）`).join("，")}`
      : "")
  );
}

/** 成长计划子栏：仅国内个人账号渲染（上游成长中心为个人 CN 专属）。 */
export function GrowthTasks({
  credential,
  busy,
  onPreference,
  selectedIds,
  job,
  onRun,
}: {
  credential: Credential;
  busy: boolean;
  onPreference: (c: Credential, field: "auto_growth", enabled: boolean) => void;
  selectedIds: string[];
  job?: Job;
  onRun: (code?: string) => Promise<void>;
}) {
  const [view, setView] = useState<GrowthView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const running = job?.status === "running";
  const currentCode = running ? job.current[0]?.item.task_code : undefined;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const load = useCallback(async () => {
    const abort = new AbortController();
    controller.current = abort;
    setError(null);
    try {
      const response = await api.get(
        `/credentials/${encodeURIComponent(credential.id)}/growth-tasks`,
        { signal: abort.signal },
      );
      setView(object(response.data, "成长任务") as unknown as GrowthView);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  }, [credential.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // A job that finishes while the drawer is open reloads the list; one that finished
  // before it opened is only summarized, since the mount already loads fresh progress.
  const seenFinish = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!job || job.status !== "completed") {
      if (seenFinish.current === undefined) seenFinish.current = null; // Opened before it finished.
      return;
    }
    if (job.finished_at === seenFinish.current) return;
    const opened = seenFinish.current === undefined;
    seenFinish.current = job.finished_at;
    setNotice(opened ? `上次执行：${summary(job)}` : summary(job));
    if (!opened) void load();
  }, [job, load]);

  const run = async (code?: string) => {
    if (busy || running) return;
    setError(null);
    setNotice(null);
    seenFinish.current = job?.finished_at ?? null;
    try {
      await onRun(code);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // 串行保存：每次都基于已确认的映射合并，避免连续点击时旧映射覆盖新开关。
  const saveSwitches = async (changes: Record<string, boolean>) => {
    if (busy || saving || !view) return;
    const mapping = { ...view.growth_auto, ...changes };
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/credentials/${encodeURIComponent(credential.id)}`, {
        growth_auto: mapping,
      });
      setView({ ...view, growth_auto: mapping });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const syncToSelected = async () => {
    if (busy || !view || !selectedIds.length) return;
    setError(null);
    setNotice(null);
    try {
      for (const id of selectedIds) {
        if (id === credential.id) continue;
        for (const [code, enabled] of Object.entries(view.growth_auto)) {
          await api.post("/credentials/growth-batch", {
            ids: [id],
            task_codes: [code],
            enabled,
          });
        }
      }
      setNotice(
        `已把本账号的任务开关同步到 ${selectedIds.filter((id) => id !== credential.id).length} 个已选账号`,
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (view?.stale === true) return <small>凭证已变化，请刷新后重新打开成长任务</small>;
  if (view && view.supported === false) return null; // 非 CN 个人账号：整个子栏隐藏
  if (!view) return <small>{error ? text(error) : "成长任务加载中…"}</small>;

  // 无自动链的任务不展示：达标奖励仍由「自动成长补领」领取。
  const automatable = view.tasks.filter((task) => task.automatable === true);
  const groups: Record<string, GrowthTask[]> = {};
  for (const task of automatable) {
    (groups[task.group] ??= []).push(task);
  }
  // 已领取的任务不再可勾选，全选只覆盖仍可推进的任务。
  const selectable = automatable.filter((task) => !task.claimed);
  const allOn =
    selectable.length > 0 && selectable.every((task) => view.growth_auto[task.task_code] === true);

  return (
    <div className={s.credCardTasks}>
      <div className={s.credTaskRow}>
        <label className={s.check}>
          <input
            type="checkbox"
            role="switch"
            aria-label={`自动成长补领 ${credential.name ?? credential.id}`}
            checked={credential.auto_growth === true}
            disabled={busy || typeof credential.auto_growth !== "boolean"}
            onChange={(e) => onPreference(credential, "auto_growth", e.target.checked)}
          />
          自动成长补领
        </label>
        <small>仅补齐「已达标未领」的奖励，不发起对话或行为上报</small>
      </div>
      {Object.entries(groups).map(([group, tasks]) => (
        <div key={group}>
          <small>
            <strong>{GROUP_LABELS[group] ?? "其他"}</strong>
            {group === "chat" ? "（开启即授权消耗该账号对话额度）" : ""}
          </small>
          {tasks.map((task) => (
            <div key={task.task_code} className={s.growthTaskRow}>
              <label className={s.check}>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`自动${task.title} ${credential.name ?? credential.id}`}
                  checked={view.growth_auto[task.task_code] === true}
                  disabled={busy || saving || task.claimed}
                  onChange={(e) => saveSwitches({ [task.task_code]: e.target.checked })}
                />
                {task.title}
              </label>
              <span className={s.badge}>
                {`${task.current}/${task.target || "—"}${
                  task.credit || task.energy ? ` · +${task.credit}c +${task.energy}e` : ""
                }`}
              </span>
              {/* 提示挂在外层：禁用按钮在部分浏览器不触发悬停提示。 */}
              <span
                className={s.growthAction}
                title={!task.claimed && task.locked ? "按官方节奏逐日开放" : undefined}
              >
                <button
                  disabled={busy || running || task.claimed || task.locked}
                  aria-label={`一键完成${task.title} ${credential.name ?? credential.id}`}
                  onClick={() => run(task.task_code)}
                >
                  {task.claimed
                    ? "已领取"
                    : task.locked
                      ? "未解锁"
                      : currentCode === task.task_code
                        ? "执行中…"
                        : "一键完成"}
                </button>
              </span>
            </div>
          ))}
        </div>
      ))}
      <div className={s.credTaskRow}>
        <button
          disabled={busy || saving || selectable.length === 0}
          aria-label={`${allOn ? "全不选" : "全选"}任务开关 ${credential.name ?? credential.id}`}
          onClick={() =>
            saveSwitches(Object.fromEntries(selectable.map((task) => [task.task_code, !allOn])))
          }
        >
          {allOn ? "全不选" : "全选"}
        </button>
        <button
          disabled={busy || saving || running}
          aria-label={`全部执行 ${credential.name ?? credential.id}`}
          onClick={() => run()}
        >
          {running
            ? `执行中 ${job.completed}/${job.total}`
            : "全部执行（未勾选时执行全部未完成任务）"}
        </button>
        {selectedIds.some((id) => id !== credential.id) && (
          <button
            disabled={busy}
            aria-label={`同步开关到已选账号 ${credential.name ?? credential.id}`}
            onClick={syncToSelected}
          >
            同步开关到已选账号 ({selectedIds.filter((id) => id !== credential.id).length})
          </button>
        )}
      </div>
      {notice && <small>{text(notice)}</small>}
      {error && <small>{text(error)}</small>}
    </div>
  );
}
