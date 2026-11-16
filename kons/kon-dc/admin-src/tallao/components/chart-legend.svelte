<!--
  tallao — ChartLegend
  The key of a chart: one entry per series with its mark, its label and, optionally, its
  value in text. Every chart of the kit draws its legend with it; use it on its own for a
  hand-made chart or to share one legend between several charts.
  A plain list (`<ul>`): the marks are decorative, the labels and values are the content.
  `items` is `[{ "label": "Fire", "value": "32%" }, …]`; colours follow the series tokens
  by position unless an item brings its own `color` (any CSS colour).
-->
<script lang="ts" module>
  import type { PointShape } from "$lib/internal/chart";

  export interface ChartLegendItem {
    label: string;
    /** The figure next to the label ("1,240 · 32%"). */
    value?: string;
    /** Any CSS colour; by default the series colour of its position. */
    color?: string;
    /** Mark of this entry when it differs from the legend's `marker`. */
    shape?: PointShape;
  }
</script>

<script lang="ts">
  import { seriesColor } from "$lib/internal/chart";
  import { cn } from "$lib/utils";

  interface Props {
    items: ChartLegendItem[];
    /** Shape of the marks: a square (bars, slices), a line (lines) or a dot. */
    marker?: "square" | "line" | "dot";
    /** In a row that wraps, or one entry per line with the values aligned to the right. */
    orientation?: "horizontal" | "vertical";
    class?: string;
    /** Any other attribute (aria-label, data-*…) goes to the `<ul>`. */
    [key: string]: unknown;
  }

  const { items, marker = "square", orientation = "horizontal", class: className = "", ...rest }: Props = $props();
</script>

<ul {...rest} class={cn("ta-legend", `ta-legend--${orientation}`, className)}>
  {#each items as item, i (i)}
    <li class="ta-legend-item">
      <span
        class={cn("ta-legend-mark", `ta-legend-mark--${item.shape ?? marker}`)}
        style:background={item.color ?? seriesColor(i)}
        aria-hidden="true"
      ></span>
      <span class="ta-legend-label">{item.label}</span>
      {#if item.value != null}<span class="ta-legend-value">{item.value}</span>{/if}
    </li>
  {/each}
</ul>

<style>
  .ta-legend { display: flex; flex-wrap: wrap; gap: 0.375rem 0.875rem; margin: 0; padding: 0; list-style: none; font-size: 0.75rem; color: rgb(var(--ta-text-dim)); min-width: 0; }
  .ta-legend--vertical { flex-direction: column; flex-wrap: nowrap; gap: 0.375rem; }
  .ta-legend-item { display: flex; align-items: center; gap: 0.375rem; min-width: 0; }
  .ta-legend-label { min-width: 0; overflow-wrap: anywhere; }
  .ta-legend-value { color: rgb(var(--ta-text)); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ta-legend--vertical .ta-legend-value { margin-left: auto; padding-left: 0.75rem; }

  .ta-legend-mark { flex-shrink: 0; width: 0.625rem; height: 0.625rem; border-radius: 2px; }
  .ta-legend-mark--line { width: 0.875rem; height: 2px; border-radius: 1px; }
  .ta-legend-mark--dot,
  .ta-legend-mark--circle { border-radius: 9999px; }
  .ta-legend-mark--triangle { border-radius: 0; clip-path: polygon(50% 0, 100% 100%, 0 100%); }
  .ta-legend-mark--diamond { border-radius: 0; clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
</style>
