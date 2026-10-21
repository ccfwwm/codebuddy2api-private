import {
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useT } from "./i18n";
import s from "./ui.module.scss";

export type ToastTone = "good" | "warn" | "bad";
type Toast = {
  id: number;
  key?: string;
  tone: ToastTone;
  title: string;
  body?: ReactNode;
  born: number;
  leaving?: boolean;
};

// Toasts live outside React so a page can raise one from any callback, and a reload drops them.
let state: { toasts: Toast[]; hosts: string[] } = { toasts: [], hosts: [] };
const listeners = new Set<() => void>();
let serial = 0;
const update = (next: Partial<typeof state>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => state;
const remove = (id: number) => update({ toasts: state.toasts.filter((toast) => toast.id !== id) });

// Warnings stay long enough to read their details; hovering or focusing a toast holds it.
const LIFE: Record<ToastTone, number> = { good: 5000, warn: 10000, bad: 10000 };
const LIMIT = 4;
const TONES: Record<ToastTone, string> = { good: s.toastGood, warn: s.toastWarn, bad: s.toastBad };
const GLYPHS: Record<ToastTone, string> = {
  good: "m5 12.5 4.5 4.5L19 7.5",
  warn: "M12 7v6m0 4v.01",
  bad: "m8 8 8 8m0-8-8 8",
};

/**
 * Raise a passing notice at the top of the page. It fades on its own or sooner when clicked;
 * a notice with the same `key` replaces the previous one instead of stacking.
 */
export function notify(toast: Omit<Toast, "id" | "born" | "leaving">) {
  const kept = toast.key ? state.toasts.filter((old) => old.key !== toast.key) : state.toasts;
  update({ toasts: [...kept, { ...toast, id: ++serial, born: Date.now() }].slice(-LIMIT) });
}

export function dismiss(id: number) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches !== false) {
    remove(id);
    return;
  }
  update({
    toasts: state.toasts.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)),
  });
  window.setTimeout(() => remove(id), 180);
}

/** Drop every notice at once, as a refresh does. */
export function clearToasts() {
  update({ toasts: [] });
}

function ToastItem({ toast }: { toast: Toast }) {
  const t = useT();
  const [held, setHeld] = useState(false);
  // The clock runs from when the toast was raised, so moving into an opened drawer does not
  // restart it; letting go of a held toast gives it a full life again.
  const [since, setSince] = useState(toast.born);
  useEffect(() => {
    if (held || toast.leaving) return;
    const left = since + LIFE[toast.tone] - Date.now();
    const timer = window.setTimeout(() => dismiss(toast.id), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [held, since, toast]);
  const release = () => {
    setHeld(false);
    setSince(Date.now());
  };
  return (
    // Pointer users click anywhere on the notice; the close button serves the keyboard.
    <div
      className={`${s.toast} ${TONES[toast.tone]} ${toast.leaving ? s.toastLeaving : ""}`}
      onClick={() => dismiss(toast.id)}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={release}
      onFocus={() => setHeld(true)}
      onBlur={release}
    >
      <span className={s.toastIcon} aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d={GLYPHS[toast.tone]} />
        </svg>
      </span>
      <div className={s.toastText}>
        <strong>{toast.title}</strong>
        {toast.body}
      </div>
      <button type="button" className={s.toastClose} aria-label={t("common.dismissNotice")}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m7 7 10 10M7 17 17 7" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Where toasts render. Each page title and each open drawer mounts one and only the newest shows
 * them, so a toast raised from a modal drawer stays above its backdrop.
 */
export function ToastRegion() {
  const id = useId();
  const { toasts, hosts } = useSyncExternalStore(subscribe, snapshot);
  useLayoutEffect(() => {
    update({ hosts: [...state.hosts, id] });
    return () => update({ hosts: state.hosts.filter((host) => host !== id) });
  }, [id]);
  if (hosts.at(-1) !== id) return null;
  return (
    <div className={s.toasts} aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
