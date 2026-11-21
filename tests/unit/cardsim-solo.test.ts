/**
 * The solo board has to START in the seven physical-game presets
 * ============================================================================
 *
 * Moved from the Cardback site with the board (cms `tests/unit/solitario.test.ts`), 2026-11-20.
 *
 * The screen gets tested by hand in one or two games and assumed fine in all seven, which is
 * exactly how this kind of bug slips through: a definition whose section does not fit breaks
 * neither the build nor the types — `createSession` throws in the browser, only in that game.
 *
 * Three things must hold in ALL of them:
 *
 *   1. The relaxed definition is still VALID for the engine (the classic mistake: leaving
 *      `openingHand` at 5 with the deck minimum at 0).
 *   2. A meta sample —short, with extra copies, as they are— starts a game on the free table.
 *   3. That same sample does NOT pass with rules. If it did, the free table would be switching
 *      nothing off and rules mode would be decorative.
 */

import { describe, expect, it } from "vitest";

import {
  createSession,
  mainSectionOf,
  validateDeck,
  validateGameDefinition,
  type CardCatalog,
} from "../../kons/kon-cardsim/cardsim.engine";
import {
  CYBERPUNK_TCG,
  LORCANA,
  NARUTO_CARD_GAME,
  ONEPIECE_CARD_GAME,
  PALWORLD_TCG,
  RIFTBOUND_TCG,
  YUGIOH_ADVANCED,
} from "../../kons/kon-cardsim/cardsim.presets";
import { parseDeckList } from "../../kons/kon-cardsim/cardsim.decklist";
import { freeTable, soloSeat } from "../../kons/kon-cardsim/cardsim.solo";

const GAMES = [
  ["ONE PIECE", ONEPIECE_CARD_GAME],
  ["Yu-Gi-Oh!", YUGIOH_ADVANCED],
  ["Naruto", NARUTO_CARD_GAME],
  ["Cyberpunk 2077", CYBERPUNK_TCG],
  ["Palworld", PALWORLD_TCG],
  ["Riftbound", RIFTBOUND_TCG],
  ["Lorcana", LORCANA],
] as const;

/** A meta sample as the data has it: few distinct cards, average copies. Legal in none. */
const SAMPLE = ["4 Card A", "4 Card B", "3 Card C", "3 Card D", "2 Card E", "2 Card F"].join("\n");

const catalogOf = (cards: string[]): CardCatalog =>
  Object.fromEntries(cards.map((id) => [id, { name: id }]));

describe("free table", () => {
  describe.each(GAMES)("%s", (_name, definition) => {
    // `parseDeckList` sends headerless lines to `sections[0]`, which in ONE PIECE is the Leader.
    // The board puts the main section first; so does this test, or it would measure something else.
    const main = mainSectionOf(definition);
    const sections = [main, ...(definition.sections ?? []).filter((s) => s.id !== main.id)];
    const { cards, errors } = parseDeckList(SAMPLE, sections);
    const inDeck = cards[main.id]?.length ?? 0;
    const catalog = catalogOf(Object.values(cards).flat());

    it("the whole list parses", () => {
      expect(errors).toEqual([]);
      expect(inDeck).toBe(18);
    });

    it("the relaxed definition is still valid for the engine", () => {
      expect(validateGameDefinition(freeTable(definition, inDeck))).toEqual([]);
    });

    it("a meta sample starts a game", () => {
      const free = freeTable(definition, inDeck);
      expect(validateDeck(free, cards, catalog)).toEqual([]);
      const game = createSession(free, [cards, { ...cards }], 1234, catalog);
      // The opening hand is really dealt, cut to what there is.
      expect(game.players[0].zones[definition.handZone]).toHaveLength(free.openingHand);
      expect(free.openingHand).toBeLessThanOrEqual(definition.openingHand);
    });

    it("that same sample does NOT pass with the game's rules", () => {
      expect(validateDeck(definition, cards, catalog).length).toBeGreaterThan(0);
    });
  });

  it("never deals more cards than the deck has", () => {
    const short = freeTable(ONEPIECE_CARD_GAME, 3);
    expect(short.openingHand).toBe(3);
    expect(short.deckRules.minSize).toBeLessThanOrEqual(short.openingHand);
  });

  it("with an empty deck it deals nothing and the definition holds", () => {
    const empty = freeTable(ONEPIECE_CARD_GAME, 0);
    expect(empty.openingHand).toBe(0);
    expect(validateGameDefinition(empty)).toEqual([]);
  });
});

describe("solo, seat 0 starts", () => {
  it.each(GAMES)("%s starts from seat 0", (_name, definition) => {
    expect(soloSeat(definition).firstPlayer).toBe("seat0");
  });

  it("and nothing else of the definition changes", () => {
    const { firstPlayer: _f, ...rest } = soloSeat(ONEPIECE_CARD_GAME);
    const { firstPlayer: _g, ...original } = ONEPIECE_CARD_GAME;
    expect(rest).toEqual(original);
  });

  it("the ghost seat draws too, and its log line is not the player's", () => {
    // The board's log filters by `player`, so the second seat's lines must carry its number.
    const cards = {
      leader: ["l"],
      main: Array.from({ length: 50 }, (_, i) => `c-${i % 13}`),
      don: Array.from({ length: 10 }, () => "DON!!"),
    };
    const game = createSession(soloSeat(ONEPIECE_CARD_GAME), [cards, { ...cards }], 77);
    const draws = game.log.filter((l) => l.type === "draw");
    expect(draws.map((l) => l.player).sort()).toEqual([0, 1]);
    expect(draws.filter((l) => l.player === 0)).toHaveLength(1);
  });
});
