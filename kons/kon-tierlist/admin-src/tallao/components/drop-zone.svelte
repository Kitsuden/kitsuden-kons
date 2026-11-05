<!--
  tallao — DropZone
  A zone of a DragBoard where items land: with the mouse when dropped on it,
  with the keyboard when the arrows choose it. `label` is its accessible name and
  the one heard in the announcements ("Ganyu over S"). While it is the target it
  carries `data-over`, so whoever renders it can mark the whole zone and not just part.
  It only accepts items from its own board: dropping a file on it does nothing.
-->
<script lang="ts">
  import { useDragBoard } from "$lib/internal/drag-board";
  import { cn } from "$lib/utils";

  interface Props {
    id: string;
    /** Accessible name of the zone. */
    label: string;
    class?: string;
    children?: import("svelte").Snippet;
    /** Other attributes (data-*, style…) go to the element. */
    [key: string]: unknown;
  }

  const { id, label, class: className = "", children, ...rest }: Props = $props();

  const board = useDragBoard();

  /** dragenter/dragleave also fire when passing over children: they are counted. */
  let enterCount = $state(0);

  const isOver = $derived((board.dragging !== null && enterCount > 0) || board.target === id);

  $effect(() => {
    if (board.dragging === null) enterCount = 0;
  });

  function onDragEnter(e: DragEvent) {
    if (!board.dragging) return;
    e.preventDefault();
    enterCount++;
  }

  function onDragOver(e: DragEvent) {
    if (!board.dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  }

  function onDrop(e: DragEvent) {
    if (!board.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    enterCount = 0;
    board.drop(id);
  }
</script>

<div
  {...rest}
  role="group"
  aria-label={label}
  class={cn("ta-drop-zone", isOver && "ta-drop-zone--over", className)}
  data-ta-drop-zone={id}
  data-over={isOver ? "true" : undefined}
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={() => (enterCount = Math.max(0, enterCount - 1))}
  ondrop={onDrop}
>
  {@render children?.()}
</div>

<style>
  .ta-drop-zone {
    border-radius: var(--ta-radius);
    transition: box-shadow 0.15s;
  }

  .ta-drop-zone--over {
    box-shadow: inset 0 0 0 2px rgb(var(--ta-accent));
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-drop-zone { transition: none; }
  }
</style>
