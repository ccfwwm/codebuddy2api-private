import { fireEvent } from "@testing-library/react";

/** Pick an option of a Select by its value, the way a pointer user would. */
export function choose(combobox: HTMLElement, value: string) {
  fireEvent.click(combobox);
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (item) => item.dataset.value === value,
  );
  if (!option) throw new Error(`Select has no option with value ${value}`);
  fireEvent.click(option);
}
