<!--
  tallao — BarChart
  Bars per category, one or several series: grouped side by side or `stacked`, as columns
  or as horizontal bars (`orientation="horizontal"`, for long category names and phones).
  Follows the kit's brand rules: bars 24px thick at most (32px stacked), rounded data end
  (4px) and a straight base, 2px between neighbours, thin and discreet grid and axes, a
  single scale that starts at zero.
  - With two or more series there is a legend; with one, the title says what is measured.
  - Hovering or stepping with the arrows (the chart takes focus; Home / End / Escape too)
    shows the category with each series' value, and the total when stacked; a screen
    reader hears it.
  - "Show data" opens the table with every value: nothing is conveyed by color alone.
  - With no rows it shows a labelled empty state (`emptyText`) instead of an empty axis.
  `data` is rows, plain JSON: `[{ "month": "Jan", "visits": 120, "signups": 30 }, …]`,
  with `x="month"` and `series=[{ "key": "visits", "label": "Visits" }, …]`. A value that
  is not a finite number counts as missing.
-->
<script lang="ts">
  import ChartFigure from "$lib/internal/chart-figure.svelte";
  import { useLabels } from "$lib/i18n";
  import { compactNumber, niceScale, seriesColor, valueOf, type ChartSeries } from "$lib/internal/chart";

  const L = useLabels();
  const {
    data,
    x,
    series,
    title,
    hideTitle = false,
    /** Header of the first column of the data table (defaults to `x`). */
    xLabel,
    height,
    orientation = "vertical",
    stacked = false,
    locale,
    format = (n: number) => compactNumber(n, locale),
    emptyText = L.noData,
    totalLabel = L.total,
    showDataLabel = L.showData,
    hideDataLabel = L.hideData,
    class: className = "",
  }: {
    data: Record<string, unknown>[];
    x: string;
    series: ChartSeries[];
    /** What the chart shows: its accessible name and the figure caption. */
    title: string;
    /** Keeps the title for screen readers only (inside a ChartCard that already shows it). */
    hideTitle?: boolean;
    xLabel?: string;
    /** Height in px: 240 for columns; horizontal bars grow with the number of rows. */
    height?: number;
    /** Columns (`vertical`) or bars that run left to right (`horizontal`). */
    orientation?: "vertical" | "horizontal";
    /** One bar per category with the series piled up, instead of side by side. */
    stacked?: boolean;
    locale?: string;
    /** Format of the values on axes, tooltip and table. */
    format?: (n: number) => string;
    /** Text shown when `data` is empty. */
    emptyText?: string;
    /** Name of the sum of a stacked bar, in the tooltip and the table. */
    totalLabel?: string;
    showDataLabel?: string;
    hideDataLabel?: string;
    class?: string;
  } = $props();

  let chartWidth = $state(640);
  let active = $state<number | null>(null);
  let canvas: HTMLElement | undefined = $state();

  const horizontal = $derived(orientation === "horizontal");
  const category = (i: number) => String(data[i]?.[x] ?? "");
  const piles = $derived(stacked && series.length > 1);
  const lanes = $derived(piles ? 1 : Math.max(1, series.length));

  // Horizontal bars keep room on the left for the category names (40% of the width at most).
  const labelWidth = $derived(Math.min(chartWidth * 0.4, Math.max(40, Math.max(0, ...data.map((_, i) => category(i).length)) * 6.5 + 14)));
  const M = $derived(horizontal ? { top: 6, right: 20, bottom: 24, left: labelWidth } : { top: 12, right: 8, bottom: 26, left: 48 });
  const fullHeight = $derived(height ?? (horizontal ? data.length * Math.max(30, lanes * 16 + 12) + 30 : 240));
  const plotWidth = $derived(Math.max(40, chartWidth - M.left - M.right));
  const plotHeight = $derived(Math.max(40, fullHeight - M.top - M.bottom));

  const positive = (row: Record<string, unknown>, key: string) => Math.max(0, valueOf(row, key) ?? 0);
  const totalOf = (row: Record<string, unknown>) => series.reduce((sum, s) => sum + positive(row, s.key), 0);
  const maxValue = $derived(Math.max(0, ...data.map((d) => (piles ? totalOf(d) : Math.max(0, ...series.map((s) => positive(d, s.key)))))));
  const scale = $derived(niceScale(maxValue, horizontal ? Math.max(2, Math.min(4, Math.floor(plotWidth / 70))) : 4));

  /** Position of a value along the value axis (y for columns, x for horizontal bars). */
  const at = (v: number) => (horizontal ? M.left + (v / scale.max) * plotWidth : M.top + plotHeight - (v / scale.max) * plotHeight);

  const band = $derived((horizontal ? plotHeight : plotWidth) / Math.max(1, data.length));
  const thick = $derived(Math.min(piles ? 32 : horizontal ? 20 : 24, Math.max(2, (band * 0.7 - (lanes - 1) * 2) / lanes)));
  const groupSize = $derived(lanes * thick + (lanes - 1) * 2);
  const bandStart = (i: number) => (horizontal ? M.top : M.left) + band * i;
  // With many categories, only one in every `labelStep` is labelled on the axis.
  const labelStep = $derived(horizontal ? 1 : Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotWidth / 56)))));
  const maxChars = $derived(Math.max(3, Math.floor((labelWidth - 14) / 6.5)));
  const clip = (text: string) => (text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text);

  /** A bar from value `from` to `to`, `lane` px into its band; `cap` rounds the data end. */
  function bar(lane: number, from: number, to: number, cap: boolean) {
    const a = at(from);
    const b = at(to);
    const length = Math.abs(b - a);
    if (length <= 0) return "";
    const r = cap ? Math.min(4, length, thick / 2) : 0;
    // 1px off the start of a piled segment keeps the neighbours apart.
    const gap = from > 0 ? Math.min(1, length / 2) : 0;
    if (horizontal) {
      const s = a + gap;
      return `M${s},${lane}H${b - r}Q${b},${lane} ${b},${lane + r}V${lane + thick - r}Q${b},${lane + thick} ${b - r},${lane + thick}H${s}Z`;
    }
    const s = a - gap;
    return `M${lane},${s}V${b + r}Q${lane},${b} ${lane + r},${b}H${lane + thick - r}Q${lane + thick},${b} ${lane + thick},${b + r}V${s}Z`;
  }

  const bars = $derived(
    data.map((row, i) => {
      const start = bandStart(i) + (band - groupSize) / 2;
      let pile = 0;
      let last = -1;
      series.forEach((s, si) => {
        if (positive(row, s.key) > 0) last = si;
      });
      return series.map((s, si) => {
        const v = positive(row, s.key);
        const from = piles ? pile : 0;
        pile += v;
        return v > 0 ? bar(start + (piles ? 0 : si * (thick + 2)), from, from + v, !piles || si === last) : "";
      });
    })
  );

  const fmt = (v: number | null) => (v == null ? "—" : format(v));
  const readout = $derived(
    active == null || !data[active]
      ? ""
      : `${category(active)}: ${series.map((s) => `${s.label} ${fmt(valueOf(data[active!], s.key))}`).join(", ")}${piles ? `, ${totalLabel} ${format(totalOf(data[active]))}` : ""}`
  );

  const table = $derived({
    columns: [{ label: xLabel ?? x }, ...series.map((s) => ({ label: s.label, numeric: true })), ...(piles ? [{ label: totalLabel, numeric: true }] : [])],
    rows: data.map((row, i) => [category(i), ...series.map((s) => fmt(valueOf(row, s.key))), ...(piles ? [format(totalOf(row))] : [])]),
  });

  // The area that responds to the pointer is each category's whole band, not just the bar.
  function onMove(e: PointerEvent) {
    if (!canvas || data.length === 0) return;
    const r = canvas.getBoundingClientRect();
    const p = horizontal ? ((e.clientY - r.top) / r.height) * fullHeight - M.top : ((e.clientX - r.left) / r.width) * chartWidth - M.left;
    active = Math.min(data.length - 1, Math.max(0, Math.floor(p / band)));
  }

  function onKey(e: KeyboardEvent) {
    if (!data.length) return;
    const next = horizontal ? ["ArrowDown", "ArrowRight"] : ["ArrowRight", "ArrowUp"];
    const previous = horizontal ? ["ArrowUp", "ArrowLeft"] : ["ArrowLeft", "ArrowDown"];
    if (next.includes(e.key)) active = active == null ? 0 : Math.min(data.length - 1, active + 1);
    else if (previous.includes(e.key)) active = active == null ? data.length - 1 : Math.max(0, active - 1);
    else if (e.key === "Home") active = 0;
    else if (e.key === "End") active = data.length - 1;
    else if (e.key === "Escape") active = null;
    else return;
    e.preventDefault();
  }

  const tooltipLeft = $derived(
    active == null
      ? 0
      : horizontal
        ? Math.min(Math.max(0, chartWidth - 160), Math.max(0, M.left + plotWidth / 2 - 80))
        : Math.min(Math.max(0, chartWidth - 160), Math.max(0, bandStart(active) + band / 2 - 80))
  );
</script>

<ChartFigure
  {title}
  {hideTitle}
  legend={series.length > 1 ? series.map((s) => ({ label: s.label })) : undefined}
  empty={data.length === 0}
  {emptyText}
  {table}
  {showDataLabel}
  {hideDataLabel}
  class={className}
>
  <!-- A slider over the categories: the arrows step through the data and aria-valuetext reads it. -->
  <div
    class="ta-chart-canvas"
    bind:clientWidth={chartWidth}
    bind:this={canvas}
    role="slider"
    tabindex="0"
    aria-label={title}
    aria-orientation={horizontal ? "vertical" : "horizontal"}
    aria-valuemin={0}
    aria-valuemax={Math.max(0, data.length - 1)}
    aria-valuenow={active ?? 0}
    aria-valuetext={readout || title}
    onkeydown={onKey}
    onfocus={() => (active ??= data.length ? 0 : null)}
    onblur={() => (active = null)}
    onpointermove={onMove}
    onpointerleave={() => (active = null)}
  >
    <svg width="100%" height={fullHeight} viewBox={`0 0 ${chartWidth} ${fullHeight}`} class="ta-chart-svg" aria-hidden="true">
      {#each scale.ticks as t (t)}
        {#if horizontal}
          <line x1={at(t)} x2={at(t)} y1={M.top} y2={M.top + plotHeight} class={t === 0 ? "ta-chart-base" : "ta-chart-grid"} />
          <text x={at(t)} y={fullHeight - 8} class="ta-chart-axis" text-anchor="middle">{format(t)}</text>
        {:else}
          <line x1={M.left} x2={M.left + plotWidth} y1={at(t)} y2={at(t)} class={t === 0 ? "ta-chart-base" : "ta-chart-grid"} />
          <text x={M.left - 8} y={at(t)} class="ta-chart-axis" text-anchor="end" dominant-baseline="middle">{format(t)}</text>
        {/if}
      {/each}

      {#each data as _, i (i)}
        <g class="ta-chart-group" class:ta-chart-group--active={active === i}>
          {#if horizontal && active === i}
            <rect x={M.left} y={bandStart(i)} width={plotWidth} height={band} class="ta-chart-band" />
          {/if}
          {#each series as s, si (s.key)}
            {#if bars[i]?.[si]}<path d={bars[i][si]} fill={seriesColor(si)} />{/if}
          {/each}
          {#if horizontal}
            <text x={M.left - 8} y={bandStart(i) + band / 2} class="ta-chart-axis ta-chart-category" text-anchor="end" dominant-baseline="middle">{clip(category(i))}</text>
          {:else if i % labelStep === 0}
            <text x={bandStart(i) + band / 2} y={fullHeight - 8} class="ta-chart-axis" text-anchor="middle">{category(i)}</text>
          {/if}
        </g>
      {/each}
    </svg>

    {#if active != null && data[active]}
      <div
        class="ta-chart-tooltip"
        style:left={`${tooltipLeft}px`}
        style:top={horizontal ? `${Math.max(0, bandStart(active) + band)}px` : undefined}
        aria-hidden="true"
      >
        <span class="ta-chart-tooltip-x">{category(active)}</span>
        {#each series as s, si (s.key)}
          <span class="ta-chart-tooltip-row">
            <span class="ta-chart-key" style:background={seriesColor(si)}></span>
            <strong>{fmt(valueOf(data[active], s.key))}</strong>
            <span>{s.label}</span>
          </span>
        {/each}
        {#if piles}
          <span class="ta-chart-tooltip-row ta-chart-tooltip-total">
            <strong>{format(totalOf(data[active]))}</strong>
            <span>{totalLabel}</span>
          </span>
        {/if}
      </div>
    {/if}
  </div>
</ChartFigure>

<style>
  .ta-chart-group--active path { filter: brightness(1.15); }
  .ta-chart-band { fill: rgb(var(--ta-elevated) / 0.6); }
  .ta-chart-category { fill: rgb(var(--ta-text)); font-size: 12px; }
  .ta-chart-tooltip-total { margin-top: 0.125rem; padding-top: 0.25rem; border-top: 1px solid rgb(var(--ta-border)); }

  @media (pointer: coarse) {
    /* The chart itself is the control: tall enough to step through with a finger. */
    .ta-chart-canvas { min-height: 2.75rem; }
  }
</style>
