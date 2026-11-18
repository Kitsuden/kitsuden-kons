<!--
  tallao — SortableList
  A list whose rows can be put in another order: the steps of a flow, a playlist, priorities.
  Each row has a handle (a real button, "Move <item>") and the content you render with the `row`
  snippet. The list reorders nothing itself: it calls `onReorder(from, to)` and you move the item in
  your own data (the same rule as DragBoard).

    <SortableList items={steps} key={(s) => s.id} label={(s) => s.name}
      onReorder={(from, to) => steps.splice(to, 0, steps.splice(from, 1)[0])}>
      {#snippet row(step)}{step.name}{/snippet}
    </SortableList>

  - Mouse: drag a row by its handle and drop it on another row.
  - Keyboard, touch or a click: the handle picks the row up (`aria-pressed`); then ↑ ↓ (Home, End)
    or the "Move up" / "Move down" buttons that appear in that row move it, and the handle (or
    Enter, Space) drops it. Escape puts it back where it was. Each step is announced in an
    `aria-live` region; the instructions are hidden text the handles point at.
  On the server the rows render as a plain list; moving needs JavaScript.
-->
<script lang="ts" generics="T">
  import { tick } from "svelte";

  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  const L = useLabels();

  interface Props {
    items: T[];
    /** A stable key per item (it keeps focus and the row's state when the order changes). */
    key: (item: T, index: number) => string;
    /** The item's name in the handle and the announcements. */
    label: (item: T, index: number) => string;
    /** Move the item at `from` to `to` in your data. */
    onReorder: (from: number, to: number) => void;
    /** What each row shows, after its handle. */
    row: import("svelte").Snippet<[T, number]>;
    /** Accessible name of the list. */
    ariaLabel?: string;
    disabled?: boolean;
    /** The handle's name; "{item}" is replaced by the item's label. */
    handleLabel?: string;
    moveUpLabel?: string;
    moveDownLabel?: string;
    instructions?: string;
    class?: string;
    /** Other attributes go to the <ol>. */
    [key: string]: unknown;
  }

  const {
    items,
    key,
    label,
    onReorder,
    row,
    ariaLabel,
    disabled = false,
    handleLabel = L.moveItem,
    moveUpLabel = L.moveUp,
    moveDownLabel = L.moveDown,
    instructions = L.sortInstructions,
    class: className = "",
    ...rest
  }: Props = $props();

  const uid = $props.id();
  const helpId = `${uid}-help`;
  let listEl: HTMLOListElement | undefined = $state();

  /** The row picked up with the handle (its key) and where it started. */
  let grabbed = $state<{ key: string; origin: number } | null>(null);
  let message = $state("");
  /** Mouse drag: the index dragged and the row it is over. */
  let dragFrom = $state<number | null>(null);
  let overIndex = $state<number | null>(null);

  const say = (template: string, item: string, position: number) =>
    (message = template.replace("{item}", item).replace("{position}", String(position)).replace("{total}", String(items.length)));

  const indexOfKey = (k: string) => items.findIndex((it, i) => key(it, i) === k);

  async function focusHandle(k: string) {
    await tick();
    [...(listEl?.querySelectorAll<HTMLButtonElement>("[data-sort-key]") ?? [])].find((b) => b.dataset.sortKey === k)?.focus();
  }

  function toggle(index: number) {
    if (disabled) return;
    const k = key(items[index], index);
    if (grabbed?.key === k) {
      say(L.sortDropped, label(items[index], index), index + 1);
      grabbed = null;
      return;
    }
    grabbed = { key: k, origin: index };
    say(L.sortPicked, label(items[index], index), index + 1);
  }

  function move(index: number, to: number) {
    const target = Math.max(0, Math.min(items.length - 1, to));
    if (target === index) return;
    const k = key(items[index], index);
    const name = label(items[index], index);
    onReorder(index, target);
    say(L.sortMoved, name, target + 1);
    void focusHandle(k);
  }

  function onkeydown(e: KeyboardEvent, index: number) {
    if (!grabbed || grabbed.key !== key(items[index], index)) return;
    const moves: Record<string, number> = { ArrowUp: index - 1, ArrowLeft: index - 1, ArrowDown: index + 1, ArrowRight: index + 1, Home: 0, End: items.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      move(index, moves[e.key]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      const { origin, key: k } = grabbed;
      const name = label(items[index], index);
      if (origin !== index) onReorder(index, origin);
      grabbed = null;
      say(L.sortCancelled, name, origin + 1);
      void focusHandle(k);
    }
  }

  function ondragstart(e: DragEvent, index: number) {
    if (disabled) return;
    dragFrom = index;
    grabbed = null;
    e.dataTransfer?.setData("text/plain", String(index));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function ondrop(e: DragEvent, index: number) {
    if (dragFrom === null) return;
    e.preventDefault();
    const from = dragFrom;
    dragFrom = null;
    overIndex = null;
    if (from !== index) {
      const name = label(items[from], from);
      onReorder(from, index);
      say(L.sortDropped, name, index + 1);
    }
  }
</script>

<ol bind:this={listEl} class={cn("ta-sortable", className)} aria-label={ariaLabel} {...rest}>
  {#each items as item, i (key(item, i))}
    {@const k = key(item, i)}
    {@const isGrabbed = grabbed?.key === k}
    <li
      class="ta-sortable-row"
      data-grabbed={isGrabbed ? "" : undefined}
      data-over={overIndex === i && dragFrom !== null && dragFrom !== i ? "" : undefined}
      ondragover={(e) => {
        if (dragFrom === null) return;
        e.preventDefault();
        overIndex = i;
      }}
      ondragleave={() => overIndex === i && (overIndex = null)}
      ondrop={(e) => ondrop(e, i)}
    >
      <button
        type="button"
        class="ta-sortable-handle"
        data-sort-key={k}
        aria-label={handleLabel.replace("{item}", label(item, i))}
        aria-pressed={isGrabbed}
        aria-describedby={helpId}
        {disabled}
        draggable={!disabled}
        ondragstart={(e) => ondragstart(e, i)}
        ondragend={() => {
          dragFrom = null;
          overIndex = null;
        }}
        onclick={() => toggle(i)}
        onkeydown={(e) => onkeydown(e, i)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          {#each [4, 8, 12] as y (y)}<circle cx="6" cy={y} r="1.1" fill="currentColor" /><circle cx="10" cy={y} r="1.1" fill="currentColor" />{/each}
        </svg>
      </button>
      <div class="ta-sortable-content">{@render row(item, i)}</div>
      {#if isGrabbed}
        <div class="ta-sortable-moves">
          <button type="button" class="ta-sortable-move" aria-label={moveUpLabel} disabled={i === 0} onclick={() => move(i, i - 1)}>↑</button>
          <button type="button" class="ta-sortable-move" aria-label={moveDownLabel} disabled={i === items.length - 1} onclick={() => move(i, i + 1)}>↓</button>
        </div>
      {/if}
    </li>
  {/each}
</ol>
<span id={helpId} class="ta-sortable-sr">{instructions}</span>
<span class="ta-sortable-sr" role="status" aria-live="assertive">{message}</span>

<style>
  .ta-sortable {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ta-sortable-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem;
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    transition:
      border-color var(--ta-duration-fast, 120ms) var(--ta-ease-out, ease-out),
      box-shadow var(--ta-duration-fast, 120ms) var(--ta-ease-out, ease-out);
  }

  .ta-sortable-row[data-grabbed] {
    border-color: rgb(var(--ta-accent));
    box-shadow: 0 0 0 3px rgb(var(--ta-accent) / 0.2);
  }

  /* Where a dragged row lands: a line on top, not colour alone (the row also gets an outline). */
  .ta-sortable-row[data-over] {
    border-color: rgb(var(--ta-accent));
    box-shadow: inset 0 3px 0 rgb(var(--ta-accent));
  }

  .ta-sortable-handle,
  .ta-sortable-move {
    position: relative;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    font: inherit;
    color: rgb(var(--ta-text-dim));
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--ta-radius);
    cursor: grab;
  }

  .ta-sortable-move {
    cursor: pointer;
    border-color: rgb(var(--ta-border));
  }

  .ta-sortable-handle[aria-pressed="true"] {
    color: rgb(var(--ta-on-accent));
    background: rgb(var(--ta-accent));
  }

  .ta-sortable-handle:hover:not(:disabled),
  .ta-sortable-move:hover:not(:disabled) {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-text) / 0.08);
  }

  .ta-sortable-handle:focus-visible,
  .ta-sortable-move:focus-visible {
    outline: 2px solid rgb(var(--ta-accent));
    outline-offset: 1px;
  }

  .ta-sortable-handle:disabled,
  .ta-sortable-move:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ta-sortable-content {
    flex: 1 1 auto;
    min-width: 0;
  }

  .ta-sortable-moves {
    display: flex;
    gap: 0.25rem;
  }

  .ta-sortable-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (pointer: coarse) {
    .ta-sortable-handle::after,
    .ta-sortable-move::after {
      content: "";
      position: absolute;
      inset: 50% auto auto 50%;
      width: 2.75rem;
      height: 2.75rem;
      transform: translate(-50%, -50%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-sortable-row {
      transition: none;
    }
  }
</style>
