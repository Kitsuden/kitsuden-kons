/**
 * Autobattler — counting traits correctly
 * ============================================================================
 *
 * The synergy calculation is ten lines and there are three classic ways to
 * get it wrong, all three giving a number that looks reasonable:
 *
 *   1. Counting copies instead of distinct units (three Ahri are not three
 *      Challengers).
 *   2. Forgetting emblems, which change the count without changing the unit.
 *   3. Taking the first tier that is passed instead of the HIGHEST reached.
 *
 * Each has its own test here, because none shows up by looking at the screen.
 */

import { describe, expect, test } from "vitest";

import {
  activateTraits,
  compCost,
  componentsOf,
  craftableFrom,
  onlyActive,
  tierFor,
  validateComp,
} from "../../kons/kon-autobattler/autobattler.engine";
import type { SetDefinition } from "../../kons/kon-autobattler/autobattler.types";

const SET: SetDefinition = {
  id: "test-set",
  name: "Set de prueba",
  rules: {
    boardRows: 4,
    boardCols: 7,
    itemsPerUnit: 3,
    teamSizeByLevel: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10 },
    augmentSlots: 3,
    costs: [1, 2, 3, 4, 5],
  },
  units: [
    { id: "ahri", name: "Ahri", cost: 4, traits: ["challenger", "mage"] },
    { id: "yasuo", name: "Yasuo", cost: 1, traits: ["challenger"] },
    { id: "jinx", name: "Jinx", cost: 4, traits: ["challenger", "sniper"] },
    { id: "lux", name: "Lux", cost: 3, traits: ["mage"] },
    { id: "annie", name: "Annie", cost: 2, traits: ["mage"] },
    { id: "leona", name: "Leona", cost: 1, traits: ["bastion"] },
  ],
  traits: [
    {
      id: "challenger",
      name: "Challenger",
      // Tiers UNSORTED on purpose: the engine has to sort them.
      tiers: [
        { min: 4, max: 5, style: 3 },
        { min: 2, max: 3, style: 1 },
        { min: 6, max: 25000, style: 5 },
      ],
    },
    {
      id: "mage",
      name: "Mage",
      tiers: [
        { min: 2, max: 3, style: 1 },
        { min: 4, max: 25000, style: 5 },
      ],
    },
    { id: "sniper", name: "Sniper", tiers: [{ min: 2, max: 25000, style: 1 }] },
    { id: "bastion", name: "Bastion", tiers: [{ min: 2, max: 25000, style: 1 }] },
  ],
  items: [
    { id: "sword", name: "Espada", composition: [] },
    { id: "cloak", name: "Capa", composition: [] },
    { id: "rod", name: "Vara", composition: [] },
    { id: "deathblade", name: "Filo de muerte", composition: ["sword", "sword"] },
    { id: "gunblade", name: "Hoja de pistola", composition: ["sword", "rod"] },
    { id: "crown", name: "Corona", composition: ["rod", "rod"], unique: true },
  ],
  augments: [
    { id: "aug-a", name: "Augment A" },
    { id: "aug-b", name: "Augment B" },
    { id: "aug-c", name: "Augment C" },
    { id: "aug-d", name: "Augment D" },
  ],
};

const at = (unitId: string, row: number, col: number, extra: Record<string, unknown> = {}) => ({
  unitId,
  row,
  col,
  ...extra,
});

// ── The three ways of counting wrong ─────────────────────────────────────────

describe("count distinct units, not copies", () => {
  test("the same unit twice counts ONCE for its trait", () => {
    // Three Ahri are not three Challengers. Without deduplicating, any comp that
    // raises a unit to 2 stars inflates all its synergies.
    const traits = activateTraits(
      { slots: [at("ahri", 0, 0), at("ahri", 0, 1), at("ahri", 0, 2)] },
      SET
    );
    const challenger = traits.find((t) => t.traitId === "challenger")!;
    expect(challenger.count).toBe(1);
    expect(challenger.tierIndex).toBe(-1);
  });

  test("distinct units do add up", () => {
    const traits = activateTraits({ slots: [at("ahri", 0, 0), at("yasuo", 0, 1)] }, SET);
    expect(traits.find((t) => t.traitId === "challenger")!.count).toBe(2);
  });
});

describe("emblems change the count", () => {
  test("an emblem adds the trait and activates the synergy", () => {
    // Without counting the emblem, this comp would have all its traits WRONG.
    const without = activateTraits({ slots: [at("ahri", 0, 0), at("leona", 0, 1)] }, SET);
    expect(without.find((t) => t.traitId === "challenger")!.tierIndex).toBe(-1);

    const withValue = activateTraits(
      { slots: [at("ahri", 0, 0), at("leona", 0, 1, { extraTraits: ["challenger"] })] },
      SET
    );
    const challenger = withValue.find((t) => t.traitId === "challenger")!;
    expect(challenger.count).toBe(2);
    expect(challenger.tier?.style).toBe(1);
  });

  test("an emblem of a trait the unit ALREADY has does not count twice", () => {
    const traits = activateTraits(
      { slots: [at("ahri", 0, 0, { extraTraits: ["challenger"] })] },
      SET
    );
    expect(traits.find((t) => t.traitId === "challenger")!.count).toBe(1);
  });
});

describe("the active tier is the HIGHEST reached", () => {
  test.each([
    [1, -1, null],
    [2, 0, 1],
    [3, 0, 1],
    [4, 1, 3],
    [5, 1, 3],
    [6, 2, 5],
    [9, 2, 5],
  ])("with %i units → tier %i (style %s)", (count, expectedIndex, expectedStyle) => {
    // With 6 and tiers at 2/4/6, the active one is 6 — not the first one passed.
    const { tier, index } = tierFor(SET.traits[0].tiers, count);
    expect(index).toBe(expectedIndex);
    expect(tier?.style ?? null).toBe(expectedStyle);
  });

  test("works even if the tiers come unsorted from the source", () => {
    // Those of the test set are deliberately in order 4, 2, 6.
    expect(tierFor(SET.traits[0].tiers, 5).tier?.min).toBe(4);
  });
});

// ── What makes the tool useful ───────────────────────────────────────────────

describe("also reports what is NOT active", () => {
  test('"you are missing 1" is half of a comp tool', () => {
    const traits = activateTraits({ slots: [at("lux", 0, 0)] }, SET);
    const mage = traits.find((t) => t.traitId === "mage")!;
    expect(mage.tierIndex).toBe(-1);
    expect(mage.toNext).toBe(1);
  });

  test("at maximum, there is no next", () => {
    const slots = [at("ahri", 0, 0), at("lux", 0, 1), at("annie", 0, 2), at("yasuo", 0, 3)];
    const mage = activateTraits({ slots }, SET).find((t) => t.traitId === "mage")!;
    expect(mage.count).toBe(3);
    expect(mage.toNext).toBe(1);

    const withJinx = activateTraits({ slots: [...slots, at("jinx", 1, 0)] }, SET);
    const challenger = withJinx.find((t) => t.traitId === "challenger")!;
    expect(challenger.count).toBe(3);
  });

  test("active ones come first and by tier level", () => {
    const traits = activateTraits(
      { slots: [at("ahri", 0, 0), at("yasuo", 0, 1), at("jinx", 0, 2), at("lux", 0, 3)] },
      SET
    );
    expect(traits[0].traitId).toBe("challenger"); // 3 → style 1, the highest active
    expect(
      onlyActive(traits)
        .map((t) => t.traitId)
        .sort()
    ).toEqual(["challenger", "mage"]);
  });

  test("says which units contribute each trait, to point them out", () => {
    const traits = activateTraits({ slots: [at("ahri", 0, 0), at("jinx", 0, 1)] }, SET);
    expect(traits.find((t) => t.traitId === "challenger")!.unitIds.sort()).toEqual([
      "ahri",
      "jinx",
    ]);
  });
});

// ── Items ────────────────────────────────────────────────────────────────────

describe("item recipes", () => {
  test("two swords make Filo, not Hoja de pistola", () => {
    const facts = craftableFrom(["sword", "sword"], SET.items).map((i) => i.id);
    expect(facts).toContain("deathblade");
    expect(facts).not.toContain("gunblade");
  });

  test("a lone sword does nothing", () => {
    expect(craftableFrom(["sword"], SET.items)).toEqual([]);
  });

  test("counts repeats: sword + rod do not make Corona", () => {
    const facts = craftableFrom(["sword", "rod"], SET.items).map((i) => i.id);
    expect(facts).toEqual(["gunblade"]);
  });

  test("an item's components are resolved", () => {
    expect(componentsOf("deathblade", SET.items)).toEqual(["sword", "sword"]);
    expect(componentsOf("sword", SET.items)).toEqual(["sword"]);
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe("an invalid comp is explained, it does not blow up", () => {
  const ok = { slots: [at("ahri", 0, 0), at("yasuo", 1, 1)], level: 9, augments: ["aug-a"] };

  test("a healthy comp has no problems", () => {
    expect(validateComp(ok, SET)).toEqual([]);
  });

  test("never throws, not even with a half-built comp", () => {
    // An editor that blows up on every keystroke cannot be used.
    expect(() => validateComp({ slots: [at("nope", 99, 99)] }, SET)).not.toThrow();
    expect(validateComp({ slots: [] }, SET)).toEqual([]);
  });

  test("more units than the level allows", () => {
    const slots = SET.units.map((u, i) => at(u.id, 0, i));
    const issues = validateComp({ slots, level: 4 }, SET);
    expect(issues.some((i) => i.includes("fits 4"))).toBe(true);
  });

  test("two units in the same cell", () => {
    const issues = validateComp({ slots: [at("ahri", 1, 1), at("lux", 1, 1)] }, SET);
    expect(issues.some((i) => i.includes("same cell"))).toBe(true);
  });

  test("off the board", () => {
    expect(validateComp({ slots: [at("ahri", 4, 0)] }, SET).some((i) => i.includes("off the board"))).toBe(
      true
    );
    expect(validateComp({ slots: [at("ahri", 0, 7)] }, SET).some((i) => i.includes("off the board"))).toBe(
      true
    );
  });

  test("too many items and repeated unique items", () => {
    const four = validateComp(
      { slots: [at("ahri", 0, 0, { items: ["sword", "cloak", "rod", "sword"] })] },
      SET
    );
    expect(four.some((i) => i.includes("the maximum is 3"))).toBe(true);

    const twoCrowns = validateComp(
      { slots: [at("ahri", 0, 0, { items: ["crown", "crown"] })] },
      SET
    );
    expect(twoCrowns.some((i) => i.includes("unique item"))).toBe(true);
  });

  test("units, items, traits and augments that do not exist", () => {
    const issues = validateComp(
      {
        slots: [at("fantasma", 0, 0, { items: ["nothing"], extraTraits: ["invented"] })],
        augments: ["aug-x"],
      },
      SET
    );
    expect(issues.filter((i) => i.includes("does not exist")).length).toBe(4);
  });

  test("too many augments", () => {
    const issues = validateComp({ slots: [], augments: ["aug-a", "aug-b", "aug-c", "aug-d"] }, SET);
    expect(issues.some((i) => i.includes("the maximum is 3"))).toBe(true);
  });

  test("without a level, the set's highest is assumed", () => {
    const slots = SET.units.map((u, i) => at(u.id, 0, i));
    expect(validateComp({ slots }, SET)).toEqual([]);
  });
});

describe("how much it costs to put the comp together", () => {
  test("stars multiply copies by 3", () => {
    // A 2-star unit is 3 copies; a 3-star, 9.
    expect(compCost({ slots: [at("ahri", 0, 0)] }, SET)).toBe(4);
    expect(compCost({ slots: [at("ahri", 0, 0, { star: 2 })] }, SET)).toBe(12);
    expect(compCost({ slots: [at("ahri", 0, 0, { star: 3 })] }, SET)).toBe(36);
  });

  test("adds up the whole comp", () => {
    expect(compCost({ slots: [at("ahri", 0, 0), at("yasuo", 0, 1, { star: 3 })] }, SET)).toBe(
      4 + 9
    );
  });
});
