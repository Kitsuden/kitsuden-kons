/**
 * VERSUS classification — 1v1 game profiles
 * ============================================================================
 *
 * One competitor per side, manual entry, character selection. It is the shape
 * of fighting games and, in general, of any duel.
 *
 * What all the profiles here share —and why they are the same
 * classification and not different kons— is the BEHAVIOR: the operator types,
 * there is no telemetry, there is a score by sets and a losers indicator.
 *
 * What changes between them is only the DATA: how many characters are picked, what
 * they are called and what defaults the format has.
 */

import type { GameProfile } from "../broadcast.profiles";
import { z } from "zod";

/** Fields common to every side of a duel. */
const versusSideBase = {
  playerId: z.string().nullable().optional(),
  /** ISO alpha-2. Zod drops what is not declared: without this line, validating a
   * side would ERASE the country stored when linking. */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
  /**
   * Bracket participant when the set was built from the bracket.
   *
   * It goes in the profile schema and not only in the TypeScript type because Zod
   * DROPS what it does not declare: without this line, validating a side would erase the
   * link to the bracket and the result could no longer be reported.
   */
  participantId: z.string().nullable().optional(),
  sponsor: z.string().max(20).default(""),
  name: z.string().min(1).max(40),
  score: z.number().int().min(0).max(99).default(0),
  /** Comes from the losers side of the bracket. Bracket information, not decoration. */
  losers: z.boolean().default(false),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#00d2a8"),
};

/**
 * Builds the schema of a side with N characters.
 *
 * The limit is exact, not a generous maximum: in 2XKO a duo is TWO, and
 * allowing three would let through a payload the graphic does not know how to paint.
 */
function duelSide(picks: number) {
  return z.object({
    ...versusSideBase,
    chars: z.array(z.string().min(1).max(40)).max(picks).default([]),
  });
}

const LABELS_FIGHTING = {
  pick: "character",
  picks: "characters",
  competitor: "player",
  bout: "set",
} as const;

/**
 * Profiles of the classification.
 *
 * Adding a new fighting game means adding an entry here — not a kon, not
 * a table, not a migration.
 */
export const VERSUS_PROFILES: GameProfile[] = [
  {
    id: "2xko",
    classification: "versus",
    name: "2XKO",
    shape: "duel",
    // Tag fighter: TWO champions are picked per player.
    sideSchema: duelSide(2),
    defaults: { firstTo: 3, rosterSize: 1 },
    labels: { ...LABELS_FIGHTING, pick: "champion", picks: "duo" },
    graphics: { konId: "kon-broadcast", src: "./graphics/overlay.html" },
    panel: {
      konId: "kon-broadcast",
      element: "broadcast-scoreboard",
      src: "./admin/scoreboard.js",
    },
  },
  {
    id: "sf6",
    classification: "versus",
    name: "Street Fighter 6",
    shape: "duel",
    sideSchema: duelSide(1),
    defaults: { firstTo: 2, rosterSize: 1 },
    labels: LABELS_FIGHTING,
    graphics: { konId: "kon-broadcast", src: "./graphics/overlay.html" },
    panel: {
      konId: "kon-broadcast",
      element: "broadcast-scoreboard",
      src: "./admin/scoreboard.js",
    },
  },
  {
    id: "tekken8",
    classification: "versus",
    name: "Tekken 8",
    shape: "duel",
    sideSchema: duelSide(1),
    // Tekken is played as 3 rounds per game and FT2 in pools.
    defaults: { firstTo: 2, rosterSize: 1 },
    labels: LABELS_FIGHTING,
    graphics: { konId: "kon-broadcast", src: "./graphics/overlay.html" },
    panel: {
      konId: "kon-broadcast",
      element: "broadcast-scoreboard",
      src: "./admin/scoreboard.js",
    },
  },
  {
    id: "ggst",
    classification: "versus",
    name: "Guilty Gear Strive",
    shape: "duel",
    sideSchema: duelSide(1),
    defaults: { firstTo: 2, rosterSize: 1 },
    labels: LABELS_FIGHTING,
    graphics: { konId: "kon-broadcast", src: "./graphics/overlay.html" },
    panel: {
      konId: "kon-broadcast",
      element: "broadcast-scoreboard",
      src: "./admin/scoreboard.js",
    },
  },
];
