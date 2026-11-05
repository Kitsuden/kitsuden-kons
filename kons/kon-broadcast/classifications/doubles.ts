/**
 * DOUBLES classification — two players per side
 * ============================================================================
 *
 * Smash 2v2 and pair tournaments of other fighting games.
 *
 * It is a classification separate from `versus` —and not just another profile— because it changes
 * the BEHAVIOR: the side stops being a person and becomes a pair
 * with its own name. Linking a side to the player registry means
 * linking TWO, the country may differ within the pair, and the graphic
 * has to paint two names without either looking like the "main" one.
 *
 * What does NOT change —set lifecycle, score, screens, bracket— lives
 * in the core and is not touched here.
 */

import type { GameProfile } from "../broadcast.profiles";
import { z } from "zod";

/** A member of the pair. */
const partner = z.object({
  playerId: z.string().nullable().optional(),
  name: z.string().min(1).max(40),
  /** ISO alpha-2. In doubles the country is PER PLAYER: mixed pairs exist. */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
  /** Character of that specific member. */
  char: z.string().max(40).nullable().optional(),
});

/**
 * Side = pair.
 *
 * `players` has EXACTLY two entries: a "double" of one or of three is not
 * a valid variant, it is a data error, and it is better for validation to fail
 * than for it to go on air with a gap.
 *
 * `name` still exists as the PAIR's name ("Team Guapos"): the
 * compact scoreboard uses it when both names do not fit.
 */
function doublesSide(picks: number) {
  return z.object({
    playerId: z.string().nullable().optional(),
    participantId: z.string().nullable().optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .optional(),
    sponsor: z.string().max(20).default(""),
    name: z.string().min(1).max(40),
    players: z.array(partner).length(2),
    chars: z.array(z.string().min(1).max(40)).max(picks).default([]),
    score: z.number().int().min(0).max(99).default(0),
    losers: z.boolean().default(false),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#00d2a8"),
  });
}

export const DOUBLES_PROFILES: GameProfile[] = [
  {
    /**
     * Generic doubles: any pair-based game. The equivalent of the core's
     * `1v1` profile — it exists so a grimoire does not have to pin a
     * specific game as the default.
     */
    id: "doubles",
    classification: "doubles",
    name: "Generic doubles",
    shape: "team",
    sideSchema: doublesSide(2),
    defaults: { firstTo: 3, rosterSize: 2 },
    labels: {
      pick: "character",
      picks: "characters",
      competitor: "pair",
      bout: "set",
    },
    graphics: { konId: "kon-broadcast", src: "./graphics/overlay.html" },
    panel: {
      konId: "kon-broadcast",
      element: "broadcast-scoreboard",
      src: "./admin/scoreboard.js",
    },
  },
  {
    id: "smash-doubles",
    classification: "doubles",
    name: "Smash Ultimate — Doubles",
    shape: "team",
    sideSchema: doublesSide(2),
    // In Smash doubles the tournament standard is best of 3 (FT2).
    defaults: { firstTo: 2, rosterSize: 2 },
    labels: {
      pick: "character",
      picks: "characters",
      competitor: "pair",
      bout: "set",
    },
    graphics: { konId: "kon-broadcast", src: "./graphics/overlay.html" },
    panel: {
      konId: "kon-broadcast",
      element: "broadcast-scoreboard",
      src: "./admin/scoreboard.js",
    },
  },
];
