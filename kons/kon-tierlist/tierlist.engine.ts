/**
 * Tier list engine
 * ============================================================================
 *
 * A tier list is a set of ordered rows and a distribution of elements
 * among them. It sounds trivial, and it is — until the two uses appear, which are
 * NOT the same product:
 *
 *   · **Editorial**: the site publishes THE patch's tier list. It is
 *     versioned, compared with the previous one, and appears in the guides. Its value lies
 *     in authority and in the "what changed".
 *   · **Personal** (TierMaker): a reader drags and makes THEIR OWN to
 *     share it. It is ephemeral, belongs to whoever makes it, and its value lies in how easy
 *     it is to build and show.
 *
 * One engine, two surfaces. What they share —rows, distribution, validation,
 * codes— is 90%; what changes is who the owner is and what is done with
 * it. Writing them separately would have duplicated that 90% only for it to
 * diverge afterwards.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PIECE THAT JUSTIFIES THE ENGINE: `diffTierLists`
 *
 * "Tier list update" IS the content of a game guide site. Without
 * a diff, every update forces comparing two images by eye and writing
 * the changes by hand — which is where the errors creep in that the community
 * spots in ten minutes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Definition ───────────────────────────────────────────────────────────────

export interface Tier {
  id: string;
  label: string;
  /** Row color. The classic red→blue gradient of tier lists. */
  color: string;
}

export interface TierItemMeta {
  /** Meta presence share (e.g. 16.54%). */
  share?: number;
  /** Win percentage (e.g. 52.3%). */
  winRate?: number;
  /** Position in the ranking / power ranking */
  rank?: number;
  /** Change in rank (positive or negative) */
  delta?: number;
  /** Computed score or tournament points */
  score?: number;
  /** Source of the data (e.g.: "Limitless Tournament Platform · 24 tournaments") */
  source?: string;
  /** Number of games / matches recorded */
  matches?: number;
  /** ID of the representative deck in kon-cardsim (a saved deck, or one shown in its showcase) */
  featuredDeckId?: string;
  /** Most representative cards / core of the deck */
  composition?: Array<{
    card: string;
    copies?: number;
    image?: string;
    slug?: string;
    card_id?: string;
    [key: string]: unknown;
  }>;
  /** Additional arbitrary attributes coming from the dataset */
  [key: string]: unknown;
}

export interface TierItem {
  id: string;
  label: string;
  imageUrl: string | null;
  /**
   * Dataset row it came from, if it was generated from there.
   *
   * It is what connects the tier list with the catalog: when a new character
   * enters, it appears by itself in the unranked pool instead of being forgotten.
   */
  sourceRef?: string | null;
  /**
   * Meta metadata for competitive card games or gachas.
   * Optional: Most games keep using atomic chips without meta.
   */
  meta?: TierItemMeta;
}

export interface TierList {
  tiers: Tier[];
  items: TierItem[];
  /**
   * `itemId` → `tierId`. An element ABSENT from the map is unranked.
   *
   * Absent and not `null` on purpose: "unranked" is the natural state of
   * everything that enters new, and having to write a null for every element
   * of the catalog would be pure noise.
   */
  placement: Record<string, string>;
}

export class TierListError extends Error {}

/** The preset everyone recognizes. */
export const DEFAULT_TIERS: Tier[] = [
  { id: "s", label: "S", color: "#ff7f7f" },
  { id: "a", label: "A", color: "#ffbf7f" },
  { id: "b", label: "B", color: "#ffff7f" },
  { id: "c", label: "C", color: "#bfff7f" },
  { id: "d", label: "D", color: "#7fbfff" },
];

export function createTierList(tiers: Tier[], items: TierItem[]): TierList {
  const errors = validateTiers(tiers);
  if (errors.length) throw new TierListError(errors.join("; "));
  // Everything starts unranked: placing is a decision, not a default.
  return { tiers, items, placement: {} };
}

function validateTiers(tiers: Tier[]): string[] {
  const errors: string[] = [];
  if (tiers.length === 0) errors.push("A tier list needs at least one row");
  const ids = new Set<string>();
  for (const tier of tiers) {
    if (ids.has(tier.id)) errors.push(`Duplicate row: "${tier.id}"`);
    ids.add(tier.id);
  }
  return errors;
}

/**
 * Validates the entire list. Returns all the problems, like the builder.
 *
 * The case that truly matters is the orphaned distribution: if a row is deleted and
 * elements are left pointing to it, they vanish from the screen without warning and
 * nobody knows why a character is missing.
 */
export function validateTierList(list: TierList): string[] {
  const errors = validateTiers(list.tiers);

  const tierIds = new Set(list.tiers.map((t) => t.id));
  const itemIds = new Set<string>();
  for (const item of list.items) {
    if (itemIds.has(item.id)) errors.push(`Duplicate item: "${item.id}"`);
    itemIds.add(item.id);
  }

  for (const [itemId, tierId] of Object.entries(list.placement)) {
    if (!itemIds.has(itemId)) {
      errors.push(`"${itemId}" is placed but is not in the item list`);
    }
    if (!tierIds.has(tierId)) {
      errors.push(`"${itemId}" points to the row "${tierId}", which does not exist`);
    }
  }

  return errors;
}

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * Places an element. `null` returns it to the unranked pool.
 *
 * Immutable: returns a new list. It is what allows undo in the editor
 * by keeping previous states, without the engine having to know about history.
 */
export function place(list: TierList, itemId: string, tierId: string | null): TierList {
  if (!list.items.some((i) => i.id === itemId)) {
    throw new TierListError(`"${itemId}" is not in this tier list`);
  }
  if (tierId !== null && !list.tiers.some((t) => t.id === tierId)) {
    throw new TierListError(`The row "${tierId}" does not exist`);
  }

  const placement = { ...list.placement };
  if (tierId === null) delete placement[itemId];
  else placement[itemId] = tierId;

  return { ...list, placement };
}

/**
 * Adds elements by hand.
 *
 * ── WHY IT IS NEEDED ───────────────────────────────────────────────────────
 *
 * A tier list WITHOUT a catalog had no way to receive its first chip. It was
 * created, the board came out with empty rows and that was the end: the footer
 * of the form promised «elements are added from the catalog or on
 * import» and neither of the two things existed. A screen that only knows how to
 * start the work is worse than one that doesn't offer it.
 *
 * ── WHY IT IS NOT A `PUT` OF THE WHOLE LIST ────────────────────────────────
 *
 * For the same reason as `place`: two editors sending the complete list overwrite
 * all the work, not just what both touched. Adding is an operation, not
 * a save.
 *
 * An id that is already there is NOT duplicated: its label and image are updated. It is
 * the same as what `syncWithCatalog` does, and with it adding something again is
 * harmless — which is just what is needed when the editor doesn't know whether the
 * chip was already there.
 */
export function addItems(list: TierList, newOnes: TierItem[]): TierList {
  const byId = new Map(list.items.map((i) => [i.id, i]));

  for (const item of newOnes) {
    const prior = byId.get(item.id);
    byId.set(item.id, prior ? { ...prior, ...item } : item);
  }

  return { ...list, items: [...byId.values()] };
}

/**
 * Removes an element, and with it its placement.
 *
 * Both things together and not just the first: leaving the distribution pointing at
 * a chip that is no longer there is exactly the «orphaned distribution» that
 * `validateTierList` hunts, and it would make the next save fail for a
 * reason that has nothing to do with what was being done.
 */
export function removeItem(list: TierList, itemId: string): TierList {
  if (!list.items.some((i) => i.id === itemId)) {
    throw new TierListError(`"${itemId}" is not in this tier list`);
  }

  const placement = { ...list.placement };
  delete placement[itemId];

  return { ...list, items: list.items.filter((i) => i.id !== itemId), placement };
}

/**
 * Syncs with a catalog (a dataset of characters, weapons…).
 *
 * What makes an editorial tier list useful: when new content enters it appears
 * **unranked** instead of silently missing, and whatever disappears from the
 * catalog leaves with its placement.
 *
 * Existing placements are NOT touched: re-syncing after a patch cannot
 * reorder the editor's work.
 */
export function syncWithCatalog(list: TierList, catalog: TierItem[]): TierList {
  const catalogIds = new Set(catalog.map((i) => i.id));
  const existing = new Map(list.items.map((i) => [i.id, i]));

  const items = catalog.map((entry) => {
    const previous = existing.get(entry.id);
    // The catalog rules for name and image —it may have been renamed— and refreshes
    // the meta statistics if they come from the new catalog.
    return previous
      ? {
          ...previous,
          label: entry.label,
          imageUrl: entry.imageUrl,
          ...(entry.meta !== undefined
            ? { meta: entry.meta }
            : previous.meta !== undefined
              ? { meta: previous.meta }
              : {}),
        }
      : entry;
  });

  const placement: Record<string, string> = {};
  for (const [itemId, tierId] of Object.entries(list.placement)) {
    if (catalogIds.has(itemId)) placement[itemId] = tierId;
  }

  return { ...list, items, placement };
}

// ── Auto-placement by meta statistics ────────────────────────────────────────

export interface StatTierThreshold {
  tierId: string;
  /** Minimum value to land in this row (e.g.: share >= 15 for Tier 1). */
  minShare?: number;
  /** Minimum computed score */
  minScore?: number;
  /** Minimum win percentage */
  minWinRate?: number;
}

/**
 * Computes the automatic placement of items according to their meta statistics.
 * Useful for card/tournament or competitive tier lists with `manual: false`.
 *
 * Thresholds are evaluated from most to least demanding; the first threshold
 * that the element's value meets will determine its tier.
 */
export function calculatePlacementsFromStats(
  items: TierItem[],
  thresholds: StatTierThreshold[],
  metricKey: "share" | "score" | "winRate" = "share"
): Record<string, string> {
  const placement: Record<string, string> = {};

  const sortedThresholds = [...thresholds].sort((a, b) => {
    const valA = a.minShare ?? a.minScore ?? a.minWinRate ?? 0;
    const valB = b.minShare ?? b.minScore ?? b.minWinRate ?? 0;
    return valB - valA;
  });

  for (const item of items) {
    if (!item.meta) continue;
    const val = item.meta[metricKey];
    if (typeof val !== "number") continue;

    for (const t of sortedThresholds) {
      const thresholdVal = t.minShare ?? t.minScore ?? t.minWinRate ?? 0;
      if (val >= thresholdVal) {
        placement[item.id] = t.tierId;
        break;
      }
    }
  }

  return placement;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface TierRow {
  tier: Tier;
  items: TierItem[];
}

export interface TierView {
  rows: TierRow[];
  /** What has not been placed yet. The editor's bottom tray. */
  unranked: TierItem[];
}

/**
 * Groups for painting.
 *
 * The order WITHIN each row is that of `items`, not of placement: so a
 * list is painted the same every time it is opened. Ordering by "when it was placed"
 * would make the same list look different depending on how it was built.
 */
export function tierView(list: TierList): TierView {
  const byTier = new Map<string, TierItem[]>(list.tiers.map((t) => [t.id, []]));
  const unranked: TierItem[] = [];

  for (const item of list.items) {
    const tierId = list.placement[item.id];
    if (tierId && byTier.has(tierId)) byTier.get(tierId)!.push(item);
    else unranked.push(item);
  }

  return {
    rows: list.tiers.map((tier) => ({ tier, items: byTier.get(tier.id) ?? [] })),
    unranked,
  };
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export interface TierChange {
  item: TierItem;
  /** `null` = it was unranked or did not exist. */
  from: Tier | null;
  to: Tier | null;
  /** Positions it moved. Negative = went up (S is at the top). */
  delta: number;
}

export interface TierDiff {
  promoted: TierChange[];
  demoted: TierChange[];
  added: TierChange[];
  removed: TierChange[];
  unchanged: number;
}

/**
 * Compares two tier lists.
 *
 * It is what turns "tier list update" into publishable content without
 * writing it by hand. And the direction matters: in a tier list **S is at the top**,
 * so going up from C to A is a LOWER index — a negative `delta` is a
 * promotion, even though read cold it seems the other way round.
 */
export function diffTierLists(before: TierList, after: TierList): TierDiff {
  /**
   * Index of a row for comparison. Lower = better (S is at the top).
   *
   * **Unranked is `tiers.length`, not `-1`.** The pool is BELOW the
   * last row, and `-1` would have placed it numerically above S — so
   * entering the ranking from the pool came out published as a drop.
   */
  const indexOf = (list: TierList, tierId: string | undefined) => {
    if (tierId === undefined) return list.tiers.length;
    const index = list.tiers.findIndex((t) => t.id === tierId);
    // A row that no longer exists is treated as the pool: it is what happens to the
    // element on screen.
    return index === -1 ? list.tiers.length : index;
  };

  const tierOf = (list: TierList, tierId: string | undefined) =>
    tierId === undefined ? null : (list.tiers.find((t) => t.id === tierId) ?? null);

  const beforeItems = new Map(before.items.map((i) => [i.id, i]));
  const afterItems = new Map(after.items.map((i) => [i.id, i]));

  const diff: TierDiff = { promoted: [], demoted: [], added: [], removed: [], unchanged: 0 };

  for (const item of after.items) {
    const wasThere = beforeItems.has(item.id);
    const fromId = before.placement[item.id];
    const toId = after.placement[item.id];

    const change: TierChange = {
      item,
      from: tierOf(before, fromId),
      to: tierOf(after, toId),
      delta: indexOf(after, toId) - indexOf(before, fromId),
    };

    if (!wasThere) {
      diff.added.push(change);
    } else if (fromId === toId) {
      diff.unchanged++;
    } else if (change.delta < 0) {
      // Lower index = higher up = better tier.
      diff.promoted.push(change);
    } else {
      diff.demoted.push(change);
    }
  }

  for (const item of before.items) {
    if (afterItems.has(item.id)) continue;
    diff.removed.push({
      item,
      from: tierOf(before, before.placement[item.id]),
      to: null,
      delta: 0,
    });
  }

  return diff;
}

// ── Shareable codes ──────────────────────────────────────────────────────────

/**
 * Encodes a personal tier list for sharing.
 *
 * Only the DISTRIBUTION travels, not the elements: a personal tier list is always born
 * from a published template, and sending the 200 character chips in the link
 * would give a URL of several KB to repeat what is already on the server.
 */
export function encodeTierList(templateId: string, list: TierList): string {
  const payload = JSON.stringify({ v: 1, t: templateId, p: list.placement });
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type DecodedTierList =
  | { ok: true; templateId: string; placement: Record<string, string> }
  | { ok: false; reason: string };

/** NEVER throws: the code arrives from a chat, cut off or tampered with. */
export function decodeTierList(code: string): DecodedTierList {
  try {
    const base64 = code.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      v?: number;
      t?: string;
      p?: Record<string, unknown>;
    };

    if (payload.v !== 1) return { ok: false, reason: "Unsupported code version" };
    if (typeof payload.t !== "string" || !payload.t) {
      return { ok: false, reason: "The code does not indicate the template" };
    }

    const placement: Record<string, string> = {};
    for (const [itemId, tierId] of Object.entries(payload.p ?? {})) {
      if (typeof tierId !== "string") return { ok: false, reason: "Malformed placement" };
      placement[itemId] = tierId;
    }

    return { ok: true, templateId: payload.t, placement };
  } catch {
    return { ok: false, reason: "Unreadable code" };
  }
}

/**
 * Applies a decoded distribution onto a template.
 *
 * It silently discards what no longer fits —a retired character, a deleted
 * row— instead of failing: a six-month-old code must open and
 * show whatever is still valid, not an error.
 */
export function applyPlacement(template: TierList, placement: Record<string, string>): TierList {
  const itemIds = new Set(template.items.map((i) => i.id));
  const tierIds = new Set(template.tiers.map((t) => t.id));

  const clean: Record<string, string> = {};
  for (const [itemId, tierId] of Object.entries(placement)) {
    if (itemIds.has(itemId) && tierIds.has(tierId)) clean[itemId] = tierId;
  }

  return { ...template, placement: clean };
}
