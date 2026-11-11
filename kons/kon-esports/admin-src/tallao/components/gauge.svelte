<!--
  tallao — Gauge
  One value inside a known range, as a half dial (`variant="semi"`) or a full ring
  (`variant="ring"`, a radial progress): the figure in the centre, the label under it and,
  on the half dial, the two ends of the range in text. An optional `target` draws a tick.
  It is a `role="meter"` named by `label`, with the formatted value as its text (and the
  target, when there is one): the drawing is decorative. `tone` colours the arc, and the
  figure itself is always text. Not interactive; renders the same on the server; the arc
  eases in unless the user prefers reduced motion.
  Plain JSON: `{ "label": "Win rate", "value": 52.4, "min": 0, "max": 100, "target": 55 }`.
-->
<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { compactNumber } from "$lib/internal/chart";
  import { cn } from "$lib/utils";

  const L = useLabels();

  interface Props {
    value: number;
    min?: number;
    max?: number;
    /** What is measured: the accessible name and the caption. */
    label: string;
    /** A half dial, or a full ring. */
    variant?: "semi" | "ring";
    /** Colour of the arc. */
    tone?: "default" | "success" | "warning" | "error";
    /** A goal inside the range, marked with a tick. */
    target?: number;
    targetLabel?: string;
    /** Width in px (it shrinks to fit a narrow container). */
    size?: number;
    locale?: string;
    /** Format of the value, the ends and the target. */
    format?: (n: number) => string;
    class?: string;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const {
    value,
    min = 0,
    max = 100,
    label,
    variant = "semi",
    tone = "default",
    target,
    targetLabel = L.target,
    size = 180,
    locale,
    format = (n: number) => compactNumber(n, locale),
    class: className = "",
    ...rest
  }: Props = $props();

  const ratio = (v: number) => (max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0);
  const share = $derived(Number.isFinite(value) ? ratio(value) : 0);
  const ring = $derived(variant === "ring");
  const R = 84;
  // The dial runs from 9 o'clock over the top to 3 o'clock; the ring starts at 12 o'clock.
  const track = $derived(ring ? `M100,${100 - R}A${R},${R} 0 1 1 99.99,${100 - R}` : `M${100 - R},100A${R},${R} 0 0 1 ${100 + R},100`);
  const tick = $derived.by(() => {
    if (target == null || !Number.isFinite(target)) return null;
    const a = ring ? ratio(target) * Math.PI * 2 : -Math.PI / 2 + ratio(target) * Math.PI;
    const at = (r: number) => `${(100 + r * Math.sin(a)).toFixed(1)},${(100 - r * Math.cos(a)).toFixed(1)}`;
    return `M${at(R - 11)}L${at(R + 11)}`;
  });
  const text = $derived(`${format(value)}${target != null ? `, ${targetLabel} ${format(target)}` : ""}`);
</script>

<div
  {...rest}
  class={cn("ta-gauge", `ta-gauge--${variant}`, `ta-gauge--${tone}`, className)}
  role="meter"
  aria-label={label}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min}
  aria-valuetext={text}
  style:width={`${size}px`}
>
  <svg viewBox={ring ? "0 0 200 200" : "0 0 200 112"} class="ta-gauge-svg" aria-hidden="true">
    <path d={track} class="ta-gauge-track" />
    {#if share > 0}<path d={track} class="ta-gauge-arc" pathLength="100" stroke-dasharray={`${(share * 100).toFixed(2)} 100`} />{/if}
    {#if tick}<path d={tick} class="ta-gauge-tick" />{/if}
    <text x="100" y={ring ? 110 : 98} class="ta-gauge-value" text-anchor="middle">{format(value)}</text>
  </svg>
  {#if !ring}
    <div class="ta-gauge-ends" aria-hidden="true"><span>{format(min)}</span><span>{format(max)}</span></div>
  {/if}
  <div class="ta-gauge-label" aria-hidden="true">
    <span>{label}</span>{#if target != null}<span class="ta-gauge-target">· {targetLabel} {format(target)}</span>{/if}
  </div>
</div>

<style>
  .ta-gauge { display: flex; flex-direction: column; max-width: 100%; color: rgb(var(--ta-text)); --ta-gauge-color: rgb(var(--ta-accent)); }
  .ta-gauge--success { --ta-gauge-color: rgb(var(--ta-success)); }
  .ta-gauge--warning { --ta-gauge-color: rgb(var(--ta-warning)); }
  .ta-gauge--error { --ta-gauge-color: rgb(var(--ta-danger)); }

  .ta-gauge-svg { display: block; width: 100%; height: auto; overflow: visible; }
  .ta-gauge-track,
  .ta-gauge-arc { fill: none; stroke-width: 16; stroke-linecap: round; }
  .ta-gauge-track { stroke: rgb(var(--ta-elevated)); }
  .ta-gauge-arc { stroke: var(--ta-gauge-color); animation: ta-gauge-in 0.6s ease-out; }
  .ta-gauge-tick { stroke: rgb(var(--ta-text)); stroke-width: 3; stroke-linecap: round; }
  .ta-gauge-value { fill: rgb(var(--ta-text)); font-size: 34px; font-weight: 700; font-variant-numeric: tabular-nums; }

  .ta-gauge-ends { display: flex; justify-content: space-between; padding: 0.25rem 0.125rem 0; font-size: 0.6875rem; color: rgb(var(--ta-text-dim)); font-variant-numeric: tabular-nums; }
  .ta-gauge-label { margin-top: 0.25rem; display: flex; flex-wrap: wrap; justify-content: center; gap: 0 0.3em; text-align: center; font-size: 0.8125rem; color: rgb(var(--ta-text-dim)); }
  .ta-gauge-target { white-space: nowrap; }

  @keyframes ta-gauge-in {
    from { stroke-dasharray: 0 100; }
  }
  @media (prefers-reduced-motion: reduce) {
    .ta-gauge-arc { animation: none; }
  }
</style>
