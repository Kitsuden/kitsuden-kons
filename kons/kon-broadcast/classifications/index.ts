/**
 * Broadcast classifications
 * ============================================================================
 *
 * A **classification** describes the shape a match takes, and that
 * changes the scoreboard's behavior, not just the data:
 *
 *   · `versus`  — one competitor per side. Manual entry, score by sets.
 *   · `doubles` — the side is a PAIR: linking to the player registry
 *                 means linking two, and the graphic paints two names without
 *                 either looking like the main one.
 *   · `team`    — the side is a TEAM with a roster, there is a draft phase with bans and
 *                 picks, and the score goes by map within a series.
 *   · `crew`    — the score changes nature: it is not sets won, it is
 *                 stocks from a shared pool per team.
 *
 * ── WHY THEY ARE HERE AND NOT IN FOUR KONS ─────────────────────────────────
 *
 * They used to be in four kons —`kon-broadcast-crew`, `-doubles`, `-team`,
 * `-versus`— and were merged. The conceptual distinction between classifications is
 * kept intact; what was thrown away was the PACKAGING, which added nothing:
 *
 *   · All four had **0 tables and 0 routes**. Their `createKon…` returned an
 *     empty Hono, and their own comments said so: "this kon provides no
 *     routes, it provides profiles".
 *   · Of their 709 lines, about 550 were the same skeleton copied four times.
 *   · And the decisive point: all four wrote to the SAME global registry in
 *     `broadcast.profiles.ts`. Installing them separately isolated nothing at
 *     runtime — the result was identical to having them together.
 *
 * In exchange they cost four admin menu entries that, when opened,
 * showed a screen with no data: they had no tables to show.
 *
 * ── TURNING ON AND OFF ─────────────────────────────────────────────────────
 *
 * Before, you chose by installing or not installing each kon. Now it is a kon setting, and by
 * default **all are active**: it is the behavior of anyone who had
 * installed them, and a new installation sees all the games available
 * instead of an unexplained empty list.
 */

import { registerGameProfile, type GameProfile } from "../broadcast.profiles";

import { CREW_PROFILES } from "./crew";
import { DOUBLES_PROFILES } from "./doubles";
import { TEAM_PROFILES } from "./team";
import { VERSUS_PROFILES } from "./versus";

export { CREW_PROFILES } from "./crew";
export { DOUBLES_PROFILES } from "./doubles";
export { TEAM_PROFILES } from "./team";
export { VERSUS_PROFILES } from "./versus";

/** Identifier of each classification. It is what the configuration stores. */
export type ClassificationId = "versus" | "doubles" | "team" | "crew";

export interface Classification {
  id: ClassificationId;
  /** Name for the options screen. */
  name: string;
  /** What sets it apart, in one line. */
  description: string;
  profiles: GameProfile[];
}

/**
 * The catalog, in the order it is shown.
 *
 * `versus` goes first as the most common form (any 1v1 duel) and the one that
 * brings the most games.
 */
export const CLASSIFICATIONS: Classification[] = [
  {
    id: "versus",
    name: "Versus",
    description: "One competitor per side: fighting games and 1v1 duels.",
    profiles: VERSUS_PROFILES,
  },
  {
    id: "doubles",
    name: "Doubles",
    description: "Two players per side, with the pair as the unit.",
    profiles: DOUBLES_PROFILES,
  },
  {
    id: "team",
    name: "Teams",
    description: "Teams with roster and draft phase: MOBA and FPS.",
    profiles: TEAM_PROFILES,
  },
  {
    id: "crew",
    name: "Crew battle",
    description: "Stocks from a shared pool per team, not sets won.",
    profiles: CREW_PROFILES,
  },
];

/** All active until someone says otherwise. */
export const DEFAULT_CLASSIFICATIONS: ClassificationId[] = CLASSIFICATIONS.map((c) => c.id);

/**
 * Registers the profiles of the active classifications.
 *
 * It can be called more than once: the registry is a process singleton and
 * `registerGameProfile` overwrites by id, so reactivating a classification
 * does not leave half-registered profiles. That matters because tests empty the registry
 * and need to be able to repopulate it without restarting.
 *
 * With no argument it registers all of them — the default behavior.
 */
export function registerClassifications(active?: readonly ClassificationId[]): void {
  const conjunto = new Set(active ?? DEFAULT_CLASSIFICATIONS);

  for (const classification of CLASSIFICATIONS) {
    if (!conjunto.has(classification.id)) continue;
    for (const profile of classification.profiles) registerGameProfile(profile);
  }
}
