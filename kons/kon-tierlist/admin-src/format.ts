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
 * The board's status line: title, version and, if it is a list the team orders by hand, the mark —
 * knowing on opening it that the data reload won't touch it is status information.
 */
export function statusOf(list: TierList | null): string {
  if (!list) return "";
  const base = list.version ? `${list.title} — ${list.version}` : (list.title ?? "");
  return list.manual ? `${base} · ordered by the team` : base;
}

/**
 * The colors go from red to gray, as in any tier list. They are computed from the POSITION and not
 * the label: so it works the same with «S,A,B» as with «Essential, Optional, No».
 */
const PALETTE = ["#ff5252", "#ff9800", "#ffc107", "#8bc34a", "#4caf50", "#00bcd4", "#888888"];

export const tiersFrom = (tags: string[]): Tier[] =>
  tags.map((label, i) => ({
    id: slugDe(label) || `t${i + 1}`,
    label,
    color: PALETTE[Math.min(i, PALETTE.length - 1)],
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

export const diffGroups = (diff: Diff): [string, Change[], "up" | "down" | ""][] =>
  (
    [
      ["Moving up", diff.promoted, "up"],
      ["Moving down", diff.demoted, "down"],
      ["New", diff.added, ""],
      ["Retired", diff.removed, ""],
    ] as [string, Change[], "up" | "down" | ""][]
  ).filter(([, changes]) => changes.length > 0);

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
