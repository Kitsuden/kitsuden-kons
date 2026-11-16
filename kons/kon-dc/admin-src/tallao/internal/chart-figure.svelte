<!--
  tallao — ChartFigure (internal)
  What every chart of the kit has around its drawing: a `<figure>` named by its title
  (`hideTitle` keeps it for screen readers only, for a chart inside a ChartCard that already
  shows it), the legend, a labelled empty state instead of an empty axis, and the
  "Show data" button that opens the table with every value, so nothing depends on colour
  or on the pointer. It also carries the styles the drawings share (grid, axes, tooltip).
-->
<script lang="ts" module>
  export interface ChartTable {
    columns: { label: string; numeric?: boolean }[];
    rows: string[][];
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";

  import ChartLegend, { type ChartLegendItem } from "$lib/components/chart-legend.svelte";
  import Table from "$lib/components/table.svelte";
  import TableBody from "$lib/components/table-body.svelte";
  import TableCell from "$lib/components/table-cell.svelte";
  import TableHead from "$lib/components/table-head.svelte";
  import TableHeader from "$lib/components/table-header.svelte";
  import TableRow from "$lib/components/table-row.svelte";
  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  const L = useLabels();
  const {
    title,
    hideTitle = false,
    legend,
    legendMarker = "square",
    empty = false,
    emptyText = L.noData,
    table,
    showDataLabel = L.showData,
    hideDataLabel = L.hideData,
    class: className = "",
    children,
  }: {
    title: string;
    hideTitle?: boolean;
    legend?: ChartLegendItem[];
    legendMarker?: "square" | "line" | "dot";
    empty?: boolean;
    emptyText?: string;
    table?: ChartTable;
    showDataLabel?: string;
    hideDataLabel?: string;
    class?: string;
    children?: Snippet;
  } = $props();

  const id = $props.id();
  let showTable = $state(false);
</script>

<figure class={cn("ta-chart", className)}>
  <figcaption class={cn("ta-chart-title", hideTitle && "ta-chart-hidden")}>{title}</figcaption>
  {#if empty}
    <p class="ta-chart-empty">{emptyText}</p>
  {:else}
    {#if legend?.length}<ChartLegend items={legend} marker={legendMarker} />{/if}
    {@render children?.()}
    {#if table}
      <button type="button" class="ta-chart-data" aria-expanded={showTable} aria-controls={`${id}-table`} onclick={() => (showTable = !showTable)}>
        {showTable ? hideDataLabel : showDataLabel}
      </button>
      {#if showTable}
        <div id={`${id}-table`}>
          <Table>
            <caption class="ta-chart-hidden">{title}</caption>
            <TableHeader>
              <TableRow>
                {#each table.columns as column, i (i)}
                  <TableHead style={column.numeric ? "text-align: right" : undefined}>{column.label}</TableHead>
                {/each}
              </TableRow>
            </TableHeader>
            <TableBody>
              {#each table.rows as row, r (r)}
                <TableRow>
                  {#each row as cell, c (c)}
                    <TableCell class={table.columns[c]?.numeric ? "ta-chart-num" : ""}>{cell}</TableCell>
                  {/each}
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        </div>
      {/if}
    {/if}
  {/if}
</figure>

<style>
  .ta-chart { margin: 0; display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; color: rgb(var(--ta-text)); }
  .ta-chart-title { font-size: 0.875rem; font-weight: 600; }

  .ta-chart-empty {
    margin: 0;
    padding: 2rem 1rem;
    text-align: center;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
    border: 1px dashed rgb(var(--ta-border));
    border-radius: var(--ta-radius);
  }

  /* The drawing: shared by the charts that render inside this figure. */
  .ta-chart :global(.ta-chart-canvas) { position: relative; width: 100%; outline: none; border-radius: var(--ta-radius-sm); touch-action: pan-y; }
  .ta-chart :global(.ta-chart-canvas:focus-visible) { box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.6); }
  .ta-chart :global(.ta-chart-svg) { display: block; overflow: visible; }
  .ta-chart :global(.ta-chart-grid) { stroke: rgb(var(--ta-border)); stroke-width: 1; shape-rendering: crispEdges; }
  .ta-chart :global(.ta-chart-base) { stroke: rgb(var(--ta-muted)); stroke-width: 1; shape-rendering: crispEdges; }
  .ta-chart :global(.ta-chart-ref) { stroke: rgb(var(--ta-subtle)); stroke-width: 1; stroke-dasharray: 4 3; }
  .ta-chart :global(.ta-chart-axis) { fill: rgb(var(--ta-text-dim)); font-size: 11px; font-variant-numeric: tabular-nums; }
  .ta-chart :global(.ta-chart-crosshair) { stroke: rgb(var(--ta-muted)); stroke-width: 1; }
  /* Ring in the surface color: the point stays readable even where it crosses another mark. */
  .ta-chart :global(.ta-chart-dot) { stroke: rgb(var(--ta-surface)); stroke-width: 2; }

  .ta-chart :global(.ta-chart-tooltip) {
    position: absolute;
    top: 0;
    z-index: 1;
    width: 160px;
    padding: 0.5rem 0.625rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    box-shadow: 0 8px 24px -8px rgb(0 0 0 / 0.5);
    pointer-events: none;
  }
  .ta-chart :global(.ta-chart-tooltip-x) { color: rgb(var(--ta-text-dim)); }
  .ta-chart :global(.ta-chart-tooltip-row) { display: flex; align-items: center; gap: 0.375rem; }
  .ta-chart :global(.ta-chart-tooltip-row strong) { font-variant-numeric: tabular-nums; }
  .ta-chart :global(.ta-chart-tooltip-row span:last-child) { color: rgb(var(--ta-text-dim)); }
  .ta-chart :global(.ta-chart-key) { width: 0.625rem; height: 0.625rem; border-radius: 2px; flex-shrink: 0; }
  .ta-chart :global(.ta-chart-line) { width: 0.875rem; height: 2px; border-radius: 1px; flex-shrink: 0; }

  .ta-chart-data {
    align-self: flex-start;
    padding: 0.125rem 0;
    font: inherit;
    font-size: 0.75rem;
    /* The accent pulled towards the text colour: readable on the dark and the light surface. */
    color: color-mix(in srgb, rgb(var(--ta-accent)) 65%, rgb(var(--ta-text)));
    background: none;
    border: none;
    cursor: pointer;
  }
  .ta-chart-data:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; }
  .ta-chart :global(.ta-chart-num) { text-align: right; font-variant-numeric: tabular-nums; }

  .ta-chart-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

  @media (pointer: coarse) {
    .ta-chart-data { position: relative; }
    .ta-chart-data::after { content: ""; position: absolute; top: 50%; left: 50%; width: max(100%, 2.75rem); height: max(100%, 2.75rem); transform: translate(-50%, -50%); }
  }
</style>
