import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

export type Placement = { top: number; left: number; minWidth: number };

/**
 * Where a popover is portaled: inside an open modal <dialog> it must join the dialog's top layer,
 * elsewhere <body> keeps it clear of panels, whose backdrop-filter would capture a fixed child.
 */
export function popoverHost(trigger: HTMLElement | null): HTMLElement {
  return trigger?.closest("dialog") ?? document.body;
}

/**
 * Keep a fixed popover beside its trigger, flipping above it near the bottom of the viewport, and
 * close it on an outside press or Escape. `start` aligns left edges and matches the trigger width.
 */
export function usePopover(
  open: boolean,
  close: () => void,
  trigger: RefObject<HTMLElement | null>,
  popover: RefObject<HTMLElement | null>,
  align: "start" | "end",
): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const place = useCallback(() => {
    const anchor = trigger.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const minWidth = align === "start" ? rect.width : 0;
    const width = Math.max(popover.current?.offsetWidth || 160, minWidth);
    const height = popover.current?.offsetHeight || 220;
    const margin = 8;
    const preferred = align === "end" ? rect.right - width : rect.left;
    const left = Math.min(Math.max(margin, preferred), window.innerWidth - width - margin);
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 4);
    setPlacement({ top, left, minWidth });
  }, [trigger, popover, align]);

  useEffect(() => {
    if (!open) return;
    const press = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !popover.current?.contains(target)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", press);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", press);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place, close, trigger, popover]);

  useLayoutEffect(() => {
    setPlacement(null);
    if (open) place();
  }, [open, place]);

  return placement;
}
