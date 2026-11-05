/**
 * Groups and filters of a slot that comes from a dataset:
 * - `groupField`: at most one option from each group (one helmet, not five);
 * - `where`: two slots of the same dataset without sharing options.
 */
import { describe, expect, it } from "vitest";

import { optionsFromEntries } from "../../kons/kon-character-builder/character-builder.dataset";
import {
  compileBuilder,
  validateBuild,
  type BuilderDefinition,
} from "../../kons/kon-character-builder/character-builder.engine";

const row = (id: string, data: Record<string, unknown>) => ({ id, title: id, data });

const PIECES = [
  row("casco-a", { part: "Casco", defense: 10 }),
  row("casco-b", { part: "Casco", defense: 12 }),
  row("peto-a", { part: "Peto", defense: 20 }),
];
const JEWELS = [
  row("j-arm", { va_en: "Armadura" }),
  row("j-arma", { va_en: "Arma" }),
  row("j-sin", {}),
];

describe("optionsFromEntries", () => {
  it("sets the group of each option", () => {
    const { options } = optionsFromEntries(PIECES, {
      datasetId: "d",
      statFields: { defense: "def" },
      groupField: "part",
    });
    expect(options.map((o) => [o.id, o.group])).toEqual([
      ["casco-a", "Casco"],
      ["casco-b", "Casco"],
      ["peto-a", "Peto"],
    ]);
  });

  it("filters with where, and what is filtered does not count as discarded", () => {
    const r = optionsFromEntries(JEWELS, {
      datasetId: "d",
      statFields: {},
      where: { va_en: "Armadura" },
    });
    expect(r.options.map((o) => o.id)).toEqual(["j-arm"]);
    expect(r.skipped).toEqual([]);
  });

  it("without groupField or where, as always", () => {
    const { options } = optionsFromEntries(PIECES, { datasetId: "d", statFields: {} });
    expect(options.every((o) => o.group === undefined)).toBe(true);
    expect(options).toHaveLength(3);
  });
});

describe("validateBuild with groups", () => {
  const { options } = optionsFromEntries(PIECES, {
    datasetId: "d",
    statFields: { defense: "def" },
    groupField: "part",
  });
  const def: BuilderDefinition = {
    id: "t",
    name: "t",
    baseStats: { def: 0 },
    slots: [{ id: "armadura", name: "Armadura", capacity: 5, options }],
    budgets: [],
    derived: [],
    labels: {},
    filterStats: [],
  } as never;
  const compiledOutput = compileBuilder(def);

  it("two from the same group is an error", () => {
    const issues = validateBuild(compiledOutput, { selections: { armadura: ["casco-a", "casco-b"] } });
    expect(issues.some((i) => i.level === "error" && i.message.includes("Casco"))).toBe(true);
  });

  it("one from each group is valid", () => {
    expect(validateBuild(compiledOutput, { selections: { armadura: ["casco-b", "peto-a"] } })).toEqual(
      []
    );
  });
});
