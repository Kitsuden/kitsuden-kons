/**
 * tallao — page scroll lock
 *
 * With several dialogs open at once the page stays locked until the last one
 * closes: it counts instead of using a boolean. It compensates for the scrollbar
 * width so the content does not jump when the scrollbar is hidden.
 */

let openCount = 0;
let saved: { overflow: string; paddingRight: string } | null = null;

/** Locks document scrolling; returns the function that releases it (once only). */
export function lockScroll(): () => void {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement;
  if (openCount++ === 0) {
    const scrollbar = window.innerWidth - root.clientWidth;
    saved = { overflow: root.style.overflow, paddingRight: root.style.paddingRight };
    root.style.overflow = "hidden";
    if (scrollbar > 0) root.style.paddingRight = `${scrollbar}px`;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--openCount === 0 && saved) {
      root.style.overflow = saved.overflow;
      root.style.paddingRight = saved.paddingRight;
      saved = null;
    }
  };
}
