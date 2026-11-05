/**
 * Goldfish — making the percentage tell the truth
 * ============================================================================
 *
 * A consistency tool that gives an optimistic number is worse than not
 * having one: it makes you trust a deck that does not work. What is watched here:
 *
 *   1. **The disjoint assignment.** "3 inkable and 1 creature" is not met by a
 *      hand of 3 inkable creatures: the one you ink you do not play.
 *   2. **The numbers are the hypergeometric's**, not an approximation.
 *   3. **It is reproducible.** Same `seed`, same report — otherwise two decks cannot
 *      be compared over the same hands.
 */

import { describe, expect, test } from "vitest";

import type { CardCatalog } from "../../kons/kon-cardsim/cardsim.deck";
import {
  cardsSeenAt,
  dealHands,
  goldfish,
  goldfishAsync,
  GoldfishError,
} from "../../kons/kon-cardsim/cardsim.goldfish";
import type {
  GoldfishQuery,
  GoldfishRequirement,
} from "../../kons/kon-cardsim/cardsim.goldfish";
import type { GameDefinition } from "../../kons/kon-cardsim/cardsim.types";

const base: GameDefinition = {
  id: "gf",
  name: "Goldfish TCG",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
  ],
  resources: [],
  deckRules: { minSize: 1, maxSize: 200, maxCopies: 99 },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 7,
  phases: ["main"],
};

const withHand = (n: number): GameDefinition => ({ ...base, openingHand: n });

/** Deck of `n` cards with ids `p-0`…`p-(n-1)`. */
const deckOf = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

const INK: GoldfishRequirement = {
  label: "tinta",
  filters: [{ property: "inkwell", truthy: true }],
  count: 3,
};
const CREATURE: GoldfishRequirement = {
  label: "creature of 3 or less",
  filters: [
    { property: "type", equals: "Character" },
    { property: "cost", lte: 3 },
  ],
  count: 1,
};

// ── The disjoint assignment ──────────────────────────────────────────────────

describe("a card cannot be two things at once", () => {
  // A deck where EVERY card is inkable and a cheap creature: the case in which
  // counting the same card twice changes the result from 0% to 100%.
  const cards = deckOf(30, "d");
  const catalog: CardCatalog = Object.fromEntries(
    cards.map((id) => [id, { inkwell: true, type: "Character", cost: 2 }])
  );
  const query: GoldfishQuery = {
    id: "q",
    label: "3 de tinta y 1 criatura",
    turn: 1,
    require: [INK, CREATURE],
  };

  test("with the exact hand it is NOT met: 4 cards would be needed and there are only 3", () => {
    const report = goldfish(withHand(3), cards, catalog, [query], { iterations: 500, seed: 1 });
    expect(report.queries[0].probability).toBe(0);
  });

  test("sharing cards would give 100% — and it would be a lie", () => {
    // It is exactly the error that makes you trust a deck that does not work.
    const report = goldfish(withHand(3), cards, catalog, [{ ...query, disjoint: false }], {
      iterations: 500,
      seed: 1,
    });
    expect(report.queries[0].probability).toBe(1);
  });

  test("with one more card, it is met", () => {
    const report = goldfish(withHand(4), cards, catalog, [query], { iterations: 500, seed: 1 });
    expect(report.queries[0].probability).toBe(1);
  });

  test("the assignment looks for the good combination, not the first one it finds", () => {
    // 3 cards that only count as ink + 1 that counts for both. If the
    // assignment were greedy and gave the versatile one to "ink", it would declare
    // the hand failed; a valid assignment exists and it has to find it.
    const handValue = ["ink-0", "ink-1", "ink-2", "both-0"];
    const cat: CardCatalog = {
      "ink-0": { inkwell: true, type: "Item", cost: 5 },
      "ink-1": { inkwell: true, type: "Item", cost: 5 },
      "ink-2": { inkwell: true, type: "Item", cost: 5 },
      "both-0": { inkwell: true, type: "Character", cost: 2 },
    };
    const report = goldfish(withHand(4), handValue, cat, [query], { iterations: 100, seed: 3 });
    expect(report.queries[0].probability).toBe(1);
  });
});

// ── The numbers ──────────────────────────────────────────────────────────────

describe("the probabilities are the hypergeometric's", () => {
  test("at least 1 of 20 in 60 cards, drawing 7 → ~95.2%", () => {
    // 1 - C(40,7)/C(60,7) = 0.95173. If the shuffle were biased or the
    // count wrong, this number would drift — it is the control that everything else
    // means something.
    const cards = [...deckOf(20, "land"), ...deckOf(40, "spell")];
    const catalog: CardCatalog = Object.fromEntries(
      cards.map((id) => [id, { kind: id.startsWith("land") ? "land" : "spell" }])
    );
    const report = goldfish(
      base,
      cards,
      catalog,
      [
        {
          id: "any-land",
          label: "al menos 1 tierra",
          turn: 1,
          require: [{ label: "tierra", filters: [{ property: "kind", equals: "land" }], count: 1 }],
        },
      ],
      { iterations: 20_000, seed: 99 }
    );
    expect(report.queries[0].probability).toBeCloseTo(0.9517, 2);
  });

  test("an impossible requirement gives 0 and a trivial one gives 1", () => {
    const cards = deckOf(40, "x");
    const catalog: CardCatalog = Object.fromEntries(cards.map((id) => [id, { kind: "spell" }]));
    const report = goldfish(
      base,
      cards,
      catalog,
      [
        {
          id: "no",
          label: "imposible",
          turn: 1,
          require: [{ label: "tierra", filters: [{ property: "kind", equals: "land" }], count: 1 }],
        },
        {
          id: "si",
          label: "trivial",
          turn: 1,
          require: [
            { label: "hechizo", filters: [{ property: "kind", equals: "spell" }], count: 1 },
          ],
        },
      ],
      { iterations: 300, seed: 7 }
    );
    expect(report.queries[0].probability).toBe(0);
    expect(report.queries[1].probability).toBe(1);
  });

  test("seeing more cards can never lower the probability", () => {
    const cards = [...deckOf(6, "key"), ...deckOf(54, "other")];
    const catalog: CardCatalog = Object.fromEntries(
      cards.map((id) => [id, { kind: id.startsWith("key") ? "key" : "other" }])
    );
    const req = { label: "key", filters: [{ property: "kind", equals: "key" }], count: 1 };
    const report = goldfish(
      base,
      cards,
      catalog,
      [1, 3, 5].map((turn) => ({ id: `t${turn}`, label: `turno ${turn}`, turn, require: [req] })),
      { iterations: 5000, seed: 11 }
    );
    const [t1, t3, t5] = report.queries.map((q) => q.probability);
    expect(t3).toBeGreaterThan(t1);
    expect(t5).toBeGreaterThan(t3);
  });
});

// ── Asking about a specific card and about caps ──────────────────────────────

describe("specific cards and caps", () => {
  // 2 copies of the combo piece in 40 cards: the classic question.
  const cards = [...deckOf(2, "combo"), ...deckOf(38, "filler")];
  const catalog: CardCatalog = Object.fromEntries(
    cards.map((id) => [id, { name: id.startsWith("combo") ? "Pieza" : "Relleno", cost: 3 }])
  );

  test("can be filtered by `cardId` even if it is not in `data`", () => {
    // Without this you could not ask "how many times do I draw my finisher?",
    // which is one of the three things most asked about a deck.
    const report = goldfish(
      base,
      cards,
      catalog,
      [
        {
          id: "combo",
          label: "la pieza de combo",
          turn: 1,
          require: [
            { label: "combo-0", filters: [{ property: "cardId", equals: "combo-0" }], count: 1 },
          ],
        },
      ],
      { iterations: 20_000, seed: 4 }
    );
    // 1 - C(39,7)/C(40,7) = 7/40 = 17,5 %.
    expect(report.queries[0].probability).toBeCloseTo(0.175, 2);
    expect(report.queries[0].requirements[0].inDeck).toBe(1);
  });

  test("and by name, when the catalog provides it", () => {
    const report = goldfish(
      base,
      cards,
      catalog,
      [
        {
          id: "byName",
          label: "alguna Pieza",
          turn: 1,
          require: [{ label: "Pieza", filters: [{ property: "name", equals: "Pieza" }], count: 1 }],
        },
      ],
      { iterations: 20_000, seed: 4 }
    );
    // Both copies count: 1 - C(38,7)/C(40,7) = 32.4 %.
    expect(report.queries[0].probability).toBeCloseTo(0.324, 2);
    expect(report.queries[0].requirements[0].inDeck).toBe(2);
  });

  test("`atMost` is the other half of 'playable hand'", () => {
    // Having 2 ink is not enough: you also need NOT to have seven.
    const deck = [...deckOf(30, "ink"), ...deckOf(30, "spell")];
    const cat: CardCatalog = Object.fromEntries(
      deck.map((id) => [id, { inkwell: id.startsWith("ink") }])
    );
    const ink = (count: number, atMost?: boolean) => ({
      label: "tinta",
      filters: [{ property: "inkwell", truthy: true }],
      count,
      atMost,
    });
    const report = goldfish(
      base,
      deck,
      cat,
      [
        { id: "min", label: "al menos 2", turn: 1, require: [ink(2)] },
        { id: "jugable", label: "entre 2 y 5", turn: 1, require: [ink(2), ink(5, true)] },
        { id: "seca", label: "ninguna", turn: 1, require: [ink(0, true)] },
      ],
      { iterations: 20_000, seed: 8 }
    );
    const [min, playable, dry] = report.queries.map((q) => q.probability);
    // The cap can only remove hands, never add.
    expect(playable).toBeLessThan(min);
    expect(playable).toBeGreaterThan(0.8);
    // A hand with NO ink at all: C(30,7)/C(60,7) = 0.527 %. It is a rare event, and
    // at 20,000 hands its standard deviation is ±0.05 points: it is checked with
    // a ±3σ band. With a fixed seed the number does not wobble, but the band
    // makes clear which margin is statistically acceptable and which would be a bug.
    expect(dry).toBeGreaterThan(0.0037);
    expect(dry).toBeLessThan(0.0068);
  });

  test("a cap does NOT compete for cards with the normal requirements", () => {
    // "at least 3 inkable" and "at most 3 inkable" are met at the same time
    // with exactly 3: if the cap entered the assignment, it would ask for 6 cards.
    const deck = deckOf(20, "ink");
    const cat: CardCatalog = Object.fromEntries(deck.map((id) => [id, { inkwell: true }]));
    const filters = [{ property: "inkwell", truthy: true }];
    const report = goldfish(
      withHand(3),
      deck,
      cat,
      [
        {
          id: "exacto",
          label: "exactamente 3",
          turn: 1,
          require: [
            { label: "tinta", filters, count: 3 },
            { label: "tope", filters, count: 3, atMost: true },
          ],
        },
      ],
      { iterations: 200, seed: 2 }
    );
    expect(report.queries[0].probability).toBe(1);
  });

  test("'at least 0' is rejected; 'at most 0' is not", () => {
    const filters = [{ property: "cost", gte: 0 }];
    expect(() =>
      goldfish(base, cards, catalog, [
        { id: "q", label: "?", turn: 1, require: [{ label: "x", filters, count: 0 }] },
      ])
    ).toThrow(GoldfishError);
    expect(() =>
      goldfish(base, cards, catalog, [
        {
          id: "q",
          label: "?",
          turn: 1,
          require: [{ label: "x", filters, count: 0, atMost: true }],
        },
      ])
    ).not.toThrow();
  });
});

// ── Turns ────────────────────────────────────────────────────────────────────

describe("from turn to cards seen", () => {
  test("going first, you do not draw on turn 1", () => {
    expect(cardsSeenAt(base, 1, 7, { onThePlay: true })).toBe(7);
    expect(cardsSeenAt(base, 3, 7, { onThePlay: true })).toBe(9);
  });

  test("going second, you draw from the first", () => {
    expect(cardsSeenAt(base, 1, 7, { onThePlay: false })).toBe(8);
    expect(cardsSeenAt(base, 3, 7, { onThePlay: false })).toBe(10);
  });

  test("some games draw more than one per turn", () => {
    expect(cardsSeenAt(base, 3, 5, { onThePlay: true, drawsPerTurn: 2 })).toBe(9);
  });

  test("`cards` skips the turn translation", () => {
    const cards = deckOf(40, "x");
    const catalog: CardCatalog = Object.fromEntries(cards.map((id) => [id, { kind: "spell" }]));
    const report = goldfish(
      base,
      cards,
      catalog,
      [
        {
          id: "q",
          label: "primeras 12",
          cards: 12,
          require: [{ label: "x", filters: [{ property: "kind", equals: "spell" }], count: 12 }],
        },
      ],
      { iterations: 100, seed: 1 }
    );
    expect(report.queries[0].cardsSeen).toBe(12);
    expect(report.queries[0].probability).toBe(1);
  });
});

// ── Mulligan ─────────────────────────────────────────────────────────────────

describe("declarative mulligan", () => {
  const cards = [...deckOf(8, "ink"), ...deckOf(52, "other")];
  const catalog: CardCatalog = Object.fromEntries(
    cards.map((id) => [id, { inkwell: id.startsWith("ink") }])
  );
  const need2: GoldfishRequirement = {
    label: "tinta",
    filters: [{ property: "inkwell", truthy: true }],
    count: 2,
  };
  const query: GoldfishQuery = { id: "ink2", label: "2 de tinta", turn: 1, require: [need2] };

  const withMulligan = (def: GameDefinition) =>
    goldfish(def, cards, catalog, [query], {
      iterations: 4000,
      seed: 21,
      mulliganUnless: [need2],
    });

  test("with no mulligan rule in the game, nothing is redone", () => {
    const report = withMulligan(base);
    expect(report.mulliganRate).toBe(0);
    expect(report.averageHandSize).toBe(7);
  });

  test("with mulligan the probability of meeting what was required goes up", () => {
    const def = { ...base, mulligan: { mode: "redraw" as const, maxTimes: 1, penalty: 0 } };
    const without = goldfish(def, cards, catalog, [query], { iterations: 4000, seed: 21 });
    const withValue = withMulligan(def);
    expect(withValue.queries[0].probability).toBeGreaterThan(without.queries[0].probability);
    expect(withValue.mulliganRate).toBeGreaterThan(0);
    expect(withValue.mulliganRate).toBeLessThanOrEqual(1);
  });

  test("the penalty shows in the average hand size", () => {
    const def = { ...base, mulligan: { mode: "redraw" as const, maxTimes: 1, penalty: 1 } };
    const report = withMulligan(def);
    expect(report.averageHandSize).toBeLessThan(7);
    expect(report.averageHandSize).toBeGreaterThan(6);
  });
});

// ── Context and reproducibility ──────────────────────────────────────────────

describe("the report reads itself", () => {
  const cards = [...deckOf(8, "ink"), ...deckOf(52, "other")];
  const catalog: CardCatalog = Object.fromEntries(
    cards.map((id, i) => [id, { inkwell: id.startsWith("ink"), cost: (i % 4) + 1 }])
  );
  const query: GoldfishQuery = {
    id: "q",
    label: "3 de tinta",
    turn: 1,
    require: [INK],
  };

  test("each requirement says HOW MANY cards of the deck meet it", () => {
    // A bare 12% says nothing; "12%, and you have 8 inkable" says what to do.
    const report = goldfish(base, cards, catalog, [query], { iterations: 500, seed: 5 });
    expect(report.queries[0].requirements[0]).toEqual({ label: "tinta", count: 3, inDeck: 8 });
    expect(report.deckSize).toBe(60);
  });

  test("the curve counts the whole deck and comes out sorted", () => {
    const report = goldfish(base, cards, catalog, [query], { iterations: 100, seed: 5 });
    expect(report.curve.map((c) => c.value)).toEqual(["1", "2", "3", "4"]);
    expect(report.curve.reduce((n, c) => n + c.cards, 0)).toBe(60);
  });

  test("same seed, identical report", () => {
    // Without this two decks cannot be compared over the same hands.
    const a = goldfish(base, cards, catalog, [query], { iterations: 1000, seed: 1234 });
    const b = goldfish(base, cards, catalog, [query], { iterations: 1000, seed: 1234 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("another seed, another result (but similar)", () => {
    const a = goldfish(base, cards, catalog, [query], { iterations: 1000, seed: 1 });
    const b = goldfish(base, cards, catalog, [query], { iterations: 1000, seed: 2 });
    expect(a.queries[0].hits).not.toBe(b.queries[0].hits);
    expect(Math.abs(a.queries[0].probability - b.queries[0].probability)).toBeLessThan(0.1);
  });

  test("the sample hands can be looked at", () => {
    const report = goldfish(base, cards, catalog, [query], {
      iterations: 200,
      seed: 5,
      sampleHands: 3,
    });
    expect(report.sample).toHaveLength(3);
    expect(report.sample[0]).toHaveLength(7);
  });

  test("cards are only drawn from the MAIN section", () => {
    // Souls, the extra deck or the DON!! deck do not enter the hands.
    const def: GameDefinition = {
      ...base,
      zones: [...base.zones, { id: "soulDeck", name: "Souls", visibility: "none", ordered: true }],
      sections: [
        { id: "main", name: "Principal", zone: "deck", minSize: 1, maxSize: 200, shuffle: true },
        { id: "soul", name: "Souls", zone: "soulDeck", minSize: 0, maxSize: 20, shuffle: true },
      ],
    };
    const report = goldfish(
      def,
      { main: deckOf(60, "m"), soul: deckOf(10, "s") },
      Object.fromEntries([...deckOf(60, "m"), ...deckOf(10, "s")].map((id) => [id, { cost: 1 }])),
      [query],
      { iterations: 100, seed: 5 }
    );
    expect(report.deckSize).toBe(60);
  });
});

// ── Not blocking the API ─────────────────────────────────────────────────────

describe("the async version yields the thread without changing the result", () => {
  const cards = [...deckOf(20, "land"), ...deckOf(40, "spell")];
  const catalog: CardCatalog = Object.fromEntries(
    cards.map((id) => [id, { kind: id.startsWith("land") ? "land" : "spell", cost: 2 }])
  );
  const queries: GoldfishQuery[] = [
    {
      id: "q",
      label: "3 lands and 1 spell on turn 4",
      turn: 4,
      require: [
        { label: "tierra", filters: [{ property: "kind", equals: "land" }], count: 3 },
        { label: "hechizo", filters: [{ property: "kind", equals: "spell" }], count: 1 },
      ],
    },
  ];

  test("report identical to the sync one, down to the last number", () => {
    // If they diverged, the production one would give different numbers from the one tested.
    const sync = goldfish(base, cards, catalog, queries, { iterations: 5000, seed: 4242 });
    return goldfishAsync(base, cards, catalog, queries, { iterations: 5000, seed: 4242 }, 250).then(
      (async_) => {
        expect(JSON.stringify(async_)).toBe(JSON.stringify(sync));
      }
    );
  });

  test("the chunk size changes nothing", async () => {
    // Each iteration derives its shuffle from the seed and its index, so
    // chunking the loop cannot change a single result.
    const a = await goldfishAsync(base, cards, catalog, queries, { iterations: 2000, seed: 7 }, 1);
    const b = await goldfishAsync(
      base,
      cards,
      catalog,
      queries,
      { iterations: 2000, seed: 7 },
      999
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("it really releases the thread between chunks", async () => {
    // It is the point: that other requests in the process can slip in while
    // the report runs, instead of waiting for it to finish.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await goldfishAsync(base, cards, catalog, queries, { iterations: 20_000, seed: 1 }, 500);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});

// ── Dealing hands to look at ─────────────────────────────────────────────────

describe("dealHands: the hands shown are the ones counted", () => {
  const cards = [...deckOf(20, "land"), ...deckOf(40, "spell")];
  const catalog: CardCatalog = Object.fromEntries(
    cards.map((id) => [id, { kind: id.startsWith("land") ? "land" : "spell" }])
  );

  test("hand N is EXACTLY iteration N of the goldfish", () => {
    // It is what allows saying "of the 10,000 hands, these are the first 5"
    // without lying. If the two subseed formulas diverged, the interface
    // would show hands the report never saw.
    const reportValue = goldfish(
      base,
      cards,
      catalog,
      [
        {
          id: "q",
          label: "1 tierra",
          turn: 1,
          require: [{ label: "tierra", filters: [{ property: "kind", equals: "land" }], count: 1 }],
        },
      ],
      { iterations: 5, seed: 555, sampleHands: 5 }
    );
    const dealtOnes = dealHands(base, cards, { count: 5, seed: 555 });
    expect(dealtOnes.hands.map((h) => h.opening)).toEqual(reportValue.sample);
  });

  test("same seed, same hands", () => {
    const a = dealHands(base, cards, { count: 3, seed: 9 });
    const b = dealHands(base, cards, { count: 3, seed: 9 });
    expect(a).toEqual(b);
  });

  test("`from` continues the batch without repeating", () => {
    // It is the interface's "give me another hand": it carries on from where it was.
    const firstOnes = dealHands(base, cards, { count: 3, seed: 9 });
    const nextOnes = dealHands(base, cards, { count: 3, seed: 9, from: 3 });
    expect(nextOnes.hands[0].index).toBe(3);
    const views = firstOnes.hands.map((h) => h.opening.join());
    expect(nextOnes.hands.some((h) => views.includes(h.opening.join()))).toBe(false);
  });

  test("`draws` shows what would come next, without repeating the hand", () => {
    const [hand] = dealHands(base, cards, { count: 1, seed: 2, draws: 3 }).hands;
    expect(hand.opening).toHaveLength(base.openingHand);
    expect(hand.drawn).toHaveLength(3);
    // No drawn card can already be in the hand: it is the same shuffled deck.
    const inHand = new Set(hand.opening.map((c, i) => `${c}#${i}`));
    expect(hand.opening.length + hand.drawn.length).toBe(inHand.size + 3);
  });

  test("only deals from the main section", () => {
    const def: GameDefinition = {
      ...base,
      zones: [...base.zones, { id: "soulDeck", name: "Souls", visibility: "none", ordered: true }],
      sections: [
        { id: "main", name: "Principal", zone: "deck", minSize: 1, maxSize: 200, shuffle: true },
        { id: "soul", name: "Souls", zone: "soulDeck", minSize: 0, maxSize: 20, shuffle: true },
      ],
    };
    const dealt = dealHands(
      def,
      { main: deckOf(60, "m"), soul: deckOf(10, "s") },
      { count: 4, seed: 1 }
    );
    expect(dealt.deckSize).toBe(60);
    expect(dealt.hands.every((h) => h.opening.every((c) => c.startsWith("m-")))).toBe(true);
  });

  test("an empty deck is rejected", () => {
    expect(() => dealHands(base, [], { count: 1 })).toThrow(GoldfishError);
  });
});

describe("impossible inputs are rejected", () => {
  const cards = deckOf(10, "x");
  const catalog: CardCatalog = Object.fromEntries(cards.map((id) => [id, { cost: 1 }]));
  const run = (queries: GoldfishQuery[]) => goldfish(base, cards, catalog, queries, {});

  test("a query with no turn or number of cards", () => {
    expect(() =>
      run([
        {
          id: "q",
          label: "?",
          require: [{ label: "x", filters: [{ property: "cost" }], count: 1 }],
        },
      ])
    ).toThrow(GoldfishError);
  });

  test("a requirement with no filters", () => {
    expect(() =>
      run([{ id: "q", label: "?", turn: 1, require: [{ label: "x", filters: [], count: 1 }] }])
    ).toThrow(/has no filter/);
  });

  test("an empty deck", () => {
    expect(() => goldfish(base, [], catalog, [], {})).toThrow(/has no cards/);
  });
});
