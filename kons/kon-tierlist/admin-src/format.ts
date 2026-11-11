import type { Change, Diff, Item, Tier, TierList } from "./types";

/**
 * Title → slug. Accents are removed BEFORE filtering: otherwise «Programación» becomes
 * «programacin» —the `ó` doesn't fit `[a-z0-9-]` and is dropped— and nobody connects the odd URL
 * with the accent.
 */
export function slugDe(text: string | null | undefined): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const initials = (label: string) =>
  label
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? "")
    .join("")
    .toUpperCase();

/** `title — version`, the way a list is named in the pickers. */
export const titled = (t: { title: string; version: string | null }) => (t.version ? `${t.title} — ${t.version}` : t.title);

/**
 * The kit's series tokens in the order a tier list reads: red, orange, yellow, green, aquamarine,
 * blue, violet. A row after those goes without a colour: the API gives it its default grey.
 */
const RANKED_TOKENS = [
  "--ta-series-8",
  "--ta-series-2",
  "--ta-series-4",
  "--ta-series-6",
  "--ta-series-3",
  "--ta-series-1",
  "--ta-series-7",
];

/** A token's `r g b` triplet as the `#rrggbb` the API stores; null if it cannot be read. */
function hexOf(triplet: string): string | null {
  const parts = triplet.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The colours of a new list's first rows, from red to violet as in any tier list, read from the theme's
 * tokens (`style` is the computed style of an element inside the view). Empty when the tokens
 * cannot be read: the rows then go without a colour and the API gives them its default.
 */
export function rankedColors(style: Pick<CSSStyleDeclaration, "getPropertyValue">): string[] {
  const colors = RANKED_TOKENS.map((token) => hexOf(style.getPropertyValue(token)));
  return colors.every((c) => c !== null) ? (colors as string[]) : [];
}

/**
 * A row per label. The colour is computed from the POSITION and not the label: so it works the
 * same with «S,A,B» as with «Essential, Optional, No».
 */
export const tiersFrom = (tags: string[], colors: string[]): Tier[] =>
  tags.map((label, i) => ({
    id: slugDe(label) || `t${i + 1}`,
    label,
    ...(i < colors.length ? { color: colors[i] } : {}),
  }));

/** Groups like the engine's `tierView`: the order is that of `items`. */
export function viewOf(list: TierList): { rows: { tier: Tier; items: Item[] }[]; unranked: Item[] } {
  const byTier = new Map<string, Item[]>(list.tiers.map((t) => [t.id, []]));
  const unranked: Item[] = [];
  for (const item of list.items) {
    const tierId = list.placement[item.id];
    const row = tierId ? byTier.get(tierId) : undefined;
    if (row) row.push(item);
    else unranked.push(item);
  }
  return { rows: list.tiers.map((tier) => ({ tier, items: byTier.get(tier.id) ?? [] })), unranked };
}

export function arrow(change: Change): string {
  const from = change.from?.label ?? "unranked";
  const to = change.to?.label ?? "unranked";
  return `${from} → ${to}`;
}

export type DiffGroup = "Moving up" | "Moving down" | "New" | "Retired";

export const diffGroups = (diff: Diff): [DiffGroup, Change[]][] =>
  (
    [
      ["Moving up", diff.promoted],
      ["Moving down", diff.demoted],
      ["New", diff.added],
      ["Retired", diff.removed],
    ] as [DiffGroup, Change[]][]
  ).filter(([, changes]) => changes.length > 0);

/**
 * A group's changes as before/after pairs, one per item: the row it was in and the row it is in.
 * A new item has no «before» and a retired one no «after»; anywhere else, no row is «Unranked».
 */
export const diffChanges = (group: DiffGroup, changes: Change[]) =>
  changes.map((c) => ({
    field: c.item.id,
    label: c.item.label,
    before: group === "New" ? null : (c.from?.label ?? "Unranked"),
    after: group === "Retired" ? null : (c.to?.label ?? "Unranked"),
  }));

/**
 * The diff in markdown, ready to paste into the post. "Tier list update" is the site's recurring
 * content, and rewriting it by hand comparing two images is where the errors creep in.
 */
export function diffMarkdown(diff: Diff): string {
  const section = (title: string, changes: Change[]) =>
    changes.length ? [`### ${title}`, ...changes.map((c) => `- **${c.item.label}**: ${arrow(c)}`), ""] : [];
  return [
    ...section("Moving up", diff.promoted),
    ...section("Moving down", diff.demoted),
    ...section("New", diff.added),
    ...section("Retired", diff.removed),
    `_${diff.unchanged} unchanged._`,
  ].join("\n");
}
