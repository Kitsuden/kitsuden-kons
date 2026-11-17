/**
 * tallao — what BarChart and LineChart share
 *
 * Scales with round numbers (0 / 250 / 500…), compact figures from 10 000 up
 * (12K, 4.2M), and series colors by fixed position (never recycled: more than eight
 * series are grouped into "Other" or split across several charts).
 */

export interface ChartSeries {
  key: string;
  label: string;
}

export const MAX_SERIES = 8;

/** Color of series i (0-based) from the tokens. */
export const seriesColor = (i: number) => `rgb(var(--ta-series-${(i % MAX_SERIES) + 1}))`;

/** A "nice" maximum and its ticks: the smallest 1·2·2.5·5·10 × 10ⁿ that covers `max`. */
export function niceScale(max: number, ticks = 4): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((p) => p >= raw) ?? 10 * power;
  const top = Math.ceil(max / step) * step;
  const marks: number[] = [];
  for (let v = 0; v <= top + step / 1e6; v += step) marks.push(Math.round(v * 1e6) / 1e6);
  return { max: top, ticks: marks };
}

/** Axis figures: whole numbers below 10 000 (1,250), compact from there on (12K, 3.4M). */
export function compactNumber(n: number, locale?: string, compact = Math.abs(n) >= 10_000) {
  return new Intl.NumberFormat(locale, compact ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 2 }).format(n);
}

/** Numeric value of a row for a series; anything that is not a number counts as empty. */
export function valueOf(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Fills a label template: `fill("{n} of {total}", { n: 7, total: 10 })`. */
export const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** `part` as a percentage of `whole` ("42.5%"); 0% when there is no whole. */
export const percentOf = (part: number, whole: number, locale?: string, digits = 1) =>
  new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: digits }).format(whole > 0 ? part / whole : 0);

/** A finite number, or null: what the charts accept as a value. */
export const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Round bounds and ticks for a range that need not start at zero (scatter axes, a line's `domain`). */
export function niceDomain(min: number, max: number, ticks = 4): { min: number; max: number; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (!(max > min)) max = min + 1;
  const raw = (max - min) / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((p) => p >= raw) ?? 10 * power;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const marks: number[] = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) marks.push(Math.round(v * 1e6) / 1e6);
  return { min: lo, max: hi, ticks: marks };
}

/**
 * A ring segment (or a pie wedge when `inner` is 0) between two angles in radians,
 * measured clockwise from 12 o'clock.
 */
export function arcPath(cx: number, cy: number, outer: number, inner: number, from: number, to: number): string {
  const end = Math.min(to, from + Math.PI * 2 - 1e-4);
  const at = (r: number, a: number) => `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
  const large = end - from > Math.PI ? 1 : 0;
  if (inner <= 0) return `M${cx},${cy}L${at(outer, from)}A${outer},${outer} 0 ${large} 1 ${at(outer, end)}Z`;
  return `M${at(outer, from)}A${outer},${outer} 0 ${large} 1 ${at(outer, end)}L${at(inner, end)}A${inner},${inner} 0 ${large} 0 ${at(inner, from)}Z`;
}

/** Point shapes, so groups differ by more than colour. */
export const SHAPES = ["circle", "square", "triangle", "diamond"] as const;
export type PointShape = (typeof SHAPES)[number];

/** Path of a point marker of radius `r` centred on (x, y). */
export function shapePath(shape: PointShape, x: number, y: number, r: number): string {
  if (shape === "square") return `M${x - r},${y - r}h${2 * r}v${2 * r}h${-2 * r}Z`;
  if (shape === "triangle") return `M${x},${y - r * 1.2}L${x + r * 1.15},${y + r * 0.9}H${x - r * 1.15}Z`;
  if (shape === "diamond") return `M${x},${y - r * 1.3}L${x + r * 1.3},${y}L${x},${y + r * 1.3}L${x - r * 1.3},${y}Z`;
  return `M${x - r},${y}a${r},${r} 0 1 0 ${2 * r},0a${r},${r} 0 1 0 ${-2 * r},0Z`;
}
