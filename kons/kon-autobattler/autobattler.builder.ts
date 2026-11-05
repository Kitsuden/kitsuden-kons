import { activateTraits, onlyActive, type ActiveTrait } from "./autobattler.engine.js";
import type { Comp, SetDefinition, UnitDefinition } from "./autobattler.types.js";

/**
 * Engine of a team builder: which unit to add and why
 * ============================================================================
 *
 * ── WHAT SEPARATES A VIEWER FROM A BUILDER ─────────────────────────────────
 *
 * `activateTraits` answers "what do I have". A builder has to answer
 * "what am I missing and who gives it to me", which is a different question and is the one that does
 * the work: whoever assembles a comp does not want to read that they are 2 short of Bastion,
 * they want to see the six units that provide it and what they cost.
 *
 * All of this is PURE and computed from the set. There are no meta statistics
 * here: "which traits this unit adds" comes from the game, "which comp wins" does not.
 *
 * ── WHY IT SCORES BY THRESHOLDS AND NOT BY TRAITS ──────────────────────────
 *
 * The temptation is to sort by "how many traits" a unit touches. It gives bad
 * advice: a unit with four traits that completes none is worth less than
 * one with a single trait that closes a tier. In this game the value is in CROSSING
 * the threshold, not in getting close — 5 Bastion and 3 Bastion give the same if the tier
 * is 2 and 6. That is why tiers gained are scored, and traits that only
 * get closer are returned separately, unscored.
 */

/** All the units that provide a trait, with what they cost. */
export function unitsForTrait(traitId: string, set: SetDefinition): UnitDefinition[] {
  return set.units.filter((u) => u.traits.includes(traitId)).sort((a, b) => a.cost - b.cost);
}

/** Quick index trait → tier level reached. */
function levelByTrait(traits: ActiveTrait[]): Map<string, number> {
  return new Map(traits.map((t) => [t.traitId, t.tierIndex]));
}

export interface TraitGain {
  traitId: string;
  name: string;
  /** Tier before and after. `-1` = inactive. */
  from: number;
  to: number;
  /** Count of distinct units after adding it. */
  count: number;
}

export interface UnitSuggestion {
  unitId: string;
  name: string;
  cost: number;
  /** Traits that go UP a tier when it is added. This is what is scored. */
  unlocks: TraitGain[];
  /**
   * Traits it only gets closer to, with what would still be missing. They do not score,
   * but they are half the decision: "this closes nothing, but leaves two at one away".
   */
  progresses: { traitId: string; name: string; toNext: number }[];
  /** Tiers gained. The list order comes from this. */
  score: number;
}

export interface SuggestOptions {
  /** How many to return. By default, 10. */
  limit?: number;
  /** Only units of these costs. */
  costs?: number[];
  /** Only those that provide this trait. This is the panel's "I want to go Bastion". */
  traitId?: string;
  /** Ignore the level's unit cap. By default it is respected. */
  ignoreLevel?: boolean;
}

/**
 * Which unit to add to this comp.
 *
 * It tries adding EVERY unit that is not already there and sees what changes. It is brute
 * force —74 units × a trait count— and instant; any shortcut
 * here would only serve to get emblems wrong.
 *
 * A unit already present is not suggested even if raising its stars is a good
 * idea: that changes no synergy, and mixing it in would hide those that do.
 */
export function suggestUnits(
  comp: Comp,
  set: SetDefinition,
  options: SuggestOptions = {}
): UnitSuggestion[] {
  const { limit = 10, costs, traitId, ignoreLevel = false } = options;

  const alreadyAre = new Set(comp.slots.map((s) => s.unitId));
  const traitById = new Map(set.traits.map((t) => [t.id, t]));
  const before = activateTraits(comp, set);
  const levelBefore = levelByTrait(before);

  // The level cap decides whether one more unit fits. Without a level none is
  // invented: it is suggested anyway and whoever builds resolves it.
  const levels = Object.keys(set.rules.teamSizeByLevel).map(Number);
  const level = comp.level ?? (levels.length ? Math.max(...levels) : undefined);
  const cap = level === undefined ? undefined : set.rules.teamSizeByLevel[level];
  if (!ignoreLevel && cap !== undefined && comp.slots.length >= cap) return [];

  const output: UnitSuggestion[] = [];

  for (const unit of set.units) {
    if (alreadyAre.has(unit.id)) continue;
    if (costs?.length && !costs.includes(unit.cost)) continue;
    if (traitId && !unit.traits.includes(traitId)) continue;

    /**
     * It is added in any free cell: position does not affect
     * synergies, and requiring a specific cell would turn a query into a
     * placement problem that the builder has not solved yet.
     */
    const attempt: Comp = {
      ...comp,
      slots: [...comp.slots, { unitId: unit.id, row: 0, col: 0 }],
    };
    const after = activateTraits(attempt, set);

    const unlocks: TraitGain[] = [];
    const progresses: UnitSuggestion["progresses"] = [];

    for (const t of after) {
      if (!unit.traits.includes(t.traitId)) continue;
      const from = levelBefore.get(t.traitId) ?? -1;
      if (t.tierIndex > from) {
        unlocks.push({ traitId: t.traitId, name: t.name, from, to: t.tierIndex, count: t.count });
      } else if (t.toNext !== null) {
        progresses.push({
          traitId: t.traitId,
          name: traitById.get(t.traitId)?.name ?? t.traitId,
          toNext: t.toNext,
        });
      }
    }

    if (!unlocks.length && !progresses.length) continue;

    output.push({
      unitId: unit.id,
      name: unit.name,
      cost: unit.cost,
      unlocks,
      progresses,
      score: unlocks.length,
    });
  }

  /**
   * Order: first those that close tiers; on a tie, the cheapest. The
   * second matters as much as the first — a 5-gold suggestion that
   * ties with a 1-gold one is not the same suggestion.
   */
  return output
    .sort((a, b) => b.score - a.score || a.cost - b.cost || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Is the comp full for its level?
 *
 * It exists because an empty suggestion list has two reasons that read the
 * same and mean the opposite: nobody else fits, or nobody is left who
 * provides anything. Without telling them apart, the interface says "no suggestions" when
 * what is happening is that you need to level up.
 */
export function compIsFull(comp: Comp, set: SetDefinition): boolean {
  const levels = Object.keys(set.rules.teamSizeByLevel).map(Number);
  const level = comp.level ?? (levels.length ? Math.max(...levels) : undefined);
  if (level === undefined) return false;
  const cap = set.rules.teamSizeByLevel[level];
  return cap !== undefined && comp.slots.length >= cap;
}

export interface TraitPlan {
  traitId: string;
  name: string;
  count: number;
  tierIndex: number;
  /** How many are missing for the next tier. `null` if already at the maximum. */
  toNext: number | null;
  /** Who can provide it, not counting those already in the comp. */
  candidates: { unitId: string; name: string; cost: number }[];
}

/**
 * A trait's panel: where it stands and who completes it.
 *
 * It returns the candidates even if the trait is at the maximum —the list comes out empty—
 * so the interface does not have to distinguish two cases.
 */
export function traitPlan(traitId: string, comp: Comp, set: SetDefinition): TraitPlan | null {
  const def = set.traits.find((t) => t.id === traitId);
  if (!def) return null;

  const actual = activateTraits(comp, set).find((t) => t.traitId === traitId);
  const alreadyAre = new Set(comp.slots.map((s) => s.unitId));

  return {
    traitId,
    name: def.name,
    count: actual?.count ?? 0,
    tierIndex: actual?.tierIndex ?? -1,
    toNext:
      actual?.toNext ??
      (def.tiers.length ? [...def.tiers].sort((a, b) => a.min - b.min)[0].min : null),
    candidates: unitsForTrait(traitId, set)
      .filter((u) => !alreadyAre.has(u.id))
      .map((u) => ({ unitId: u.id, name: u.name, cost: u.cost })),
  };
}

/**
 * Summary of a comp to draw its card.
 *
 * It is exactly what a comp card shows: the active traits, those that
 * came close, and the split by cost. It is returned together and not in three
 * calls because the card is drawn at once.
 */
export function compSummary(comp: Comp, set: SetDefinition) {
  const traits = activateTraits(comp, set);
  const byCost: Record<number, number> = {};
  const costOf = new Map(set.units.map((u) => [u.id, u.cost]));
  for (const s of comp.slots) {
    const c = costOf.get(s.unitId);
    if (c !== undefined) byCost[c] = (byCost[c] ?? 0) + 1;
  }
  return {
    active: onlyActive(traits),
    // The inactive ones with distance: "you are missing 1" is half the advice.
    near: traits.filter((t) => t.tierIndex < 0 && t.toNext !== null),
    unitsByCost: byCost,
    units: comp.slots.length,
  };
}
