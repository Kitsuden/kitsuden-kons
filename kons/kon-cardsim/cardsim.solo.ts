/**
 * `@kitsuden/kon-cardsim/solo` — what a two-player game needs to be played ALONE
 * ============================================================================
 *
 * The engine is two-seat and the solo board paints one. Nothing here touches the game's rules:
 * these are the two consequences of the second seat being empty, kept out of the board component
 * so they can be tested on the seven presets at once (`tests/unit/cardsim-solo.test.ts`).
 *
 * Moved from the Cardback site (`src/lib/solitario.ts`) into the kon with the board, 2026-11-20.
 *
 * ── 1. FREE TABLE ──────────────────────────────────────────────────────────
 *
 * A solo game serves two different purposes, and only one wants a legal deck:
 *
 *   1. Testing the deck you will take to a tournament — there the 50 cards and the copy limit are
 *      exactly what you want checked.
 *   2. Seeing how an idea, an archetype or the cards from the meta move — there demanding a full
 *      deck only gets in the way.
 *
 * Case 2 is not hypothetical: meta lists are SAMPLES (the most played cards of an archetype), so
 * none of them passes a 50-card validation. Without a free table, "start" never works with them.
 *
 * ── WHY THE ENGINE IS NOT TOUCHED ──────────────────────────────────────────
 *
 * `createSession` always validates, and it is right to: an engine that accepts illegal decks when
 * asked ends up accepting them when not. Instead of a back door, it gets ANOTHER definition of the
 * same game with the minimums at zero. Zones, secrecy, shuffling and dealing are the real game's;
 * only whether the deck would be tournament-legal stops being checked.
 */

import type { GameDefinition } from "./cardsim.engine.js";

/** A high round cap: there is no cap here, but the type wants a number. */
const NO_CAP = 9999;

/**
 * Solo, YOU start.
 *
 * Five of the seven presets draw lots for who goes first, which is right at a table for two. With
 * an empty seat that draw only decides whether practice starts on your turn or nobody's, and the
 * log even announced "player 2 starts" when there is no player 2.
 */
export const soloSeat = (definition: GameDefinition): GameDefinition => ({
  ...definition,
  firstPlayer: "seat0",
});

/**
 * The same definition with deck construction unchecked.
 *
 * `cardsInDeck` is how many cards go to the deck zone: `validateGameDefinition` requires
 * `openingHand <= deckRules.minSize`, and dealing five from a three-card deck would run out, so
 * the opening hand is cut to what is really there.
 */
export function freeTable(definition: GameDefinition, cardsInDeck: number): GameDefinition {
  const hand = Math.max(0, Math.min(definition.openingHand, cardsInDeck));
  return {
    ...definition,
    sections: (definition.sections ?? []).map((s) => ({
      ...s,
      minSize: 0,
      maxSize: NO_CAP,
      maxCopies: undefined,
    })),
    openingHand: hand,
    deckRules: {
      ...definition.deckRules,
      minSize: hand,
      maxSize: NO_CAP,
      maxCopies: 99,
      copyLimits: undefined,
      groupLimits: [],
      distinctLimits: [],
    },
  };
}
