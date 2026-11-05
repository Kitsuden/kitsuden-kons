/**
 * HandLab — from a dataset to a minimal game definition
 * ============================================================================
 *
 * The whole idea of the kon fits in twenty lines.
 *
 * The cardsim engine knows how to deal hands and compute consistency, but it
 * asks for a complete `GameDefinition`: zones, phases, defeat conditions. To
 * play a game that is necessary; to ask "what hands does this deck make?" it is
 * half an hour of work before seeing the first card.
 *
 * So the smallest definition the engine accepts is synthesized: two zones
 * (deck and hand), no phase that matters, no resource. The user only declares
 * what really changes a hand — how many cards are drawn, how many fit in the
 * deck and how many copies are allowed.
 *
 * The consequence: **not a single line of logic is duplicated**. Dealing,
 * shuffling, validating and counting remain cardsim's functions, already
 * tested. This module only translates.
 */

import type { GameDefinition } from "./cardsim.types.js";

/** What the generator needs to know about a dataset. Nothing more. */
export interface DatasetRules {
  slug: string;
  name: string;
  handSize: number;
  deckMin: number;
  deckMax: number;
  maxCopies: number;
  copyLimits?: Record<string, number>;
}

export class HandlabError extends Error {}

/**
 * Checks the rules BEFORE saving them.
 *
 * The engine rejects a definition with an `openingHand` larger than the
 * minimum deck, and rightly so: it would be a dataset that cannot deal even one
 * hand. Catching it on creation avoids the error showing up the first time
 * someone asks for hands, when they no longer remember what they set.
 */
export function validateRules(rules: DatasetRules): string[] {
  const errors: string[] = [];
  if (rules.handSize < 1) errors.push("The hand must be at least 1 card");
  if (rules.deckMin < 1) errors.push("The minimum deck must be at least 1 card");
  if (rules.deckMin > rules.deckMax) errors.push("The minimum deck exceeds the maximum");
  if (rules.handSize > rules.deckMin) {
    errors.push(`The hand (${rules.handSize}) does not fit in the minimum deck (${rules.deckMin})`);
  }
  if (rules.maxCopies < 1) errors.push("At least one copy per card must be allowed");
  return errors;
}

/** The smallest definition with which the cardsim engine can deal. */
export function definitionFor(rules: DatasetRules): GameDefinition {
  return {
    id: rules.slug,
    name: rules.name,
    // A single seat: there is no opponent to play against.
    players: { min: 1, max: 1 },
    zones: [
      { id: "deck", name: "Deck", visibility: "none", ordered: true },
      { id: "hand", name: "Hand", visibility: "owner" },
    ],
    resources: [],
    deckRules: {
      minSize: rules.deckMin,
      maxSize: rules.deckMax,
      maxCopies: rules.maxCopies,
      copyLimits: rules.copyLimits,
    },
    deckZone: "deck",
    handZone: "hand",
    openingHand: rules.handSize,
    phases: ["draw"],
  };
}
