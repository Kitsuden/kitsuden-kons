/**
 * CREW classification — team battles by stocks
 * ============================================================================
 *
 * The Smash format: two teams of N players, a shared pool of lives
 * (stocks) per team, and chained 1v1 duels — whoever loses their last life
 * is out and the next one on their team comes in, who does not inherit the damage, but
 * does inherit the overall score.
 *
 * It is a separate classification because the SCOREBOARD changes nature: it is not
 * sets won, it is stocks remaining from a shared pool. The side's "score" is
 * the sum of living lives, and the set's story is who took down how many before
 * falling. None of that exists in `versus` or `doubles`.
 */

import type { GameProfile } from "../broadcast.profiles";
import { z } from "zod";

/** A crew member, with their state in the battle. */
const crewMember = z.object({
  playerId: z.string().nullable().optional(),
  name: z.string().min(1).max(40),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
  char: z.string().max(40).nullable().optional(),
  /** Lives HE has left on his turn. 0 = eliminated. */
  stocksLeft: z.number().int().min(0).max(9).default(0),
  /** Already fell. Different from "has not played yet": both show 0 on screen. */
  out: z.boolean().default(false),
  /** Playing NOW. At most one per side; the graphic highlights them. */
  active: z.boolean().default(false),
});

/**
 * Side = crew.
 *
 * `roster` accepts 3 to 10: crews of 3 (short format) and of 10 (the
 * classic exhibition) both exist. `score` is the TOTAL of living stocks
 * of the team — the big number on the scoreboard — and it is stored in addition to the breakdown
 * because it is the only thing the compact scoreboard needs.
 */
function crewSide(maxRoster: number) {
  return z.object({
    playerId: z.string().nullable().optional(),
    participantId: z.string().nullable().optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .optional(),
    sponsor: z.string().max(20).default(""),
    /** Crew name: "Tristate", "SoCal". */
    name: z.string().min(1).max(40),
    roster: z.array(crewMember).min(3).max(maxRoster),
    /** Total living stocks of the team. It is the big number on the scoreboard. */
    score: z.number().int().min(0).max(99).default(0),
    losers: z.boolean().default(false),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#00d2a8"),
    /** The versus and the other screens do not use chars in crew. */
    chars: z.array(z.string()).max(0).default([]),
  });
}

export const CREW_PROFILES: GameProfile[] = [
  {
    id: "smash-crew",
    classification: "crew",
    name: "Smash — Crew Battle",
    shape: "team",
    sideSchema: crewSide(10),
    // firstTo does not apply to stocks, but the contract asks for it: it is used as the number
    // of stocks PER PLAYER at the start (3 is the crew standard).
    defaults: { firstTo: 3, rosterSize: 5 },
    labels: {
      pick: "character",
      picks: "characters",
      competitor: "crew",
      bout: "batalla",
    },
    graphics: { konId: "kon-broadcast", src: "./graphics/overlay.html" },
    panel: {
      konId: "kon-broadcast",
      element: "broadcast-scoreboard",
      src: "./admin/scoreboard.js",
    },
  },
];

// ── Crew arithmetic ──────────────────────────────────────────────────────────

export interface CrewMemberState {
  name: string;
  stocksLeft: number;
  out: boolean;
  active: boolean;
}

/**
 * Total living stocks of a side. It is the score.
 *
 * It is computed from the roster and not kept by hand: an operator who subtracts stocks from
 * the player AND the total ends up throwing both off as soon as they slip once.
 */
export function crewScore(roster: CrewMemberState[]): number {
  return roster.reduce((sum, m) => sum + (m.out ? 0 : m.stocksLeft), 0);
}

/**
 * Applies the loss of a stock by the active player.
 *
 * When they lose the last one, they become `out` and stop being active — the next one
 * is NOT activated automatically, because in a real crew battle the order of entry is
 * a tactical decision by the captain, not a fixed queue.
 */
export function loseStock(roster: CrewMemberState[]): CrewMemberState[] {
  return roster.map((m) => {
    if (!m.active || m.out) return m;
    const stocksLeft = Math.max(0, m.stocksLeft - 1);
    const out = stocksLeft === 0;
    return { ...m, stocksLeft, out, active: out ? false : m.active };
  });
}

/**
 * Activates a player (and deactivates the rest of the side).
 *
 * Activating an eliminated player is rejected: it is the most likely panel mistake in the
 * chaos between games, and on screen you would see a dead player playing.
 */
export function activate(
  roster: CrewMemberState[],
  name: string
): { ok: true; roster: CrewMemberState[] } | { ok: false; reason: string } {
  const target = roster.find((m) => m.name === name);
  if (!target) return { ok: false, reason: `"${name}" is not in the crew` };
  if (target.out) return { ok: false, reason: `"${name}" is already eliminated` };

  return {
    ok: true,
    roster: roster.map((m) => ({ ...m, active: m.name === name })),
  };
}

/** Is the battle over? A side with no living stocks loses it. */
export function crewBattleOver(a: CrewMemberState[], b: CrewMemberState[]): "a" | "b" | null {
  const aAlive = crewScore(a) > 0;
  const bAlive = crewScore(b) > 0;
  if (aAlive && !bAlive) return "a";
  if (!aAlive && bAlive) return "b";
  return null;
}
