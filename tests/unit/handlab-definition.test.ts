/**
 * The hand generator (kon-cardsim `/hands`) — the translation from "dataset" to "game"
 * ============================================================================
 *
 * The whole hand generator rests on one idea: a card dataset plus four rules
 * becomes the smallest game definition that the cardsim engine
 * accepts, and from there dealing and counting is already-tested code.
 *
 * What is guarded here is that this translation produces definitions that the
 * engine considers VALID —otherwise the error would show up when asking for the first hand—
 * and that impossible rules are caught when creating the dataset, not afterwards.
 */

import { describe, expect, test } from "vitest";

import { validateDeck, validateGameDefinition } from "../../kons/kon-cardsim/cardsim.deck";
import { dealHands, goldfish } from "../../kons/kon-cardsim/cardsim.goldfish";
import {
  definitionFor,
  validateRules,
  type DatasetRules,
} from "../../kons/kon-cardsim/handlab.definition";

const RULES: DatasetRules = {
  slug: "pokepocket",
  name: "Pokémon TCG Pocket",
  handSize: 5,
  deckMin: 20,
  deckMax: 20,
  maxCopies: 2,
};

// ── The rules are checked BEFORE saving them ─────────────────────────────────

describe("impossible rules are caught when creating the dataset", () => {
  test("sound rules pass", () => {
    expect(validateRules(RULES)).toEqual([]);
  });

  test("a hand larger than the minimum deck is rejected", () => {
    // It would be a dataset unable to deal even one hand, and the error would show up the
    // first time someone asked for cards — when nobody remembers anymore.
    const errors = validateRules({ ...RULES, handSize: 25 });
    expect(errors.some((e) => e.includes("does not fit"))).toBe(true);
  });

  test("a minimum greater than the maximum is rejected", () => {
    expect(validateRules({ ...RULES, deckMin: 40, deckMax: 20 }).length).toBeGreaterThan(0);
  });

  test("zero copies or zero cards in hand are rejected", () => {
    expect(validateRules({ ...RULES, maxCopies: 0 }).length).toBeGreaterThan(0);
    expect(validateRules({ ...RULES, handSize: 0 }).length).toBeGreaterThan(0);
  });
});

// ── The synthesized definition is valid for the engine ───────────────────────

describe("the minimal definition is accepted by the cardsim engine", () => {
  test("has not a single validation error", () => {
    // It is the SAME validator cardsim uses: if handlab had its own, the
    // two branches would diverge and a deck legal here would be illegal there.
    expect(validateGameDefinition(definitionFor(RULES))).toEqual([]);
  });

  test.each([
    ["Pokémon Pocket", { handSize: 5, deckMin: 20, deckMax: 20, maxCopies: 2 }],
    ["Shadowverse", { handSize: 3, deckMin: 40, deckMax: 40, maxCopies: 3 }],
    ["Hearthstone", { handSize: 3, deckMin: 30, deckMax: 30, maxCopies: 2 }],
    ["Lorcana-ish", { handSize: 7, deckMin: 60, deckMax: 200, maxCopies: 4 }],
  ])("the real rules of %s produce a valid definition", (_name, rules) => {
    const def = definitionFor({ slug: "x", name: "X", ...rules });
    expect(validateGameDefinition(def)).toEqual([]);
    expect(def.openingHand).toBe(rules.handSize);
    expect(def.deckRules.maxCopies).toBe(rules.maxCopies);
  });

  test("only declares the two zones that are needed", () => {
    // No table, no discard pile, no meaningful phases: the question "what hands
    // does this deck make?" does not need a board.
    const def = definitionFor(RULES);
    expect(def.zones.map((z) => z.id)).toEqual(["deck", "hand"]);
    expect(def.resources).toEqual([]);
    expect(def.players).toEqual({ min: 1, max: 1 });
  });

  test("per-card caps reach the deck rules", () => {
    // It is what lets Hearthstone (2 copies, but 1 if legendary) be
    // described without writing code.
    const def = definitionFor({ ...RULES, maxCopies: 2, copyLimits: { legendaria: 1 } });
    expect(def.deckRules.copyLimits).toEqual({ legendaria: 1 });
  });
});

// ── And with it, the engine does its job ─────────────────────────────────────

describe("any dataset deals hands and produces statistics", () => {
  const def = definitionFor(RULES);
  /** 10 different cards × 2 copies = the exact 20 that Pocket asks for. */
  const deck = Array.from({ length: 20 }, (_, i) => `c-${Math.floor(i / 2)}`);
  const catalog = Object.fromEntries(
    deck.map((id, i) => [id, { type: i % 3 === 0 ? "Pokemon" : "Trainer", isBasic: i % 3 === 0 }])
  );

  test("the deck is legal with the dataset's rules", () => {
    expect(validateDeck(def, deck, catalog)).toEqual([]);
  });

  test("one copy too many is rejected", () => {
    expect(validateDeck(def, [...deck.slice(0, 19), "c-0"], catalog).length).toBeGreaterThan(0);
  });

  test("deals hands of the size the rules say", () => {
    const dealt = dealHands(def, deck, { count: 4, seed: 7 });
    expect(dealt.handSize).toBe(5);
    expect(dealt.deckSize).toBe(20);
    expect(dealt.hands).toHaveLength(4);
    expect(dealt.hands[0].opening).toHaveLength(5);
  });

  test("same seed, same hands", () => {
    expect(dealHands(def, deck, { count: 3, seed: 42 })).toEqual(
      dealHands(def, deck, { count: 3, seed: 42 })
    );
  });

  test("and the goldfish answers the consistency question", () => {
    // In Pocket, without a Basic in the starting hand you cannot even start.
    const report = goldfish(
      def,
      deck,
      catalog,
      [
        {
          id: "basico",
          label: "at least 1 Basic in the starting hand",
          turn: 1,
          require: [
            { label: "Básico", filters: [{ property: "isBasic", truthy: true }], count: 1 },
          ],
        },
      ],
      { iterations: 5000, seed: 3 }
    );
    expect(report.deckSize).toBe(20);
    expect(report.queries[0].requirements[0].inDeck).toBeGreaterThan(0);
    expect(report.queries[0].probability).toBeGreaterThan(0.5);
  });
});
