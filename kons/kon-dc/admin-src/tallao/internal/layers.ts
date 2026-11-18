/**
 * tallao — stack of floating layers
 *
 * Popover, menu, tooltip and combobox register here while they are open.
 * Escape closes only the top one; a click outside closes, from the top down, the
 * layers that do not contain the click (a menu inside a popover survives a
 * click in the popover). With `composedPath()` it also works inside a
 * Shadow DOM, where `event.target` stays on the host.
 */

export interface Layer {
  /** Elements that count as "inside": the panel and its trigger. */
  inside: () => (Element | null | undefined)[];
  dismiss: (reason: "escape" | "outside") => void;
  /** Only Escape closes it; clicks pass through it (a tooltip). */
  escapeOnly?: boolean;
}

const stack: Layer[] = [];

function onPointerDown(e: PointerEvent) {
  const path = e.composedPath();
  for (const layer of [...stack].reverse()) {
    if (layer.escapeOnly) continue;
    if (layer.inside().some((el) => el && path.includes(el))) break;
    layer.dismiss("outside");
  }
}

// In the capture phase and with preventDefault: if the layer is inside a <dialog>,
// Escape must not close the dialog too.
function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || stack.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  stack[stack.length - 1].dismiss("escape");
}

/** Registers an open layer; returns the function that removes it. */
export function pushLayer(layer: Layer): () => void {
  if (typeof document === "undefined") return () => {};
  if (stack.length === 0) {
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
  }
  stack.push(layer);
  return () => {
    const i = stack.indexOf(layer);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0) {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    }
  };
}
