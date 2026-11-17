<!--
  tallao — Table
  Table container with a rounded border and safe horizontal scrolling.
    - `density="compact"`: less padding and smaller text, headers not uppercased; for matrices
      with many narrow columns (a type chart, a damage-per-level table).
    - `stickyFirstColumn`: the first column (header and body) stays fixed when scrolling
      horizontally, with an opaque background. The background comes from `--ta-table-sticky-bg`
      (the surface by default): if the table sits on another color, change that variable.
  Both apply from here to this table's cells (TableHead, TableCell or plain <th>/<td>),
  not to those of a nested table.
-->
<script lang="ts">
  import { cn } from "$lib/utils";
  interface Props {
    class?: string;
    density?: "default" | "compact";
    stickyFirstColumn?: boolean;
    children?: import("svelte").Snippet;
    /** Any other attribute (aria-label, aria-describedby, id, style…) goes to the <table>. */
    [key: string]: unknown;
  }
  const { class: className = "", density = "default", stickyFirstColumn = false, children, ...rest }: Props = $props();
</script>

<div class="ta-table-container">
  <table
    {...rest}
    class={cn(
      "ta-table",
      density === "compact" && "ta-table--compact",
      stickyFirstColumn && "ta-table--sticky-column",
      className
    )}
  >
    {@render children?.()}
  </table>
</div>

<style>
  .ta-table-container {
    width: 100%;
    overflow-x: auto;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
  }

  .ta-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  /* — Compact — */
  .ta-table--compact {
    font-size: 0.8125rem;
  }
  .ta-table--compact > :global(* > tr > :is(th, td)) {
    padding: 0.25rem 0.375rem;
  }
  .ta-table--compact > :global(* > tr > th) {
    font-size: 0.6875rem;
    text-transform: none;
    letter-spacing: normal;
  }
  .ta-table--compact > :global(thead > tr > th) {
    padding-block: 0.375rem;
  }

  /* — Sticky first column —
     With collapsed borders a sticky cell's border stays where it was when scrolling:
     the table switches to separate borders and each row's rule is carried by its cells. */
  .ta-table--sticky-column {
    border-collapse: separate;
    border-spacing: 0;
  }
  .ta-table--sticky-column > :global(tbody > tr:not(:last-child) > :is(th, td)) {
    border-bottom: 1px solid rgb(var(--ta-border));
  }
  .ta-table--sticky-column > :global(* > tr > :is(th, td):first-child) {
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--ta-table-sticky-bg, rgb(var(--ta-surface)));
    box-shadow: inset -1px 0 0 rgb(var(--ta-border));
  }
  /* The header tint and the row hover tint, on top of the opaque background. */
  .ta-table--sticky-column > :global(thead > tr > :is(th, td):first-child) {
    background:
      linear-gradient(rgb(var(--ta-elevated) / 0.4), rgb(var(--ta-elevated) / 0.4)),
      var(--ta-table-sticky-bg, rgb(var(--ta-surface)));
  }
  .ta-table--sticky-column > :global(tbody > tr:hover > :is(th, td):first-child) {
    background:
      linear-gradient(rgb(var(--ta-elevated) / 0.35), rgb(var(--ta-elevated) / 0.35)),
      var(--ta-table-sticky-bg, rgb(var(--ta-surface)));
  }
</style>
