import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vite-plus/test";
import { clearToasts } from "./toast";
window.scrollTo = vi.fn();
if (!window.PointerEvent) window.PointerEvent = MouseEvent as typeof PointerEvent;
afterEach(() => {
  cleanup();
  clearToasts();
});
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
