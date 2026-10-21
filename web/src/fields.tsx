import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useT } from "./i18n";
import { popoverHost, usePopover } from "./popover";
import s from "./ui.module.scss";

type Choice = { value: string; label: ReactNode; disabled: boolean };
type OptionProps = { value?: string | number; children?: ReactNode; disabled?: boolean };

function choicesOf(children: ReactNode): Choice[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement<OptionProps>(child) && child.type === "option"
      ? [
          {
            // Like a native <option>, the text stands in for a missing value.
            value:
              child.props.value !== undefined
                ? String(child.props.value)
                : typeof child.props.children === "string"
                  ? child.props.children
                  : "",
            label: child.props.children,
            disabled: child.props.disabled === true,
          },
        ]
      : [],
  );
}

function Chevron() {
  return (
    <svg className={s.selectChevron} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * A glass select written like a native one, with <option> children, but drawn as a combobox
 * button and a listbox popover (WAI-ARIA select-only combobox).
 */
export function Select({
  value,
  onChange,
  children,
  disabled = false,
  className = "",
  ...rest
}: {
  value: string | number;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  title?: string;
  id?: string;
}) {
  const choices = choicesOf(children);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const placement = usePopover(open, close, trigger, list, "start");
  const current = choices.findIndex((choice) => choice.value === String(value));
  const enabled = choices.flatMap((choice, index) => (choice.disabled ? [] : [index]));
  useEffect(() => {
    if (open)
      list.current
        ?.querySelector(`[data-index="${active}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);
  const show = () => {
    setActive(current >= 0 ? current : (enabled[0] ?? 0));
    setOpen(true);
  };
  const pick = (index: number) => {
    const choice = choices[index];
    if (!choice || choice.disabled) return;
    setOpen(false);
    if (choice.value !== String(value)) onChange(choice.value);
  };
  const step = (direction: 1 | -1) => {
    const position = enabled.indexOf(active);
    const next = enabled[Math.min(enabled.length - 1, Math.max(0, position + direction))];
    if (next !== undefined) setActive(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (open) step(event.key === "ArrowDown" ? 1 : -1);
      else show();
    } else if ((event.key === "Home" || event.key === "End") && open) {
      event.preventDefault();
      setActive((event.key === "Home" ? enabled[0] : enabled.at(-1)) ?? 0);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) pick(active);
      else show();
    } else if (event.key === "Escape" && open) {
      // Close only the list, not a drawer around it.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Tab") setOpen(false);
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        className={`${s.select} ${className}`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        {...rest}
      >
        <span className={s.selectValue}>{choices[current]?.label ?? "—"}</span>
        <Chevron />
      </button>
      {open &&
        createPortal(
          <ul
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label={rest["aria-label"]}
            className={s.selectList}
            style={
              placement
                ? { top: placement.top, left: placement.left, minWidth: placement.minWidth }
                : { visibility: "hidden" }
            }
          >
            {choices.map((choice, index) => (
              <li
                key={choice.value}
                id={`${id}-${index}`}
                role="option"
                aria-selected={index === current}
                aria-disabled={choice.disabled || undefined}
                data-index={index}
                data-value={choice.value}
                className={index === active ? s.selectActive : undefined}
                onMouseEnter={() => !choice.disabled && setActive(index)}
                // Keep focus on the combobox so the keyboard keeps working after a pointer pick.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(index)}
              >
                {choice.label}
              </li>
            ))}
          </ul>,
          popoverHost(trigger.current),
        )}
    </>
  );
}

/** A recessed glass search field with a leading icon and a clear button. */
export function SearchInput({
  value,
  onChange,
  className = "",
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  "aria-label": string;
  placeholder?: string;
}) {
  const t = useT();
  return (
    <span className={`${s.search} ${className}`}>
      <svg className={s.searchIcon} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4-4" />
      </svg>
      <input value={value} onChange={(event) => onChange(event.target.value)} {...rest} />
      {value && (
        <button
          type="button"
          className={s.searchClear}
          aria-label={t("common.clearSearch")}
          onClick={() => onChange("")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 7 10 10M7 17 17 7" />
          </svg>
        </button>
      )}
    </span>
  );
}
