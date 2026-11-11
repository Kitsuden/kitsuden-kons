<!--
  tallao — DragItem
  An item that moves between the DropZones of a DragBoard. It is a toggle
  button (`aria-pressed` = selected) that can also be dragged:
    - click: selects it or clears the selection;
    - drag: moves it to another zone;
    - Enter or Space: picks it up; ↑ ↓ ← → choose the zone; Enter or Space drops it;
      Escape cancels.
  While it is moved with the keyboard it carries `data-grabbed`.
-->
<script lang="ts">
  import { useDragBoard } from "$lib/internal/drag-board";
  import { cn } from "$lib/utils";

  interface Props {
    id: string;
    /** Name of the item in the board's announcements. */
    label: string;
    /** Id of the DropZone it is in now. */
    zone: string;
    disabled?: boolean;
    title?: string;
    class?: string;
    children?: import("svelte").Snippet;
    /** Other attributes (data-*, aria-label…) go to the element. */
    [key: string]: unknown;
  }

  const {
    id,
    label,
    zone,
    disabled = false,
    title,
    class: className = "",
    children,
    ...rest
  }: Props = $props();

  const board = useDragBoard();
  const ref = $derived({ id, label, zone });
  const isSelected = $derived(board.selected === id);
  const grabbed = $derived(isSelected && board.target !== null);

  function onKey(e: KeyboardEvent) {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      board.press(ref);
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      if (board.step(ref, 1)) e.preventDefault();
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      if (board.step(ref, -1)) e.preventDefault();
    } else if (e.key === "Escape") {
      // It only keeps it if there was something to cancel: otherwise, Escape goes on its way.
      if (isSelected && board.cancel()) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }
</script>

<div
  {...rest}
  role="button"
  tabindex={disabled ? -1 : 0}
  aria-pressed={isSelected}
  aria-disabled={disabled ? "true" : undefined}
  aria-describedby={board.instructionsId}
  draggable={!disabled}
  {title}
  class={cn("ta-drag-item", isSelected && "ta-drag-item--grabbed", className)}
  data-ta-drag-item={id}
  data-grabbed={grabbed ? "true" : undefined}
  onclick={() => !disabled && board.toggle(ref)}
  onkeydown={onKey}
  onblur={() => board.leave(ref)}
  ondragstart={(e) => (disabled ? e.preventDefault() : board.dragStart(ref, e))}
  ondragend={() => board.dragEnd()}
>
  {@render children?.()}
</div>

<style>
  .ta-drag-item {
    cursor: grab;
    outline: none;
    border-radius: var(--ta-radius-sm);
  }

  .ta-drag-item:focus-visible {
    box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.6);
  }

  .ta-drag-item--grabbed {
    box-shadow: 0 0 0 1px rgb(var(--ta-accent));
  }

  .ta-drag-item[data-grabbed] {
    box-shadow: 0 0 0 2px rgb(var(--ta-accent));
    cursor: grabbing;
  }

  .ta-drag-item[aria-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
  }
  @media (pointer: coarse) {
    .ta-drag-item { display: block; min-height: 2.75rem; }
  }
</style>
