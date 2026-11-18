<!--
  tallao — Sparkline
  A trend in the space of a word: a line (optionally filled) or small columns, with no axes,
  for a table cell, a KpiCard or a sentence. An image (`role="img"`) whose name says what
  the picture shows: "Pick rate: from 12 to 18, low 9, high 18". The last point is marked.
  Fixed size, the same on the server; with fewer than two numbers it draws a flat dash and
  says "No data".
  `data` is a plain array of numbers in order: `[12, 9, 11, 14, 18]` (anything that is not
  a finite number is skipped).
-->
<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { compactNumber, fill, finite } from "$lib/internal/chart";
  import { cn } from "$lib/utils";

  const L = useLabels();

  interface Props {
    data: number[];
    /** What the trend measures: the start of its accessible name. */
    label: string;
    width?: number;
    height?: number;
    /** A line, or one small column per value. */
    variant?: "line" | "bar";
    /** Soft fill under the line. */
    area?: boolean;
    /** Any CSS colour; by default the first series colour. */
    color?: string;
    locale?: string;
    /** Format of the figures in the accessible name. */
    format?: (n: number) => string;
    /** Full accessible name, instead of the generated summary. */
    ariaLabel?: string;
    class?: string;
    /** Any other attribute goes to the `<svg>`. */
    [key: string]: unknown;
  }

  const {
    data,
    label,
    width = 96,
    height = 28,
    variant = "line",
    area = false,
    color,
    locale,
    format = (n: number) => compactNumber(n, locale),
    ariaLabel,
    class: className = "",
    ...rest
  }: Props = $props();

  const values = $derived(data.map(finite).filter((v): v is number => v != null));
  const min = $derived(Math.min(...values));
  const max = $derived(Math.max(...values));
  const usable = $derived(values.length >= 2);

  const PAD = 4;
  const xOf = (i: number) => PAD + (i / Math.max(1, values.length - 1)) * (width - PAD * 2);
  const yOf = (v: number) => (max === min ? height / 2 : height - PAD - ((v - min) / (max - min)) * (height - PAD * 2));
  const line = $derived(values.map((v, i) => `${i ? "L" : "M"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(""));
  const slot = $derived((width - PAD * 2) / Math.max(1, values.length));

  const name = $derived(
    ariaLabel ??
      (usable
        ? `${label}: ${fill(L.trendSummary, { first: format(values[0]), last: format(values.at(-1)!), min: format(min), max: format(max) })}`
        : `${label}: ${L.noData}`)
  );
</script>

<svg
  {...rest}
  class={cn("ta-sparkline", className)}
  {width}
  {height}
  viewBox={`0 0 ${width} ${height}`}
  role="img"
  aria-label={name}
  style:--ta-sparkline-color={color}
>
  {#if !usable}
    <line x1={PAD} x2={width - PAD} y1={height / 2} y2={height / 2} class="ta-sparkline-none" />
  {:else if variant === "bar"}
    {#each values as v, i (i)}
      {@const top = max === min ? height / 2 : Math.min(height - PAD - 2, yOf(v))}
      <rect
        x={PAD + slot * i + 0.5}
        y={top}
        width={Math.max(1, slot - 1)}
        height={height - PAD - top}
        rx="1"
        class="ta-sparkline-bar"
        class:ta-sparkline-bar--last={i === values.length - 1}
      />
    {/each}
  {:else}
    {#if area}<path d={`${line}L${xOf(values.length - 1).toFixed(1)},${height}L${xOf(0).toFixed(1)},${height}Z`} class="ta-sparkline-area" />{/if}
    <path d={line} class="ta-sparkline-line" />
    <circle cx={xOf(values.length - 1)} cy={yOf(values.at(-1)!)} r="2.5" class="ta-sparkline-end" />
  {/if}
</svg>

<style>
  .ta-sparkline { display: inline-block; flex-shrink: 0; vertical-align: middle; overflow: visible; max-width: 100%; --ta-sparkline-ink: var(--ta-sparkline-color, rgb(var(--ta-series-1))); }
  .ta-sparkline-line { fill: none; stroke: var(--ta-sparkline-ink); stroke-width: 1.75; stroke-linejoin: round; stroke-linecap: round; }
  .ta-sparkline-area { fill: var(--ta-sparkline-ink); opacity: 0.14; }
  .ta-sparkline-end { fill: var(--ta-sparkline-ink); stroke: rgb(var(--ta-surface)); stroke-width: 1.5; }
  .ta-sparkline-bar { fill: var(--ta-sparkline-ink); opacity: 0.5; }
  .ta-sparkline-bar--last { opacity: 1; }
  .ta-sparkline-none { stroke: rgb(var(--ta-muted)); stroke-width: 1.5; stroke-dasharray: 3 3; }
</style>
