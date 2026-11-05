/**
 * The TCG and the character builder are fed from datasets
 * ============================================================================
 *
 * ── WHAT THERE WAS ─────────────────────────────────────────────────────────
 *
 * Three kons with a catalog and three different ways of getting it:
 *
 *   · `kon-tierlist` read `data_sets`/`data_entries` — fine, with `checkReadAccess`.
 *   · `kon-cardsim` forced sending all 2,876 cards in the request body, so the
 *     catalog lived TWICE: in the dataset the team edits and in
 *     `cardsim_cards`.
 *   · `kon-character-builder` stored the options inside the definition's JSON, that is
 *     the whole catalog in a document that has to be rewritten by patch.
 *
 * Two copies of a catalog drift apart as soon as someone fixes a typo in
 * only one of them.
 *
 * ── WHAT IT GUARDS ─────────────────────────────────────────────────────────
 *
 * Above all one thing that is not visible in a review: that no kon writes
 * its OWN dataset reader. The copy that silently goes out of sync is
 * the access control one — a `SELECT ... FROM data_entries` without
 * `checkReadAccess` is enough to turn a kon into a backdoor to someone else's
 * private datasets.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  datasetSlots,
  optionsFromEntries,
  withDatasetOptions,
} from "../../kons/kon-character-builder/character-builder.dataset";
import { cardsFromEntries } from "../../kons/kon-cardsim/cardsim.dataset";

const ROOT = join(__dirname, "..", "..");
const source = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const row = (id: string, title: string, data: Record<string, unknown> = {}) => ({
  id,
  title,
  data,
});

// ── There is a single reader ─────────────────────────────────────────────────

describe("a single dataset reader", () => {
  const KONS = ["kon-cardsim", "kon-character-builder", "kon-tierlist"];

  it.each(KONS)("%s does not query the dataset tables on its own", (kon) => {
    /**
     * The reason is not to save lines: it is that a custom reader that forgets
     * `checkReadAccess` does not fail — it returns data. An access failure that
     * returns data is never detected in manual testing.
     */
    const files = source("kons", kon, "index.ts");
    expect(
      /FROM\s+data_entries|FROM\s+data_sets/i.test(files),
      `${kon} queries the dataset tables directly: it has to go through ` +
        "`readDatasetCatalog`, which is what checks access."
    ).toBe(false);
    expect(files).toContain("readDatasetCatalog");
  });

  it("the shared reader checks access", () => {
    const reader = source(".kitsuden", "packages", "shared", "src", "dataset-catalog.ts");
    expect(reader).toContain("checkReadAccess");
    // And it does not distinguish "does not exist" from "you can't": telling them apart turns the
    // route into an oracle for which datasets exist.
    expect(reader).toContain("if (!dataset) return null;");
  });
});

// ── TCG ──────────────────────────────────────────────────────────────────────

describe("cards from a dataset", () => {
  it("the `cardId` comes from the declared field, not from guessing", () => {
    const { cards, idSource } = cardsFromEntries(
      [row("row-1", "Cangrejo de Fuego", { code: "OP01-025", color: "Rojo" })],
      { idField: "code" }
    );
    expect(cards[0].cardId).toBe("OP01-025");
    expect(cards[0].name).toBe("Cangrejo de Fuego");
    expect(idSource).toContain("code");
  });

  it("without a declared field it uses the row id and SAYS SO", () => {
    /**
     * `card_id` is what saved decks reference. Silently falling back to a row
     * id would only be discovered the day someone picks another field and
     * all the decks point to nothing.
     */
    const { cards, idSource } = cardsFromEntries([row("row-1", "Carta")]);
    expect(cards[0].cardId).toBe("row-1");
    expect(idSource).toBe("dataset row id");
  });

  it("the data goes in whole: `validateDeck` reads from there", () => {
    const { cards } = cardsFromEntries([row("r", "C", { color: "Rojo", coste: 3 })]);
    // Trimming it would break per-group and per-color caps that the
    // game definition can declare and this side does not know about.
    expect(cards[0].data).toEqual({ color: "Rojo", coste: 3 });
  });

  it("a repeated id collapses BEFORE the unique index, and it is reported", () => {
    /**
     * In Palworld `SOUL-001` appears once for each starter deck. Without
     * collapsing, both would go to `createMany` and the unique index
     * `(game_id, card_id)` would bring down a 400-card dump over two rows.
     */
    const { cards, skipped } = cardsFromEntries(
      [row("a", "Alma v1", { code: "SOUL-001" }), row("b", "Alma v2", { code: "SOUL-001" })],
      { idField: "code" }
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].name, "the last one wins, just like the batch import").toBe("Alma v2");
    expect(skipped[0].reason).toContain("repeated");
  });

  it("a row without an id is discarded with its reason", () => {
    const { cards, skipped } = cardsFromEntries([row("a", "Sin código", {})], {
      idField: "code",
    });
    expect(cards).toHaveLength(0);
    expect(skipped[0].reason).toContain("code");
  });

  it("only what is already a URL is accepted as an image", () => {
    /**
     * An `image` field holds a media id. Putting a uuid in a `src` gives
     * a broken image, which reads as "has no photo" and not as "the id
     * must be resolved".
     */
    const uuid = cardsFromEntries([row("a", "C", { img: "9f1c-uuid" })], { imageField: "img" });
    const url = cardsFromEntries([row("a", "C", { img: "https://x/y.png" })], {
      imageField: "img",
    });
    expect(uuid.cards[0].imageUrl).toBeUndefined();
    expect(url.cards[0].imageUrl).toBe("https://x/y.png");
  });
});

// ── Character builder ────────────────────────────────────────────────────────

describe("builder options from a dataset", () => {
  const slotSource = {
    datasetId: "ds1",
    idField: "code",
    costField: "points",
    statFields: { attack: "atk_flat", critico: "crit_rate" },
  };

  it("the field → stat map is explicit", () => {
    const { options } = optionsFromEntries(
      [row("r", "Espada Larga", { code: "sword", attack: 120, critico: 5, points: 2 })],
      slotSource
    );
    expect(options[0]).toEqual({
      id: "sword",
      name: "Espada Larga",
      modifiers: [
        { stat: "atk_flat", value: 120 },
        { stat: "crit_rate", value: 5 },
      ],
      cost: 2,
    });
  });

  it("an empty field is not a zero", () => {
    /**
     * Putting in zeros would fill every option with inert modifiers and make
     * any explanation of why a build adds up to what it does unreadable.
     */
    const { options } = optionsFromEntries(
      [row("r", "Anillo", { code: "ring", attack: null, critico: 3 })],
      slotSource
    );
    expect(options[0].modifiers).toEqual([{ stat: "crit_rate", value: 3 }]);
  });

  it("a number stored as text is still a number", () => {
    // Datasets often store text: a discarded "120" leaves the build
    // calculating with one stat missing and saying nothing.
    const { options } = optionsFromEntries(
      [row("r", "Espada", { code: "s", attack: "120" })],
      slotSource
    );
    expect(options[0].modifiers).toEqual([{ stat: "atk_flat", value: 120 }]);
  });

  it("the image comes from the catalog's image field, and only if it is a URL", () => {
    const rows = [
      { id: "a", title: "Con foto", data: { portrait: "https://cdn.example/a.png" } },
      { id: "b", title: "Id de medio", data: { portrait: "3f1c1d7e-2b8a-4c55-9d0e-6a7b8c9d0e1f" } },
      { id: "c", title: "Maliciosa", data: { portrait: "javascript:alert(1)" } },
    ];
    const { options } = optionsFromEntries(rows, { datasetId: "ds", statFields: {} }, "portrait");
    expect(options.map((o) => o.imageUrl)).toEqual([
      "https://cdn.example/a.png",
      undefined,
      undefined,
    ]);

    // Without a declared field, no option makes up an image
    const without = optionsFromEntries(rows, { datasetId: "ds", statFields: {} });
    expect(without.options.every((o) => !("imageUrl" in o))).toBe(true);
  });

  it("what is written by hand wins over the dataset's", () => {
    /**
     * It lets you fix a badly entered row without fixing the dataset first, and
     * it is the least surprising direction: the specific wins over the general.
     */
    const definition = {
      id: "b",
      name: "B",
      baseStats: {},
      budgets: [],
      derived: [],
      slots: [
        {
          id: "weapon",
          name: "Arma",
          capacity: 1,
          options: [{ id: "sword", name: "Espada corregida", modifiers: [] }],
        },
      ],
    };
    const merged = withDatasetOptions(
      definition,
      new Map([["weapon", [{ id: "sword", name: "Del dataset", modifiers: [] }]]])
    );
    expect(merged.slots[0].options).toHaveLength(1);
    expect(merged.slots[0].options[0].name).toBe("Espada corregida");
  });

  it("dataset options are ADDED, they do not replace", () => {
    const definition = {
      id: "b",
      name: "B",
      baseStats: {},
      budgets: [],
      derived: [],
      slots: [
        { id: "weapon", name: "Arma", capacity: 1, options: [{ id: "a", name: "A", modifiers: [] }] },
      ],
    };
    const merged = withDatasetOptions(
      definition,
      new Map([["weapon", [{ id: "b", name: "B", modifiers: [] }]]])
    );
    expect(merged.slots[0].options.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("without datasets the definition comes back intact", () => {
    const definition = { id: "b", name: "B", baseStats: {}, budgets: [], derived: [], slots: [] };
    expect(withDatasetOptions(definition, new Map())).toBe(definition);
    expect(datasetSlots(definition)).toEqual([]);
  });

  it("`datasetSlots` returns only those that declare an origin", () => {
    const definition = {
      id: "b",
      name: "B",
      baseStats: {},
      budgets: [],
      derived: [],
      slots: [
        { id: "manual", name: "M", capacity: 1, options: [] },
        { id: "desde-ds", name: "D", capacity: 1, options: [], optionsFrom: slotSource },
      ],
    };
    expect(datasetSlots(definition as never).map((s) => s.id)).toEqual(["desde-ds"]);
  });
});
