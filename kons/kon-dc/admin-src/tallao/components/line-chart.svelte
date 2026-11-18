<!--
  tallao — LineChart
  Change over time: one line per series (2px), end point with a ring in the surface
  color, optional very soft fill (`area`), a single scale. `stacked` piles the series up
  as an area chart (each band is one series, the top edge is the total).
  - With two or more series there is a legend; with one, the title says what is measured.
  - A vertical line follows the pointer and snaps to the nearest point; the tooltip
    lists every series at that point. With focus on the chart, ← → (Home / End / Escape)
    do the same and a screen reader hears it.
  - "Show data" opens the table with every value.
  - The scale starts at zero; `domain={[45, 55]}` narrows it for values that live far from
    zero (a win rate). With no rows it shows a labelled empty state (`emptyText`).
  `data` is rows in order, plain JSON: `[{ "day": "Nov 1", "visits": 120 }, …]`, with
  `x="day"` and `series=[{ "key": "visits", "label": "Visits" }]`. A value that is not a
  finite number is a gap in the line (it counts as zero when stacked).
-->
<script lang="ts">
  import ChartFigure from "$lib/internal/chart-figure.svelte";
  import { useLabels } from "$lib/i18n";
  import { compactNumber, niceDomain, niceScale, seriesColor, valueOf, type ChartSeries } from "$lib/internal/chart";

  const L = useLabels();
  const {
    data,
    x,
    series,
    title,
    hideTitle = false,
    xLabel,
    height = 240,
    area = false,
    stacked = false,
    domain,
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
    title: string;
    /** Keeps the title for screen readers only (inside a ChartCard that already shows it). */
    hideTitle?: boolean;
    xLabel?: string;
    height?: number;
    /** Fill under the line, at 10% of the series color. */
    area?: boolean;
    /** Stacked areas: every series is drawn on top of the previous ones. */
    stacked?: boolean;
    /** Lower and upper bound of the scale, instead of zero to the maximum (ignored when stacked). */
    domain?: [number, number];
    locale?: string;
    format?: (n: number) => string;
    /** Text shown when `data` is empty. */
    emptyText?: string;
    /** Name of the sum of the series when stacked, in the tooltip and the table. */
    totalLabel?: string;
    showDataLabel?: string;
    hideDataLabel?: string;
    class?: string;
  } = $props();

  let chartWidth = $state(640);
  let active = $state<number | null>(null);
  let canvas: HTMLElement | undefined = $state();

  const M = { top: 12, right: 12, bottom: 26, left: 48 };
  const plotWidth = $derived(Math.max(40, chartWidth - M.left - M.right));
  const plotHeight = $derived(Math.max(40, height - M.top - M.bottom));
  const piles = $derived(stacked && series.length > 1);

  const totalOf = (row: Record<string, unknown>) => series.reduce((sum, s) => sum + Math.max(0, valueOf(row, s.key) ?? 0), 0);
  /** What is drawn for series `si` in row `i`: its value, or the running sum when stacked. */
  function drawn(i: number, si: number): number | null {
    if (!piles) return valueOf(data[i], series[si].key);
    let sum = 0;
    for (let k = 0; k <= si; k++) sum += Math.max(0, valueOf(data[i], series[k].key) ?? 0);
    return sum;
  }

  const maxValue = $derived(Math.max(0, ...data.map((d) => (piles ? totalOf(d) : Math.max(0, ...series.map((s) => valueOf(d, s.key) ?? 0))))));
  const scale = $derived(domain && !piles ? niceDomain(domain[0], domain[1]) : { min: 0, ...niceScale(maxValue) });
  const yOf = (v: number) => M.top + plotHeight - ((Math.min(scale.max, Math.max(scale.min, v)) - scale.min) / (scale.max - scale.min)) * plotHeight;
  const xOf = (i: number) => M.left + (data.length <= 1 ? plotWidth / 2 : (i / (data.length - 1)) * plotWidth);
  const labelStep = $derived(Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotWidth / 64)))));

  /** A series' path; a gap (missing value) breaks the line instead of inventing a zero. */
  function linePath(si: number) {
    let d = "";
    let open = false;
    data.forEach((_, i) => {
      const v = drawn(i, si);
      if (v == null) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${xOf(i)},${yOf(v)}`;
      open = true;
    });
    return d;
  }

  /** The fill: down to the base line, or down to the series below when stacked. */
  function areaPath(si: number) {
    const points = data.map((_, i) => [i, drawn(i, si)] as const).filter(([, v]) => v != null) as [number, number][];
    if (points.length < 2) return "";
    const top = points.map(([i, v], n) => `${n ? "L" : "M"}${xOf(i)},${yOf(v)}`).join("");
    if (piles && si > 0) {
      const below = [...points].reverse().map(([i]) => `L${xOf(i)},${yOf(drawn(i, si - 1) ?? 0)}`).join("");
      return `${top}${below}Z`;
    }
    const base = yOf(scale.min);
    return `${top}L${xOf(points.at(-1)![0])},${base}L${xOf(points[0][0])},${base}Z`;
  }

  const lastIndex = (si: number) => {
    for (let i = data.length - 1; i >= 0; i--) if (drawn(i, si) != null) return i;
    return -1;
  };

  function onMove(e: PointerEvent) {
    if (!canvas || data.length === 0) return;
    const r = canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * chartWidth;
    const t = data.length <= 1 ? 0 : (px - M.left) / plotWidth;
    active = Math.min(data.length - 1, Math.max(0, Math.round(t * (data.length - 1))));
  }

  const category = (i: number) => String(data[i]?.[x] ?? "");
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

  function onKey(e: KeyboardEvent) {
    if (!data.length) return;
    if (e.key === "ArrowRight") active = active == null ? 0 : Math.min(data.length - 1, active + 1);
    else if (e.key === "ArrowLeft") active = active == null ? data.length - 1 : Math.max(0, active - 1);
    else if (e.key === "Home") active = 0;
    else if (e.key === "End") active = data.length - 1;
    else if (e.key === "Escape") active = null;
    else return;
    e.preventDefault();
  }
</script>

<ChartFigure
  {title}
  {hideTitle}
  legend={series.length > 1 ? series.map((s) => ({ label: s.label })) : undefined}
  legendMarker={piles ? "square" : "line"}
  empty={data.length === 0}
  {emptyText}
  {table}
  {showDataLabel}
  {hideDataLabel}
  class={className}
>
  <!-- A slider over the points: ← → step through the data and aria-valuetext reads it. -->
  <div
    class="ta-chart-canvas"
    bind:clientWidth={chartWidth}
    bind:this={canvas}
    role="slider"
    tabindex="0"
    aria-label={title}
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
    <svg width="100%" {height} viewBox={`0 0 ${chartWidth} ${height}`} class="ta-chart-svg" aria-hidden="true">
      {#each scale.ticks as t (t)}
        <line x1={M.left} x2={M.left + plotWidth} y1={yOf(t)} y2={yOf(t)} class={t === scale.min ? "ta-chart-base" : "ta-chart-grid"} />
        <text x={M.left - 8} y={yOf(t)} class="ta-chart-axis" text-anchor="end" dominant-baseline="middle">{format(t)}</text>
      {/each}
      {#each data as _, i (i)}
        {#if i % labelStep === 0 || i === data.length - 1}
          <text x={xOf(i)} y={height - 8} class="ta-chart-axis" text-anchor={i === data.length - 1 && data.length > 1 ? "end" : "middle"}>{category(i)}</text>
        {/if}
      {/each}

      {#if area || piles}
        {#each series as s, si (s.key)}<path d={areaPath(si)} fill={seriesColor(si)} fill-opacity={piles ? 0.35 : 0.1} />{/each}
      {/if}
      {#each series as s, si (s.key)}
        <path d={linePath(si)} fill="none" stroke={seriesColor(si)} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        {@const u = lastIndex(si)}
        {#if u >= 0}
          <circle cx={xOf(u)} cy={yOf(drawn(u, si)!)} r="4" fill={seriesColor(si)} class="ta-chart-dot" />
        {/if}
      {/each}

      {#if active != null && data[active]}
        <line x1={xOf(active)} x2={xOf(active)} y1={M.top} y2={M.top + plotHeight} class="ta-chart-crosshair" />
        {#each series as s, si (s.key)}
          {@const v = drawn(active, si)}
          {#if v != null}<circle cx={xOf(active)} cy={yOf(v)} r="4" fill={seriesColor(si)} class="ta-chart-dot" />{/if}
        {/each}
      {/if}
    </svg>

    {#if active != null && data[active]}
      <div
        class="ta-chart-tooltip"
        style:left={`${Math.min(Math.max(0, chartWidth - 160), Math.max(0, xOf(active) + (xOf(active) > chartWidth / 2 ? -172 : 12)))}px`}
        aria-hidden="true"
      >
        <span class="ta-chart-tooltip-x">{category(active)}</span>
        {#each series as s, si (s.key)}
          <span class="ta-chart-tooltip-row">
            <span class={piles ? "ta-chart-key" : "ta-chart-line"} style:background={seriesColor(si)}></span>
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
  .ta-chart-tooltip-total { margin-top: 0.125rem; padding-top: 0.25rem; border-top: 1px solid rgb(var(--ta-border)); }

  @media (pointer: coarse) {
    /* The chart itself is the control: tall enough to step through with a finger. */
    .ta-chart-canvas { min-height: 2.75rem; }
  }
</style>
