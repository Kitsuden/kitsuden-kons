/**
 * TEAM classification — team MOBA and FPS profiles
 * ============================================================================
 *
 * Several competitors per side, draft with bans and picks, and score by map
 * within a series.
 *
 * It is a separate KON from `versus` and not just another profile because it changes the
 * **behavior**, not just the data:
 *
 *   - The side stops being a player and becomes a team with a roster.
 *   - There is a draft phase that does not exist in FGC.
 *   - The score is by map within the series, not by individual sets.
 *   - And above all: **the data is not typed by the operator**. In LoL and Valorant most
 *     of it arrives from live telemetry, so the product is the
 *     ingest, not the panel.
 *
 * That last difference is what justifies the separation. An FGC organizer
 * should not have to load a polling subsystem they will never use.
 *
 * NOTE: telemetry ingest is NOT here. This kon defines the shape of the
 * data and the graphics; connecting Riot's Live Client Data would be a
 * companion kon (`kon-broadcast-riot-ingest`), because it has its own lifecycle,
 * its own retries and its own failure surface.
 */

import type { GameProfile } from "../broadcast.profiles";
import { z } from "zod";

/** A team member. */
const teamMember = z.object({
  playerId: z.string().nullable().optional(),
  name: z.string().min(1).max(40),
  /** Role or position: `top`, `jungle`, `duelist`… Game vocabulary. */
  role: z.string().max(20).optional(),
  /** Character/champion/agent picked in the draft. */
  pick: z.string().max(40).nullable().optional(),
});

/**
 * Side = team.
 *
 * `roster` has an EXACT size, not a maximum: a LoL overlay with four
 * players is a data error, not a valid variant, and it is better for validation
 * to fail than for it to go on air with a gap.
 */
function teamSide(rosterSize: number, banCount: number) {
  return z.object({
    teamId: z.string().nullable().optional(),
    /**
     * Bracket participant when the series was built from the bracket. Same
     * as in `versus`: if Zod does not declare it, it drops it on validation and the
     * link that allows reporting the result is lost.
     */
    participantId: z.string().nullable().optional(),
    /** Short label for the scoreboard: `T1`, `G2`. */
    tag: z.string().max(8).default(""),
    name: z.string().min(1).max(40),
    roster: z.array(teamMember).length(rosterSize),
    bans: z.array(z.string().max(40)).max(banCount).default([]),
    /** Maps won in the series. */
    score: z.number().int().min(0).max(9).default(0),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#3b82f6"),
  });
}

export const TEAM_PROFILES: GameProfile[] = [
  {
    id: "lol",
    classification: "team",
    name: "League of Legends",
    shape: "team",
    // 5 players, 5 bans per team in the competitive draft.
    sideSchema: teamSide(5, 5),
    defaults: { firstTo: 3, rosterSize: 5 },
    labels: {
      pick: "champion",
      picks: "champions",
      competitor: "team",
      bout: "series",
    },
    // No graphic of its own yet: Broadcast's overlay is 1v1. A profile without
    // `graphics` is valid — it means "I don't have a screen yet", not "use the
    // duel one", which would paint wrong.
  },
  {
    id: "valorant",
    classification: "team",
    name: "Valorant",
    shape: "team",
    // 5 players; there are no agent bans, but there is a map veto (another model).
    sideSchema: teamSide(5, 0),
    defaults: { firstTo: 2, rosterSize: 5 },
    labels: {
      pick: "agent",
      picks: "agents",
      competitor: "team",
      bout: "series",
    },
  },
];
