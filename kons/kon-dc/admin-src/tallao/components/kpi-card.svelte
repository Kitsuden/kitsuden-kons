<!--
  tallao — KpiCard
  One headline figure of a dashboard: label, value, the change since the last period, and
  optionally a sparkline and the progress towards a target. (Stat stays the bare
  figure + label for rows of totals.)
  - The change has a direction (▲ ▼ and the words "up" / "down" for screen readers) and a
    meaning that does not depend on it: `goodWhen="down"` makes a falling number good
    (ban rate, load time). Good and bad differ by shape too (a filled pill against an
    outlined one) and are spelled out for screen readers, never by colour alone.
  - Plain text and an image: nothing to operate. Renders the same on the server.
  - `span` is the number of columns it takes inside a DashboardGrid.
  Everything is plain JSON: `{ "label": "Win rate", "value": 52.4, "delta": 1.8,
  "trend": [49, 50, 50.6, 51.2, 52.4], "target": 55 }`, with `format` for the figures.
-->
<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { compactNumber, finite } from "$lib/internal/chart";
  import { cn } from "$lib/utils";

  import Sparkline from "./sparkline.svelte";

  const L = useLabels();

  interface Props {
    label: string;
    /** A number (formatted with `format`) or a text shown as is. */
    value: number | string;
    /** Text after the value, smaller ("%", "ms", "players"). */
    unit?: string;
    /** Change since the previous period, in the units `deltaFormat` writes. */
    delta?: number | null;
    /** What the change is compared with ("vs last patch"). */
    deltaLabel?: string;
    /** Which direction of change is good; `none` shows it without a verdict. */
    goodWhen?: "up" | "down" | "none";
    /** Recent values, oldest first, drawn as a sparkline. */
    trend?: number[];
    /** Goal for a numeric value: shows a bar with the progress towards it. */
    target?: number;
    targetLabel?: string;
    locale?: string;
    /** Format of the value and the target. */
    format?: (n: number) => string;
    /** Format of the change (by default a signed number: "+1.8"). */
    deltaFormat?: (n: number) => string;
    /** Columns it takes inside a DashboardGrid (`"full"`: the whole row). */
    span?: 1 | 2 | 3 | 4 | "full";
    class?: string;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const {
    label,
    value,
    unit,
    delta,
    deltaLabel,
    goodWhen = "up",
    trend,
    target,
    targetLabel = L.target,
    locale,
    format = (n: number) => compactNumber(n, locale),
    deltaFormat = (n: number) => new Intl.NumberFormat(locale, { signDisplay: "exceptZero", maximumFractionDigits: 1 }).format(n),
    span,
    class: className = "",
    ...rest
  }: Props = $props();

  const change = $derived(finite(delta));
  const direction = $derived(change == null ? null : change > 0 ? "up" : change < 0 ? "down" : "flat");
  const verdict = $derived(direction == null || direction === "flat" || goodWhen === "none" ? "neutral" : direction === goodWhen ? "good" : "bad");
  const progress = $derived(typeof value === "number" && target != null && target > 0 ? Math.min(100, Math.max(0, (value / target) * 100)) : null);
  const tone = $derived(verdict === "good" ? "rgb(var(--ta-success))" : verdict === "bad" ? "rgb(var(--ta-danger))" : undefined);
</script>

<div {...rest} class={cn("ta-kpi", className)} data-ta-span={span}>
  <span class="ta-kpi-label">{label}</span>
  <div class="ta-kpi-main">
    <span class="ta-kpi-value">{typeof value === "number" ? format(value) : value}{#if unit}<span class="ta-kpi-unit">{unit}</span>{/if}</span>
    {#if trend?.length}<Sparkline data={trend} {label} {locale} {format} area color={tone} class="ta-kpi-trend" />{/if}
  </div>
  {#if change != null}
    <p class={cn("ta-kpi-delta", `ta-kpi-delta--${verdict}`)}>
      <span class="ta-kpi-change">
        <span aria-hidden="true">{direction === "up" ? "▲" : direction === "down" ? "▼" : "■"}</span>
        <span class="ta-kpi-hidden">{direction === "up" ? L.trendUp : direction === "down" ? L.trendDown : L.trendFlat}</span>
        {deltaFormat(change)}
        {#if verdict !== "neutral"}<span class="ta-kpi-hidden">({verdict === "good" ? L.better : L.worse})</span>{/if}
      </span>
      {#if deltaLabel}<span class="ta-kpi-delta-label">{deltaLabel}</span>{/if}
    </p>
  {/if}
  {#if progress != null && target != null}
    <div class="ta-kpi-target">
      <span class="ta-kpi-track" aria-hidden="true"><span class="ta-kpi-bar" style:width={`${progress}%`}></span></span>
      <span class="ta-kpi-target-text">{targetLabel} {format(target)}</span>
    </div>
  {/if}
</div>

<style>
  .ta-kpi {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    min-width: 0;
    padding: 1rem 1.125rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface) / 0.5);
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
  }
  .ta-kpi-label { font-size: 0.75rem; color: rgb(var(--ta-text-dim)); }
  .ta-kpi-main { display: flex; align-items: flex-end; justify-content: space-between; gap: 0.75rem; min-width: 0; }
  .ta-kpi-value { font-size: 1.75rem; font-weight: 700; line-height: 1.1; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; min-width: 0; overflow-wrap: anywhere; }
  .ta-kpi-unit { margin-left: 0.125rem; font-size: 0.875rem; font-weight: 500; color: rgb(var(--ta-text-dim)); }
  .ta-kpi :global(.ta-kpi-trend) { margin-bottom: 0.125rem; }

  .ta-kpi-delta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.375rem; margin: 0; font-size: 0.75rem; }
  .ta-kpi-change {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.0625rem 0.4375rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: rgb(var(--ta-text-dim));
    border: 1px solid rgb(var(--ta-border));
    border-radius: 9999px;
  }
  .ta-kpi-change > [aria-hidden] { font-size: 0.5625rem; }
  /* Good is a filled pill, bad an outlined one: the verdict does not hang on the hue.
     The tone is mixed with the text colour so it reads on both themes. */
  .ta-kpi-delta--good .ta-kpi-change { color: color-mix(in srgb, rgb(var(--ta-success)) 65%, rgb(var(--ta-text))); background: rgb(var(--ta-success) / 0.14); border-color: transparent; }
  .ta-kpi-delta--bad .ta-kpi-change { color: color-mix(in srgb, rgb(var(--ta-danger)) 65%, rgb(var(--ta-text))); border-color: rgb(var(--ta-danger) / 0.6); border-style: dashed; }
  .ta-kpi-delta-label { color: rgb(var(--ta-text-dim)); }

  .ta-kpi-target { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.125rem; font-size: 0.6875rem; color: rgb(var(--ta-text-dim)); }
  .ta-kpi-track { flex: 1; height: 0.25rem; overflow: hidden; border-radius: 9999px; background: rgb(var(--ta-elevated)); }
  .ta-kpi-bar { display: block; height: 100%; border-radius: inherit; background: rgb(var(--ta-accent)); }
  .ta-kpi-target-text { white-space: nowrap; font-variant-numeric: tabular-nums; }

  .ta-kpi-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
