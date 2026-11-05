<!--
  tallao — DragBoard
  Move items between zones (rows of a tier list, columns of a board…)
  with the mouse AND with the keyboard. Wraps DropZone and DragItem:

    <DragBoard bind:selected onMove={(item, zone) => move(item, zone)}>
      {#each rows as r (r.id)}
        <DropZone id={r.id} label={r.name}>
          {#each r.things as t (t.id)}
            <DragItem id={t.id} label={t.name} zone={r.id}>{t.name}</DragItem>
          {/each}
        </DropZone>
      {/each}
    </DragBoard>

  - Mouse: drag an item to another zone.
  - Click: selects the item (`selected`); whoever uses the board decides what to
    do with it (e.g. a button per zone that places it there, or "delete").
  - Keyboard: Enter or Space picks it up, ↑ ↓ (or ← →) go through the zones in
    the order they appear, Enter or Space drops it and Escape cancels. Each step
    is announced in an `aria-live` region; the instructions are in hidden text
    that each item links with `aria-describedby`.

  `onMove` only fires when the zone changes. The board reorders nothing: whoever
  uses it renders, with their own data. After moving it with the keyboard, focus
  follows the item to its new zone.
-->
<script lang="ts" module>
  export interface DragAnnouncements {
    picked: (item: string, zone: string) => string;
    over: (item: string, zone: string) => string;
    moved: (item: string, zone: string) => string;
    cancelled: (item: string) => string;
  }
</script>

<script lang="ts">
  import { tick } from "svelte";

  import { provideDragBoard, type DragRef } from "$lib/internal/drag-board";
  import { cn } from "$lib/utils";

  interface Props {
    /** Selected item; null if there is none. */
    selected?: string | null;
    /** Item `item` moves to zone `zone` (different from its own). */
    onMove: (item: string, zone: string) => void | Promise<void>;
    /** Keyboard instructions a screen reader hears on reaching an item. */
    instructions?: string;
    /** Announcements for each step; missing ones are in English. */
    announcements?: Partial<DragAnnouncements>;
    class?: string;
    children?: import("svelte").Snippet;
  }

  const defaults: DragAnnouncements = {
    picked: (item, zone) => `Picked up ${item}, in ${zone}.`,
    over: (item, zone) => `${item} over ${zone}.`,
    moved: (item, zone) => `${item} moved to ${zone}.`,
    cancelled: (item) => `${item} was not moved.`,
  };

  let {
    selected = $bindable(null),
    onMove,
    instructions = "Press Space or Enter to pick up. Use the arrow keys to choose where it goes, then Space or Enter to drop it. Escape cancels.",
    announcements,
    class: className = "",
    children,
  }: Props = $props();

  const id = $props.id();
  const messages = $derived({ ...defaults, ...announcements });

  let root: HTMLElement | undefined = $state();
  let targetZone = $state<string | null>(null);
  let draggedItem = $state<DragRef | null>(null);
  let announcement = $state("");
  /** The last selected item, to name it when cancelling. */
  let chosen: DragRef | null = null;

  /** The zones of THIS board (not those of a nested one), in document order. */
  function zones(): { id: string; label: string }[] {
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>("[data-ta-drop-zone]")]
      .filter((el) => el.closest("[data-ta-drag-board]") === root)
      .map((el) => ({ id: el.dataset.taDropZone ?? "", label: el.getAttribute("aria-label") ?? "" }));
  }

  const zoneName = (zone: string) => zones().find((z) => z.id === zone)?.label ?? zone;

  function announce(text: string) {
    // Clear first: the same text twice in a row would not be read again.
    announcement = "";
    queueMicrotask(() => (announcement = text));
  }

  function pickUp(item: DragRef) {
    selected = item.id;
    chosen = item;
    targetZone = item.zone;
    announce(messages.picked(item.label, zoneName(item.zone)));
  }

  async function moveTo(item: DragRef, zone: string) {
    selected = null;
    targetZone = null;
    chosen = null;
    const done = onMove(item.id, zone);
    announce(messages.moved(item.label, zoneName(zone)));
    // The item is rendered in another zone (another node): focus follows it.
    await tick();
    const node = [...(root?.querySelectorAll<HTMLElement>("[data-ta-drag-item]") ?? [])].find(
      (el) => el.dataset.taDragItem === item.id
    );
    node?.focus({ preventScroll: true });
    await done;
  }

  function cancel(): boolean {
    if (selected === null) return false;
    const item = chosen;
    selected = null;
    targetZone = null;
    chosen = null;
    if (item) announce(messages.cancelled(item.label));
    return true;
  }

  provideDragBoard({
    get selected() {
      return selected;
    },
    get target() {
      // If whoever uses the board clears the selection (`selected = null`), it stops pointing.
      return selected === null ? null : targetZone;
    },
    get dragging() {
      return draggedItem;
    },
    instructionsId: `${id}-instructions`,
    toggle(item) {
      targetZone = null;
      if (selected === item.id) {
        selected = null;
        chosen = null;
      } else {
        selected = item.id;
        chosen = item;
      }
    },
    press(item) {
      if (selected !== item.id || targetZone === null) pickUp(item);
      else if (targetZone === item.zone) cancel();
      else void moveTo(item, targetZone);
    },
    step(item, delta) {
      if (selected !== item.id || targetZone === null) return false;
      const list = zones();
      if (!list.length) return false;
      const i = list.findIndex((z) => z.id === targetZone);
      const next = list[(i + delta + list.length) % list.length];
      targetZone = next.id;
      announce(messages.over(item.label, next.label));
      return true;
    },
    cancel: cancel,
    leave(item) {
      if (selected === item.id) targetZone = null;
    },
    dragStart(item, event) {
      draggedItem = item;
      selected = item.id;
      chosen = item;
      targetZone = null;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        // Firefox does not start the drag without data, even if nobody reads it.
        event.dataTransfer.setData("text/plain", item.id);
      }
    },
    dragEnd() {
      draggedItem = null;
    },
    drop(zone) {
      const item = draggedItem;
      draggedItem = null;
      if (!item) return;
      selected = null;
      chosen = null;
      if (zone !== item.zone) void onMove(item.id, zone);
    },
  });
</script>

<div bind:this={root} class={cn("ta-drag-board", className)} data-ta-drag-board>
  {@render children?.()}
  <span id={`${id}-instructions`} class="ta-drag-board-hidden">{instructions}</span>
  <span class="ta-drag-board-hidden" aria-live="assertive" aria-atomic="true">{announcement}</span>
</div>

<style>
  .ta-drag-board {
    position: relative;
  }

  .ta-drag-board-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
