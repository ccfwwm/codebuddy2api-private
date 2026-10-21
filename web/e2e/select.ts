import type { Locator } from "@playwright/test";

/** Pick an option of the WebUI Select by value, the way a pointer user would. */
export async function choose(combobox: Locator, value: string) {
  await combobox.click();
  await combobox.page().locator(`[role="option"][data-value="${value}"]`).click();
}
