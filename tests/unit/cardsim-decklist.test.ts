/**
 * Deck lists and ranking
 * ============================================================================
 *
 * The importer has one rule that governs everything: **never silently discard
 * anything**. A line that is not understood comes out with its number; if it were swallowed,
 * the user would end up with a 47-card deck without knowing which are missing or
 * why. Almost all the tests here watch for that.
 */

import { describe, expect, test } from "vitest";

import {
  formatDeckList,
  formatYdk,
  parseDeckList,
  parseYdk,
} from "../../kons/kon-cardsim/cardsim.decklist";
import { applyElo, expectedScore, kFactor } from "../../kons/kon-cardsim/cardsim.rating";
import type { DeckSection } from "../../kons/kon-cardsim/cardsim.types";

const SECTIONS: DeckSection[] = [
  { id: "main", name: "Main deck", zone: "deck", minSize: 50, maxSize: 50 },
  { id: "soul", name: "Souls Deck", zone: "soulDeck", minSize: 10, maxSize: 10 },
];

describe("import lists from text", () => {
  test("expands quantities into copies", () => {
    const { cards, errors } = parseDeckList("4 BP01-001\n2x BP01-002\nBP01-003", SECTIONS);
    expect(errors).toEqual([]);
    expect(cards.main).toEqual([
      "BP01-001",
      "BP01-001",
      "BP01-001",
      "BP01-001",
      "BP01-002",
      "BP01-002",
      "BP01-003",
    ]);
  });

  test("headers switch section, by id or by name", () => {
    const { cards } = parseDeckList("# main\n2 BP01-001\n# Souls Deck\n3 BP01-050", SECTIONS);
    expect(cards.main).toHaveLength(2);
    expect(cards.soul).toHaveLength(3);
  });

  test("without headers, everything goes to the main section", () => {
    // It is the normal case: someone pastes 50 lines and that's it.
    const { cards } = parseDeckList("2 A\n2 B", SECTIONS);
    expect(cards.main).toHaveLength(4);
    expect(cards.soul).toEqual([]);
  });

  test("an impossible quantity is REPORTED with its line, not discarded", () => {
    const { cards, errors } = parseDeckList("999 A\n2 B", SECTIONS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Line 1");
    // And what was understood is still there: the whole list is not thrown away.
    expect(cards.main).toEqual(["B", "B"]);
  });

  test("comments and empty lines do no harm", () => {
    const { cards, errors } = parseDeckList("// mi mazo\n\n2 A\n\n", SECTIONS);
    expect(errors).toEqual([]);
    expect(cards.main).toEqual(["A", "A"]);
  });

  test("exporting and importing gives the same deck", () => {
    const original = { main: ["A", "A", "B"], soul: ["S"] };
    const { cards } = parseDeckList(formatDeckList(original, SECTIONS), SECTIONS);
    expect(cards.main.sort()).toEqual(original.main.sort());
    expect(cards.soul).toEqual(original.soul);
  });
});

describe("import YDK", () => {
  test("distributes main, extra and side", () => {
    const { cards, errors } = parseYdk(
      "#created by tester\n#main\n1001\n1001\n#extra\n2002\n!side\n3003\n"
    );
    expect(errors).toEqual([]);
    expect(cards.main).toEqual(["1001", "1001"]);
    expect(cards.extra).toEqual(["2002"]);
    expect(cards.side).toEqual(["3003"]);
  });

  test("a non-numeric id is reported", () => {
    const { errors } = parseYdk("#main\nDark Magician\n");
    expect(errors[0]).toContain("is not a YDK id");
  });

  test("a card before any section is reported", () => {
    // If it were put into main "just in case", the imported deck would be a different one.
    const { errors, cards } = parseYdk("1001\n#main\n1002\n");
    expect(errors[0]).toContain("before any section");
    expect(cards.main).toEqual(["1002"]);
  });

  test("exporting and importing gives the same deck", () => {
    const original = { main: ["1", "1", "2"], extra: ["3"], side: [] };
    expect(parseYdk(formatYdk(original)).cards).toEqual(original);
  });
});

describe("Elo", () => {
  test("two equal players have the same expectation", () => {
    expect(expectedScore(1200, 1200)).toBeCloseTo(0.5);
  });

  test("beating the favorite gives more points than beating the underdog", () => {
    const surprise = applyElo({ rating: 1000, games: 50 }, { rating: 1600, games: 50 }, 1);
    const expected = applyElo({ rating: 1600, games: 50 }, { rating: 1000, games: 50 }, 1);
    expect(surprise.a - 1000).toBeGreaterThan(expected.a - 1600);
  });

  test("what one gains the other loses: the system does not inflate", () => {
    // With the same K, Elo is zero-sum. Otherwise the average score would rise
    // game by game and the ranking would stop meaning anything.
    const a = { rating: 1350, games: 50 };
    const b = { rating: 1210, games: 50 };
    const next = applyElo(a, b, 1);
    expect(next.a - a.rating).toBe(-(next.b - b.rating));
  });

  test("a draw moves the weaker one up", () => {
    const next = applyElo({ rating: 1000, games: 50 }, { rating: 1400, games: 50 }, 0.5);
    expect(next.a).toBeGreaterThan(1000);
    expect(next.b).toBeLessThan(1400);
  });

  test("a new account moves faster than a veteran one", () => {
    // With a fixed K one of two things happens: either newcomers take a hundred games to
    // settle, or veterans make jumps from one bad night.
    expect(kFactor(0)).toBeGreaterThan(kFactor(15));
    expect(kFactor(15)).toBeGreaterThan(kFactor(100));
  });
});
