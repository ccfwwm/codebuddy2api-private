import { useEffect, useState } from "react";
import {
  api,
  errorMessage,
  list,
  number,
  object,
  text,
  useResource,
  type RecordValue,
} from "../api";
import { useT } from "../i18n";
import {
  Badge,
  ClearLogs,
  Drawer,
  DrawerPresence,
  Empty,
  ErrorNotice,
  Icon,
  RefreshIcon,
  PageTitle,
  Panel,
  ResourceState,
} from "../components";
import { Select } from "../fields";
import { notify } from "../toast";
import s from "../ui.module.scss";

function normalize(value: unknown) {
  return object(value, "存储状态");
}

function bytes(value: unknown): string {
  const n = number(value);
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function ArchivePanel({ archives, reload }: { archives: unknown[]; reload: () => void }) {
  const t = useT();
  // Default shorter than the 30-day retention window so opening the page (which
  // prunes expired rows) still leaves older in-retention logs to archive.
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  return (
    <Panel title={t("storage.archive")} hint={t("storage.archiveHint")}>
      <div className={s.panelBody}>
        <form
          className={s.archiveForm}
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            setResult(null);
            void api
              .post("/storage/archive", { days })
              .then((response) => {
                const d = object(response.data, t("storage.archiveResult"));
                const count = (number(d.archived_requests) ?? 0) + (number(d.archived_events) ?? 0);
                setResult(
                  count === 0
                    ? t("storage.archiveEmpty", { days })
                    : t("storage.archiveDone", { count, file: text(d.file) }),
                );
                reload();
              })
              .catch((err: unknown) => setError(errorMessage(err)))
              .finally(() => setBusy(false));
          }}
        >
          <label className={s.field}>
            {t("storage.archiveDays")}
            <input
              type="number"
              min={1}
              max={3650}
              value={days}
              onChange={(e) => setDays(Math.max(1, Math.min(3650, Number(e.target.value) || 1)))}
            />
          </label>
          <button className={s.primary} disabled={busy}>
            {busy ? t("storage.archiveBusy") : t("storage.archiveSubmit")}
          </button>
        </form>
        {result && <p className={s.resultNote}>{result}</p>}
        <ErrorNotice message={error} />
        <div className={s.storageSection}>
          <div className={s.storageSectionHead}>
            <strong>{t("storage.archives")}</strong>
            <span>{archives.length}</span>
          </div>
          {archives.length ? (
            <ul className={s.archiveList}>
              {archives.map((name) => (
                <li key={String(name)}>{text(name)}</li>
              ))}
            </ul>
          ) : (
            <Empty title={t("storage.archivesEmpty")} />
          )}
        </div>
      </div>
    </Panel>
  );
}

const BACKUP_KINDS = {
  update: "storage.backupKind.update",
  manual: "storage.backupKind.manual",
  auto: "storage.backupKind.auto",
} as const;
const BACKUP_INTERVALS = [6, 12, 24, 48, 168];
const BACKUP_SETTINGS = ["backup_auto", "backup_interval_hours", "backup_keep"] as const;

function BackupPanel({
  backups,
  schedule,
  reload,
}: {
  backups: RecordValue[];
  schedule: RecordValue | null;
  reload: () => void;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [drawer, setDrawer] = useState<"auto" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const next = number(schedule?.next_at);
  const backupNow = () => {
    setCreating(true);
    setError(null);
    void api
      .post("/storage/backups")
      .then((response) => {
        notify({
          key: "backup",
          tone: "good",
          title: t("storage.backupCreated"),
          body: <span>{text(object(response.data).created)}</span>,
        });
        reload();
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setCreating(false));
  };
  return (
    <Panel
      title={t("storage.backups")}
      action={
        <div className={s.panelActions}>
          <button type="button" className={s.pill} disabled={creating} onClick={backupNow}>
            <Icon name="plus" />
            {creating ? t("storage.backupCreating") : t("storage.backupNow")}
          </button>
          <button type="button" className={s.pill} onClick={() => setDrawer("auto")}>
            <Icon name="clock" />
            {t("storage.backupAuto")}
          </button>
          <button type="button" className={s.pill} onClick={() => setDrawer("restore")}>
            <Icon name="restore" />
            {t("storage.backupRestore")}
          </button>
        </div>
      }
    >
      <div className={s.panelBody}>
        <p className={s.storageLead}>{t("storage.backupsDesc")}</p>
        {schedule && (
          <small className={s.storageSubtle}>
            {schedule.enabled === true
              ? t("storage.backupScheduleOn", {
                  hours: number(schedule.interval_hours) ?? "—",
                  keep: number(schedule.keep) ?? "—",
                  next: next === null ? "—" : new Date(next * 1000).toLocaleString("zh-CN"),
                })
              : t("storage.backupScheduleOff")}
          </small>
        )}
        <ErrorNotice message={error} />
        {backups.length ? (
          <ul className={s.archiveList}>
            {backups.map((backup) => {
              const name = text(backup.name);
              const kind =
                backup.kind === "manual" || backup.kind === "auto" ? backup.kind : "update";
              const created = number(backup.created_at);
              return (
                <li key={name}>
                  <span className={s.backupInfo} title={name}>
                    <Badge>{t(BACKUP_KINDS[kind])}</Badge>
                    {kind === "update"
                      ? `v${text(backup.from)} → v${text(backup.to)}`
                      : `v${text(backup.version)}`}{" "}
                    · {created === null ? "—" : new Date(created * 1000).toLocaleString("zh-CN")} ·{" "}
                    {bytes(backup.size)}
                  </span>
                  <span className={s.backupActions}>
                    <a href={`/admin/storage/backups/${encodeURIComponent(name)}`} download={name}>
                      {t("storage.backupDownload")}
                    </a>
                    {confirming === name ? (
                      <button
                        type="button"
                        className={s.danger}
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          setError(null);
                          void api
                            .delete(`/storage/backups/${encodeURIComponent(name)}`)
                            .then(() => {
                              setConfirming(null);
                              reload();
                            })
                            .catch((err: unknown) => setError(errorMessage(err)))
                            .finally(() => setBusy(false));
                        }}
                      >
                        {t("storage.backupConfirmDelete")}
                      </button>
                    ) : (
                      <button type="button" onClick={() => setConfirming(name)}>
                        {t("storage.backupDelete")}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty title={t("storage.backupsEmpty")} />
        )}
      </div>
      <DrawerPresence>
        {drawer === "auto" && <AutoBackupDrawer onClose={() => setDrawer(null)} onSaved={reload} />}
      </DrawerPresence>
      <DrawerPresence>
        {drawer === "restore" && <RestoreDrawer onClose={() => setDrawer(null)} />}
      </DrawerPresence>
    </Panel>
  );
}

type AutoBackupForm = {
  revision: number;
  enabled: boolean;
  hours: number;
  keep: number;
  locked: Set<string>;
};

/** Automatic backups: on or off, how often, and how many scheduled backups to keep. */
function AutoBackupDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [form, setForm] = useState<AutoBackupForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .get<unknown>("/settings")
      .then((response) => {
        if (cancelled) return;
        const data = object(response.data, "设置");
        const items = list(data.items);
        const value = (key: string) => items.find((item) => item.key === key)?.value;
        setForm({
          revision: number(data.revision) ?? 0,
          enabled: value("backup_auto") === true,
          hours: number(value("backup_interval_hours")) ?? 24,
          keep: number(value("backup_keep")) ?? 7,
          locked: new Set(
            items
              .filter((item) => item.locked === true && typeof item.key === "string")
              .map((item) => text(item.key)),
          ),
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const save = () => {
    if (!form) return;
    const values = Object.fromEntries(
      (
        [
          ["backup_auto", form.enabled],
          ["backup_interval_hours", form.hours],
          ["backup_keep", form.keep],
        ] as const
      ).filter(([key]) => !form.locked.has(key)),
    );
    setBusy(true);
    setError(null);
    void api
      .patch("/settings", { revision: form.revision, values })
      .then(() => {
        notify({ key: "backup-schedule", tone: "good", title: t("storage.autoSaved") });
        onSaved();
        onClose();
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  const intervals =
    form && !BACKUP_INTERVALS.includes(form.hours)
      ? [...BACKUP_INTERVALS, form.hours].sort((a, b) => a - b)
      : BACKUP_INTERVALS;
  const anyLocked = BACKUP_SETTINGS.some((key) => form?.locked.has(key));
  return (
    <Drawer title={t("storage.autoTitle")} onClose={onClose} dismissDisabled={busy}>
      <p className={s.note}>{t("storage.autoNote")}</p>
      {anyLocked && <p className={s.note}>{t("storage.autoLocked")}</p>}
      <ErrorNotice message={error} />
      {form && (
        <form
          className={s.autoBackupForm}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label className={s.enableSwitch}>
            <input
              type="checkbox"
              role="switch"
              checked={form.enabled}
              disabled={busy || form.locked.has("backup_auto")}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            <span>{t("storage.autoEnabled")}</span>
          </label>
          <label className={s.field}>
            {t("storage.autoInterval")}
            <Select
              value={form.hours}
              disabled={busy || form.locked.has("backup_interval_hours")}
              onChange={(value) => setForm({ ...form, hours: Number(value) })}
            >
              {intervals.map((hours) => (
                <option key={hours} value={hours}>
                  {hours === 24
                    ? t("storage.autoDaily")
                    : hours === 168
                      ? t("storage.autoWeekly")
                      : t("storage.autoEvery", { hours })}
                </option>
              ))}
            </Select>
          </label>
          <label className={s.field}>
            {t("storage.autoKeep")}
            <input
              type="number"
              min={1}
              max={100}
              value={form.keep}
              disabled={busy || form.locked.has("backup_keep")}
              onChange={(event) =>
                setForm({
                  ...form,
                  keep: Math.max(1, Math.min(100, Number(event.target.value) || 1)),
                })
              }
            />
          </label>
          <button className={s.primary} disabled={busy}>
            {t("storage.autoSave")}
          </button>
        </form>
      )}
    </Drawer>
  );
}

/** How to put a backup back: the program by reinstalling its version, the configuration by hand. */
function RestoreDrawer({ onClose }: { onClose: () => void }) {
  const t = useT();
  const dir = "${CODEBUDDY_AUTH_DIR:-auth}";
  return (
    <Drawer title={t("storage.restoreTitle")} onClose={onClose}>
      <p className={s.note}>{t("storage.restoreNote")}</p>
      <pre className={s.codeBlock}>
        {`${t("storage.step.stop")}

${t("storage.restore.extract")}
mkdir -p /tmp/codebuddy-restore
tar -xzf "${dir}/backups/<backup>.tar.gz" -C /tmp/codebuddy-restore
cat /tmp/codebuddy-restore/manifest.json

${t("storage.restore.data")}
rm -f "${dir}/control.sqlite3-wal" "${dir}/control.sqlite3-shm"
cp -a /tmp/codebuddy-restore/data/control.sqlite3 "${dir}/"

${t("storage.restore.start")}`}
      </pre>
    </Drawer>
  );
}

export function Storage() {
  const t = useT();
  const resource = useResource("/storage", normalize);
  const [clearing, setClearing] = useState(false);
  const d = resource.data;
  const reclaimable = number(d?.reclaimable_bytes);
  const archives = Array.isArray(d?.archives) ? d.archives : [];
  const backups = Array.isArray(d?.backups)
    ? d.backups.filter((item): item is RecordValue => typeof item === "object" && item !== null)
    : [];
  const stateLabel =
    d?.degraded === true
      ? t("storage.stateDegraded")
      : d?.degraded === false
        ? t("dash.status.normal")
        : t("storage.stateUnknown");
  return (
    <>
      <PageTitle
        title={t("storage.title")}
        description={t("storage.desc")}
        actions={
          <>
            {d && (
              <Badge tone={d.degraded === true ? "bad" : d.degraded === false ? "good" : "neutral"}>
                {t("storage.status")} · {stateLabel}
              </Badge>
            )}
            <button onClick={resource.reload}>
              <RefreshIcon spinning={resource.refreshing} />
              {t("dash.refresh")}
            </button>
          </>
        }
      />
      <ResourceState {...resource} />
      {d && (
        <>
          <div className={s.kpiGrid}>
            <article className={s.kpiCard}>
              <div>
                <span>{t("storage.dbFile")}</span>
                <span>
                  <Icon name="database" />
                </span>
              </div>
              <strong>{bytes(d.db_bytes)}</strong>
              <small>
                {t("storage.counts", {
                  requests: number(d.request_count) ?? "—",
                  events: number(d.event_count) ?? "—",
                  days: number(d.retention_days) ?? "—",
                })}
              </small>
            </article>
            <article className={s.kpiCard}>
              <div>
                <span>{t("storage.walFile")}</span>
                <span>
                  <Icon name="logs" />
                </span>
              </div>
              <strong>{bytes(d.wal_bytes)}</strong>
              <small>SHM {bytes(d.shm_bytes)}</small>
            </article>
            <article className={s.kpiCard}>
              <div>
                <span>{t("storage.logical")}</span>
                <span>
                  <Icon name="cache" />
                </span>
              </div>
              <strong>{bytes(d.logical_bytes)}</strong>
              <small>{d.pending_cleanup === true ? t("storage.pendingCleanup") : stateLabel}</small>
            </article>
            <article className={s.kpiCard}>
              <div>
                <span>{t("storage.reclaimable")}</span>
                <span>
                  <Icon name="leaf" />
                </span>
              </div>
              <strong>{bytes(d.reclaimable_bytes)}</strong>
              <small>
                {number(d.freelist_pages) ?? 0} / {number(d.page_count) ?? 0} pages
              </small>
            </article>
          </div>
          <div className={s.stack}>
            <div className={s.storageSplit}>
              <ArchivePanel archives={archives} reload={resource.reload} />
              <Panel title={t("storage.vacuum")} hint={t("storage.cleanup")}>
                <div className={s.panelBody}>
                  <p className={s.storageLead}>
                    {t("storage.vacuumDesc", {
                      reclaimable:
                        reclaimable !== null && reclaimable > 0
                          ? t("storage.vacuumReclaim", { size: bytes(reclaimable) })
                          : "",
                    })}
                  </p>
                  <pre className={s.codeBlock}>
                    {`${t("storage.step.stop")}
docker compose down        ${t("storage.step.stopLocal")}

${t("storage.step.vacuum")}
sqlite3 "\${CODEBUDDY_AUTH_DIR:-auth}/logs.sqlite3" \\
  "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"

${t("storage.step.restart")}
docker compose up -d`}
                  </pre>
                  <small className={s.storageSubtle}>{t("storage.vacuumNote")}</small>
                  <div className={s.cleanupBox}>
                    <div>
                      <strong>{t("storage.cleanup")}</strong>
                      <p>{t("storage.cleanupDesc")}</p>
                    </div>
                    <button type="button" onClick={() => setClearing(true)}>
                      {t("storage.cleanupOpen")}
                    </button>
                  </div>
                </div>
              </Panel>
            </div>
            <BackupPanel
              backups={backups}
              schedule={
                d.backup_schedule && typeof d.backup_schedule === "object"
                  ? object(d.backup_schedule)
                  : null
              }
              reload={resource.reload}
            />
          </div>
        </>
      )}
      <DrawerPresence>
        {clearing && (
          <ClearLogs onClose={() => setClearing(false)} onDone={() => resource.reload()} />
        )}
      </DrawerPresence>
    </>
  );
}
