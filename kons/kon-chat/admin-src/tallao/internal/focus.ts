/**
 * tallao — focus utilities shared by dialogs, menus and floating panels.
 */

const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

/** Elements that Tab reaches inside `root`, in document order. */
export function tabbables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => !el.closest("[inert]") && el.getAttribute("aria-hidden") !== "true"
  );
}

/**
 * The focused element, also inside a Shadow DOM: `document.activeElement`
 * stays on the host, and restoring focus there loses it.
 */
export function getActiveElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let active = document.activeElement as HTMLElement | null;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement as HTMLElement;
  return active;
}

/** Returns focus to where it was, if that element is still on the page. */
export function restoreFocus(el: HTMLElement | null) {
  if (el && el.isConnected) el.focus({ preventScroll: true });
}
