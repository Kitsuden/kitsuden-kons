/**
 * tallao — placing a panel next to its trigger
 *
 * The panel has `popover="manual"` and is shown with showPopover(): that lifts it
 * to the browser's top layer (above any z-index and any `overflow: hidden`, also
 * inside a Shadow DOM) without moving it in the DOM, so it inherits the tokens of
 * its ThemeScope. Floating UI computes the position (flipping and shifting at the
 * edges) and it is recomputed on scroll or resize. Without the Popover API, the
 * panel stays `fixed`.
 */
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
  type Middleware,
  type Placement,
  type VirtualElement,
} from "@floating-ui/dom";

export type { Placement, VirtualElement };

export interface AnchorOptions {
  placement?: Placement;
  /** Gap to the trigger, in px. */
  gap?: number;
  /** At least as wide as the trigger (combobox or select lists). */
  matchWidth?: boolean;
}

const hasPopoverApi = () => typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

/** A point in the viewport as anchor (a context menu opens where the user clicked). */
export function pointAnchor(x: number, y: number, context?: Element): VirtualElement {
  return {
    getBoundingClientRect: () => ({ x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0 }),
    contextElement: context,
  };
}

/** Shows `panel` anchored to `anchor`; returns the function that hides it and stops tracking it. */
export function anchor(anchorEl: Element | VirtualElement, panel: HTMLElement, opts: AnchorOptions = {}): () => void {
  if (hasPopoverApi() && panel.hasAttribute("popover")) {
    try {
      panel.showPopover();
    } catch {
      // It was already open or the element is not on the page: position it anyway.
    }
  }

  // `size` publishes the room left on the chosen side as --ta-available-height (lists cap their
  // height with it, so they stay usable with the on-screen keyboard open) and, with
  // `matchWidth`, makes the panel at least as wide as its trigger.
  const middleware: Middleware[] = [
    offset(opts.gap ?? 6),
    flip({ padding: 8 }),
    shift({ padding: 8 }),
    size({
      padding: 8,
      apply({ rects, availableHeight }) {
        panel.style.setProperty("--ta-available-height", `${Math.max(96, Math.floor(availableHeight))}px`);
        if (opts.matchWidth) panel.style.minWidth = `${rects.reference.width}px`;
      },
    }),
  ];

  const update = () =>
    computePosition(anchorEl, panel, { strategy: "fixed", placement: opts.placement ?? "bottom-start", middleware }).then(
      ({ x, y, placement }) => {
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        panel.dataset.side = placement.split("-")[0];
      }
    );

  const stop = autoUpdate(anchorEl, panel, update, {
    elementResize: typeof ResizeObserver !== "undefined",
    layoutShift: typeof IntersectionObserver !== "undefined",
  });

  return () => {
    stop();
    if (hasPopoverApi() && panel.isConnected) {
      try {
        panel.hidePopover();
      } catch {
        // It was already closed.
      }
    }
  };
}
