/**
 * Autobattler — trait activation and composition validation
 * ============================================================================
 *
 * The whole engine fits in two questions:
 *
 *   1. Given these units, **which traits activate and at what level?**
 *   2. **Is this composition legal** with the level and set it claims?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE WAYS TO COUNT TRAITS WRONG
 *
 * It is a ten-line calculation that almost everyone gets wrong in one of these
 * three ways, and all three give a number that LOOKS reasonable:
 *
 *   1. **Counting copies instead of distinct units.** Three Ahris are not three
 *      Challengers: they are one. Counting the list without deduplicating inflates every synergy
 *      of any comp that raises a unit to 2 stars.
 *   2. **Forgetting emblems.** An emblem adds a trait to a unit and
 *      changes the count without changing the unit. A comp with an emblem computed
 *      without it has ALL its traits wrong, not just the emblem's.
 *   3. **Picking the wrong tier.** With 6 units and tiers at 2/4/6, the
 *      active one is the 6 — the HIGHEST reached, not the first passed.
 *
 * And a fourth that is not counting wrong but not counting: a trait below its
 * first threshold **is not active**, but is still useful information ("you are
 * missing 1"). That is why inactive ones are also returned with their distance.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  Comp,
  CompSlot,
  ItemDefinition,
  SetDefinition,
  TraitDefinition,
  TraitTier,
} from "./autobattler.types.js";

export class AutobattlerError extends Error {}

// ── Rasgos ───────────────────────────────────────────────────────────────────

export interface ActiveTrait {
  traitId: string;
  name: string;
  /** DISTINCT units that provide it. */
  count: number;
  /** `null` if it does not even reach the first threshold. */
  tier: TraitTier | null;
  /** Index of the active tier (0 = the first). `-1` if inactive. */
  tierIndex: number;
  /** How many units are missing for the next tier. `null` if already at the maximum. */
  toNext: number | null;
  /** The units that provide it, so they can be pointed out on the board. */
  unitIds: string[];
}

/**
 * Which traits a cell provides: the unit's plus the emblem's.
 *
 * A unit that already has the trait and receives its emblem does not count twice —
 * hence the `Set`.
 */
function traitsOf(slot: CompSlot, unitTraits: Map<string, string[]>): string[] {
  return [...new Set([...(unitTraits.get(slot.unitId) ?? []), ...(slot.extraTraits ?? [])])];
}

/**
 * The active tier for a count: **the highest one reached**.
 *
 * Tiers are sorted here and the source's order is not trusted: a set
 * with unordered tiers would pick the first that fits instead of the best,
 * and the error would only be seen in large comps.
 */
export function tierFor(
  tiers: TraitTier[],
  count: number
): { tier: TraitTier | null; index: number } {
  const sorted = [...tiers].sort((a, b) => a.min - b.min);
  let index = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (count >= sorted[i].min) index = i;
  }
  return { tier: index === -1 ? null : sorted[index], index };
}

/**
 * The traits of a composition, active and inactive.
 *
 * ALL those provided by any unit are returned, including those that do not reach
 * their first threshold: "you are missing 1 for Challenger 4" is half the value of
 * a comps tool, and that information disappears if they are filtered.
 *
 * They come out sorted by tier level and then by count, which is how they are read.
 */
export function activateTraits(comp: Comp, set: SetDefinition): ActiveTrait[] {
  const unitTraits = new Map(set.units.map((u) => [u.id, u.traits]));
  const traitById = new Map(set.traits.map((t) => [t.id, t]));

  /** trait → DISTINCT units that provide it. */
  const byTrait = new Map<string, Set<string>>();
  for (const slot of comp.slots) {
    for (const traitId of traitsOf(slot, unitTraits)) {
      if (!byTrait.has(traitId)) byTrait.set(traitId, new Set());
      // A `Set` of unitId: two copies of the same unit count once.
      byTrait.get(traitId)!.add(slot.unitId);
    }
  }

  const out: ActiveTrait[] = [];
  for (const [traitId, units] of byTrait) {
    const def: TraitDefinition | undefined = traitById.get(traitId);
    const tiers = [...(def?.tiers ?? [])].sort((a, b) => a.min - b.min);
    const count = units.size;
    const { tier, index } = tierFor(tiers, count);
    const next = tiers.find((t) => t.min > count);
    out.push({
      traitId,
      name: def?.name ?? traitId,
      count,
      tier,
      tierIndex: index,
      toNext: next ? next.min - count : null,
      unitIds: [...units],
    });
  }

  return out.sort(
    (a, b) =>
      (b.tier?.style ?? -1) - (a.tier?.style ?? -1) ||
      b.count - a.count ||
      a.name.localeCompare(b.name)
  );
}

/** Only those that are actually giving a bonus. */
export const onlyActive = (traits: ActiveTrait[]) => traits.filter((t) => t.tierIndex >= 0);

// ── Items ────────────────────────────────────────────────────────────────────

/**
 * What can be crafted with these components.
 *
 * It returns the recipes that are covered IN FULL, counting repeats: two swords do not
 * craft something that asks for a sword and a cape. It is the items "cheat sheet"
 * that the three reference sites have.
 */
export function craftableFrom(components: string[], items: ItemDefinition[]): ItemDefinition[] {
  const have = new Map<string, number>();
  for (const c of components) have.set(c, (have.get(c) ?? 0) + 1);

  return items.filter((item) => {
    if (!item.composition?.length) return false;
    const need = new Map<string, number>();
    for (const c of item.composition) need.set(c, (need.get(c) ?? 0) + 1);
    for (const [id, n] of need) if ((have.get(id) ?? 0) < n) return false;
    return true;
  });
}

/** The components of an item, resolving nested recipes if there are any. */
export function componentsOf(itemId: string, items: ItemDefinition[], depth = 0): string[] {
  if (depth > 4) return [itemId];
  const item = items.find((i) => i.id === itemId);
  if (!item?.composition?.length) return [itemId];
  return item.composition.flatMap((c) => componentsOf(c, items, depth + 1));
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Is this composition playable?
 *
 * It returns a list of readable problems, never throws: a half-built comp
 * is the NORMAL state while someone assembles it, and an editor that
 * blows up on every keystroke cannot be used.
 */
export function validateComp(comp: Comp, set: SetDefinition): string[] {
  const issues: string[] = [];
  const { rules } = set;
  const unitIds = new Set(set.units.map((u) => u.id));
  const itemIds = new Set(set.items.map((i) => i.id));
  const traitIds = new Set(set.traits.map((t) => t.id));
  const augmentIds = new Set(set.augments.map((a) => a.id));

  // The level decides how many units fit. Without a level, the highest one the
  // set declares is used: it is what whoever is designing the final comp expects.
  const levels = Object.keys(rules.teamSizeByLevel).map(Number);
  const level = comp.level ?? (levels.length ? Math.max(...levels) : 0);
  const maxUnits = rules.teamSizeByLevel[level];
  if (comp.level !== undefined && maxUnits === undefined) {
    issues.push(`Level ${level} does not exist in this set`);
  }
  if (maxUnits !== undefined && comp.slots.length > maxUnits) {
    issues.push(`${comp.slots.length} units for level ${level}: fits ${maxUnits}`);
  }

  const busy = new Set<string>();
  for (const slot of comp.slots) {
    if (!unitIds.has(slot.unitId)) issues.push(`Unit "${slot.unitId}" does not exist in this set`);

    if (
      !Number.isInteger(slot.row) ||
      !Number.isInteger(slot.col) ||
      slot.row < 0 ||
      slot.col < 0 ||
      slot.row >= rules.boardRows ||
      slot.col >= rules.boardCols
    ) {
      issues.push(`"${slot.unitId}" is off the board (${slot.row},${slot.col})`);
    } else {
      // Two units in the same cell is not a comp that is hard to read: it is
      // a comp that does not exist.
      const key = `${slot.row},${slot.col}`;
      if (busy.has(key)) issues.push(`Two units in the same cell (${key})`);
      busy.add(key);
    }

    const items = slot.items ?? [];
    if (items.length > rules.itemsPerUnit) {
      issues.push(
        `"${slot.unitId}" carries ${items.length} items: the maximum is ${rules.itemsPerUnit}`
      );
    }
    for (const id of items) {
      if (!itemIds.has(id)) issues.push(`Item "${id}" does not exist in this set`);
    }
    // Unique items do not stack on the same unit.
    const unique = items.filter((id) => set.items.find((i) => i.id === id)?.unique);
    if (new Set(unique).size !== unique.length) {
      issues.push(`"${slot.unitId}" repeats a unique item`);
    }

    for (const t of slot.extraTraits ?? []) {
      if (!traitIds.has(t)) issues.push(`Trait "${t}" does not exist in this set`);
    }
    if (slot.star !== undefined && (slot.star < 1 || slot.star > 3)) {
      issues.push(`"${slot.unitId}" with ${slot.star} stars`);
    }
  }

  const augments = comp.augments ?? [];
  if (augments.length > rules.augmentSlots) {
    issues.push(`${augments.length} augments: the maximum is ${rules.augmentSlots}`);
  }
  for (const a of augments) {
    if (!augmentIds.has(a)) issues.push(`The augment "${a}" does not exist in this set`);
  }

  return issues;
}

/**
 * What it costs to build the comp, in shop gold.
 *
 * A 2-star unit is 3 copies; a 3-star, 9. It is the count that
 * says whether a comp is one that closes out in the game or one that is seen
 * in a video.
 */
export function compCost(comp: Comp, set: SetDefinition): number {
  const cost = new Map(set.units.map((u) => [u.id, u.cost]));
  return comp.slots.reduce((total, slot) => {
    const unit = cost.get(slot.unitId) ?? 0;
    const copies = 3 ** ((slot.star ?? 1) - 1);
    return total + unit * copies;
  }, 0);
}
