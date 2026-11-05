/**
 * The team builder: which unit is worth adding and why
 * ============================================================================
 *
 * `activateTraits` answers "what do I have". This answers "what am I missing and who
 * gives it to me", which is the question that does the work in a builder.
 *
 * What it watches, which is where bad advice lives:
 *
 *   · That scoring is by tiers CROSSED and not by traits touched. A unit with
 *     four traits that completes none is worth less than one with one that
 *     closes a tier, and sorting by "how many traits it touches" inverts that.
 *   · That emblems count, because they change the count without changing the unit.
 *   · That a full comp says it is full, instead of returning an empty list
 *     that reads as "there is nothing to add".
 */

import { describe, expect, it } from "vitest";

import {
  compIsFull,
  compSummary,
  suggestUnits,
  traitPlan,
  unitsForTrait,
} from "../../kons/kon-autobattler/autobattler.builder";
import type { SetDefinition } from "../../kons/kon-autobattler/autobattler.types";

/**
 * A minimal set with two traits of different thresholds.
 *
 * `Bastion` at 2/4 and `Mago` at 2. Enough for "crossing the threshold" and "touching
 * the trait" to give different answers, which is what must be distinguishable.
 */
const SET: SetDefinition = {
  id: "prueba",
  name: "Evidence",
  rules: {
    boardRows: 4,
    boardCols: 7,
    itemsPerUnit: 3,
    teamSizeByLevel: { 1: 1, 2: 2, 3: 3, 8: 8 },
    augmentSlots: 3,
    costs: [1, 2, 3, 4, 5],
  },
  units: [
    { id: "u_bast1", name: "Bastión A", cost: 1, traits: ["bastion"] },
    { id: "u_bast2", name: "Bastión B", cost: 4, traits: ["bastion"] },
    { id: "u_bast3", name: "Bastión C", cost: 1, traits: ["bastion"] },
    { id: "u_mago1", name: "Mago A", cost: 2, traits: ["mago"] },
    { id: "u_mixto", name: "Mixto", cost: 5, traits: ["bastion", "mago"] },
    { id: "u_suelto", name: "Suelto", cost: 3, traits: ["nadie"] },
  ],
  traits: [
    {
      id: "bastion",
      name: "Bastión",
      tiers: [
        { min: 2, max: 25000, style: 1 },
        { min: 4, max: 25000, style: 3 },
      ],
    },
    { id: "mago", name: "Mago", tiers: [{ min: 2, max: 25000, style: 1 }] },
    { id: "nadie", name: "Nadie", tiers: [{ min: 3, max: 25000, style: 1 }] },
  ],
  items: [],
  augments: [],
};

const slot = (unitId: string, col = 0) => ({ unitId, row: 0, col });

describe("who to add", () => {
  it("prioritizes crossing a threshold over touching many traits", () => {
    /**
     * With 1 Bastion placed, adding another Bastion closes the tier of 2. `Mixto`
     * touches TWO traits but closes none (leaves Bastion at 2… which does close it).
     * `Mago A`, which closes nothing, is used as the control.
     */
    const comp = { level: 8, slots: [slot("u_bast1")] };
    const s = suggestUnits(comp, SET);

    const bast = s.find((x) => x.unitId === "u_bast3")!;
    const wizard = s.find((x) => x.unitId === "u_mago1")!;

    expect(bast.score, "closing Bastion 2 is a tier gained").toBe(1);
    expect(wizard.score, "a lone Mago does not reach its threshold of 2").toBe(0);
    expect(s.indexOf(bast)).toBeLessThan(s.indexOf(wizard));
  });

  it("with equal tiers, the cheapest first", () => {
    // `u_bast1` (1 gold) and `u_bast2` (4) close exactly the same.
    const comp = { level: 8, slots: [slot("u_bast3")] };
    const s = suggestUnits(comp, SET).filter((x) => x.unitId.startsWith("u_bast"));
    expect(s[0].unitId, "a 5-gold suggestion is not the same as a 1-gold one").toBe("u_bast1");
  });

  it("says which traits it only gets CLOSER to, without scoring them", () => {
    const comp = { level: 8, slots: [slot("u_bast1")] };
    const wizard = suggestUnits(comp, SET).find((x) => x.unitId === "u_mago1")!;

    expect(wizard.unlocks).toEqual([]);
    // "closes nothing, but leaves Mago at one" is half a decision.
    expect(wizard.progresses).toEqual([{ traitId: "mago", name: "Mago", toNext: 1 }]);
  });

  it("emblems count", () => {
    /**
     * A unit with a Bastion emblem contributes the trait without being a Bastion. If the
     * suggester ignored it, it would recommend a Bastion that is already surplus.
     */
    const withEmblem = {
      level: 8,
      slots: [slot("u_bast1"), { ...slot("u_mago1", 1), extraTraits: ["bastion"] }],
    };
    const s = suggestUnits(withEmblem, SET);
    const bast = s.find((x) => x.unitId === "u_bast3");
    // Bastion is already at 2 thanks to the emblem: the next tier is 4,
    // so one more unit closes NOTHING.
    expect(bast?.unlocks ?? []).toEqual([]);
  });

  it("does not suggest a unit that is already there", () => {
    const comp = { level: 8, slots: [slot("u_bast1")] };
    expect(suggestUnits(comp, SET).some((x) => x.unitId === "u_bast1")).toBe(false);
  });

  it("filters by trait and by cost", () => {
    const comp = { level: 8, slots: [] };
    const bastionOnly = suggestUnits(comp, SET, { traitId: "bastion" });
    expect(bastionOnly.every((x) => x.unitId !== "u_mago1")).toBe(true);

    const cheap = suggestUnits(comp, SET, { costs: [1] });
    expect(cheap.map((x) => x.cost)).toEqual(cheap.map(() => 1));
  });

  it("a full comp returns no suggestions, and it is known why", () => {
    /**
     * An empty list for "nobody fits" and for "nobody contributes" read the same and
     * mean the opposite: one asks to level up and the other to change
     * plan.
     */
    const full = { level: 2, slots: [slot("u_bast1"), slot("u_bast3", 1)] };
    expect(suggestUnits(full, SET)).toEqual([]);
    expect(compIsFull(full, SET)).toBe(true);
    expect(suggestUnits(full, SET, { ignoreLevel: true }).length).toBeGreaterThan(0);
  });
});

describe("the panel of a trait", () => {
  it("says where it stands and who completes it", () => {
    const comp = { level: 8, slots: [slot("u_bast1")] };
    const plan = traitPlan("bastion", comp, SET)!;

    expect(plan.count).toBe(1);
    expect(plan.tierIndex, "1 does not reach the threshold of 2").toBe(-1);
    expect(plan.toNext).toBe(1);
    // Without the one already placed: offering a unit you already have is noise.
    expect(plan.candidates.map((c) => c.unitId)).not.toContain("u_bast1");
    expect(plan.candidates.map((c) => c.unitId)).toContain("u_bast3");
  });

  it("a trait that does not exist does not blow up", () => {
    expect(traitPlan("no-existe", { slots: [] }, SET)).toBeNull();
  });

  it("`unitsForTrait` comes sorted by cost", () => {
    const u = unitsForTrait("bastion", SET).map((x) => x.cost);
    expect(u).toEqual([...u].sort((a, b) => a - b));
  });
});

describe("summary of the record", () => {
  it("separates active ones from those that stayed close", () => {
    const comp = { level: 8, slots: [slot("u_bast1"), slot("u_bast3", 1), slot("u_mago1", 2)] };
    const r = compSummary(comp, SET);

    expect(r.active.map((t) => t.traitId)).toEqual(["bastion"]);
    expect(
      r.near.map((t) => t.traitId),
      "Mago with 1 of 2 is a warning, not an active trait"
    ).toEqual(["mago"]);
    expect(r.unitsByCost).toEqual({ 1: 2, 2: 1 });
    expect(r.units).toBe(3);
  });
});
