/**
 * tallao — what DragBoard, DropZone and DragItem share
 *
 * The board keeps which item is selected, which one is being dragged with the mouse
 * and which zone the keyboard points at; zones and items read it from context.
 * Zones do not register: the board looks them up in the DOM, in the order they
 * appear, when the keyboard walks through them (so a reordered {#each} does not
 * scramble the arrow keys).
 */
import { getContext, setContext } from "svelte";

const KEY = Symbol("tallao-drag-board");

/** A board item: its id, its name (for the announcements) and the zone it is in. */
export interface DragRef {
  id: string;
  label: string;
  zone: string;
}

export interface DragBoardContext {
  /** Selected item (click, keyboard or drag). */
  readonly selected: string | null;
  /** Zone the keyboard points at while an item is being moved; null outside that mode. */
  readonly target: string | null;
  /** Item being dragged with the mouse right now. */
  readonly dragging: DragRef | null;
  /** Id of the (hidden) text with the keyboard instructions. */
  readonly instructionsId: string;
  /** Click: selects or releases the selection, without entering keyboard mode. */
  toggle(item: DragRef): void;
  /** Enter or Space on an item: picks it up, drops it in the chosen zone or cancels. */
  press(item: DragRef): void;
  /** Arrow keys: the next zone (1) or the previous one (-1). Returns whether it did anything. */
  step(item: DragRef, delta: 1 | -1): boolean;
  /** Escape: releases the selection without moving anything. Returns whether something was selected. */
  cancel(): boolean;
  /** Focus leaves the item: the keyboard stops pointing (the selection stays). */
  leave(item: DragRef): void;
  dragStart(item: DragRef, event: DragEvent): void;
  dragEnd(): void;
  /** A dragged item is dropped on zone `zone`. */
  drop(zone: string): void;
}

export const provideDragBoard = (ctx: DragBoardContext) => setContext(KEY, ctx);

export function useDragBoard(): DragBoardContext {
  const ctx = getContext<DragBoardContext | undefined>(KEY);
  if (!ctx) throw new Error("tallao: DropZone and DragItem must be inside a DragBoard");
  return ctx;
}
