/**
 * cardsim: the randomness of a game cannot be deduced (earlier audit)
 * ============================================================================
 *
 * Before: 31-bit seed, subseeds `seed + cursor·7919` and `instanceId`
 * in deck order. A player deduced the permutation of their hand, tried the
 * 2³¹ seeds and knew their deck, the rival's and all future randomness.
 *
 * Now the server passes a FUNCTION seed (HMAC over a 256-bit
 * secret) and, with it, the `instanceId`s are assigned at random. Games with a
 * numeric seed (old ones, solitaire) do not change.
 */
import { describe, expect, it } from "vitest";

import { replay, type GameDefinition } from "../../kons/kon-cardsim/cardsim.engine";
import { seedOf, usedSubseeds } from "../../kons/kon-cardsim/cardsim.seed";

const game = {
  id: "prueba",
  name: "Evidence",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
  ],
  resources: [],
  deckZone: "deck",
  handZone: "hand",
  openingHand: 7,
  phases: ["Main"],
  firstPlayer: "random",
  deckRules: { minSize: 40, maxSize: 40, maxCopies: 40 },
} as unknown as GameDefinition;

const deck = Array.from({ length: 40 }, (_, i) => `c${String(i).padStart(2, "0")}`);
const hand = (s: ReturnType<typeof replay>, p: number) => s.players[p]!.zones.hand!;

describe("secret seed", () => {
  it("with a secret, the hand's instanceIds do not reveal the position in the deck", () => {
    const session = { seed: 1, secretRng: "a".repeat(64) };
    const s = replay(game, [deck, deck], seedOf(session), []);
    // In deck order, id = position + 1 → c00 would have id 1. With random ids,
    // each card's id does not match its index in the deck list.
    const matchUp = hand(s, 0).filter((c) => c.instanceId === deck.indexOf(c.cardId) + 1).length;
    expect(matchUp).toBeLessThan(3);
  });

  it("same game, same state (the replay is still exact)", () => {
    const session = { seed: 1, secretRng: "b".repeat(64) };
    const a = replay(game, [deck, deck], seedOf(session), []);
    const b = replay(game, [deck, deck], seedOf(session), []);
    expect(hand(a, 1)).toEqual(hand(b, 1));
  });

  it("the same numeric seed with another secret gives another deal", () => {
    const a = replay(game, [deck, deck], seedOf({ seed: 7, secretRng: "c".repeat(64) }), []);
    const b = replay(game, [deck, deck], seedOf({ seed: 7, secretRng: "d".repeat(64) }), []);
    expect(hand(a, 1).map((c) => c.cardId)).not.toEqual(hand(b, 1).map((c) => c.cardId));
  });

  it("without a secret (old game), the numeric seed rules as before", () => {
    const a = replay(game, [deck, deck], seedOf({ seed: 42, secretRng: null }), []);
    const b = replay(game, [deck, deck], 42, []);
    expect(hand(a, 0)).toEqual(hand(b, 0));
  });

  it("with the subseeds used, a client reproduces the game without the secret", () => {
    const seed = seedOf({ seed: 1, secretRng: "e".repeat(64) });
    const s = replay(game, [deck, deck], seed, []);
    const subs = usedSubseeds(seed, s.rngCursor)!;
    const inClient = replay(game, [deck, deck], (cursor) => subs[cursor]!, []);
    expect(hand(inClient, 1)).toEqual(hand(s, 1));
  });
});

import { goldfish, GoldfishError } from "../../kons/kon-cardsim/cardsim.goldfish";

describe("goldfish with a work budget", () => {
  const filter = { property: "id", op: "eq", value: "c00" };
  it("a normal query is simulated in full", () => {
    const r = goldfish(game, deck, {}, [{ id: "q", cards: 7, require: [{ label: "x", count: 1, filters: [filter] }] }] as never, {
      iterations: 1000,
    });
    expect(r.iterations).toBe(1000);
  });

  it("a giant query is trimmed or rejected, never simulated in full", () => {
    const huge = Array.from({ length: 20 }, (_, i) => ({
      id: `q${i}`,
      cards: 40,
      require: Array.from({ length: 8 }, (_, j) => ({ label: `r${j}`, count: 40, filters: Array(8).fill(filter) })),
    }));
    let iterations = Infinity;
    try {
      iterations = goldfish(game, deck, {}, huge as never, { iterations: 50_000 }).iterations;
    } catch (err) {
      expect(err).toBeInstanceOf(GoldfishError);
      iterations = 0;
    }
    expect(iterations).toBeLessThan(50_000);
  });
});
