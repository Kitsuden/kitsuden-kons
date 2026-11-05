/**
 * Broadcast sections — which parts of the kon are turned on
 * ============================================================================
 *
 * ── THE PROBLEM IT SOLVES ──────────────────────────────────────────────────
 *
 * Broadcast covers everything from a two-player scoreboard to a MOBA
 * production with live telemetry. That used to be TWO kons —`kon-broadcast` and
 * `kon-broadcast-moba`— and it was expensive: the container, the bridge to the bracket, the
 * overlay serving and the panel were written twice, and the two `report`
 * handlers turned out to be the same one under different names.
 *
 * The right axis is not "one kon per game" —`broadcast.profiles` already said that
 * after merging four— but **one kon with parts that turn on**.
 *
 * ── HOW THEY TURN ON ───────────────────────────────────────────────────────
 *
 * Through the active grimoire's `konConfig`, which already existed and was already read with
 * `konSetting`. No new mechanism is needed:
 *
 *     "konConfig": {
 *       "kon-broadcast": {
 *         "gameProfile": "lol",
 *         "enableGames": true,
 *         "enableDraft": true,
 *         "enableLive": true
 *       }
 *     }
 *
 * ── WHY THESE DEFAULTS ─────────────────────────────────────────────────────
 *
 * `standings` and `catalog` are on because they already worked before the
 * unification: turning them off would break existing installations without warning.
 *
 * `games`, `draft` and `live` are OFF because they are new routes. A fighting
 * installation does not need them, and `live` also opens a polling loop
 * against an external service — a section that generates network traffic
 * should not be turned on just because.
 *
 * ── DEPENDENCIES ARE RESOLVED, NOT REQUIRED ────────────────────────────────
 *
 * `draft` and `live` make no sense without `games`: both write to the
 * game's row. Instead of rejecting the configuration —which would leave the kon unable to
 * start over a misplaced setting, in production, on a Saturday— `games`
 * is turned on by itself and a note is left. That is the difference between a startup that
 * explains what it did and one that does not start.
 */

import { konSetting, type KonContext } from "@kitsuden/shared";
import type { MiddlewareHandler } from "hono";

export const KON_ID = "kon-broadcast";

/** The parts that can be turned on and off. */
export interface BroadcastSections {
  /** Games within a match (`broadcast_games`). */
  games: boolean;
  /** Character selection with turns, bans and Fearless. Implies `games`. */
  draft: boolean;
  /** Live telemetry: ingest adapters and sessions. Implies `games`. */
  live: boolean;
  /** Classifications and their graphics (standings, top 8). */
  standings: boolean;
  /** Catalog of selectable characters. */
  catalog: boolean;
}

const DEFAULTS: BroadcastSections = {
  games: false,
  draft: false,
  live: false,
  standings: true,
  catalog: true,
};

/** Name of the `konConfig` setting for each section. */
const KEYS: Record<keyof BroadcastSections, string> = {
  games: "enableGames",
  draft: "enableDraft",
  live: "enableLive",
  standings: "enableStandings",
  catalog: "enableCatalog",
};

/**
 * Resolves which sections are turned on.
 *
 * `notify` receives what was decided on the user's behalf —today, the dependencies
 * that turned on by themselves—. It is passed as a function instead of writing to the
 * console here so tests can check WHAT was reported without capturing
 * standard output.
 */
export function resolveSections(
  ctx: Pick<KonContext, "konConfig">,
  notify?: (message: string) => void
): BroadcastSections {
  const read = (k: keyof BroadcastSections): boolean =>
    konSetting<boolean>(ctx, KON_ID, KEYS[k], "boolean") ?? DEFAULTS[k];

  const sectionsValue: BroadcastSections = {
    games: read("games"),
    draft: read("draft"),
    live: read("live"),
    standings: read("standings"),
    catalog: read("catalog"),
  };

  // Those that need the game row to exist.
  const dependOnGames = (["draft", "live"] as const).filter((k) => sectionsValue[k]);
  if (dependOnGames.length > 0 && !sectionsValue.games) {
    sectionsValue.games = true;
    notify?.(
      `[${KON_ID}] «${dependOnGames.join("» y «")}» need games per ` +
        `match: «games» has also been turned on.`
    );
  }

  return sectionsValue;
}

/**
 * What the section requires of a game profile, so it can be explained.
 *
 * A teams profile with draft mounted on an installation that has the
 * section turned off currently gives a 404 —the route is not mounted— and a 404 does not say
 * "turn this on". This table is what turns that silence into a sentence.
 */
export const EXPLANATION: Record<keyof BroadcastSections, string> = {
  games: "Store each game separately (drafts, results, telemetry).",
  draft: "Turn-based character selection, with bans and Fearless.",
  live: "Live telemetry ingest from the game.",
  standings: "Accumulated standings and their graphics.",
  catalog: "Catalog of selectable characters.",
};

/** Name of the setting that turns on each section. */
export const SECTION_SETTING = KEYS;

/**
 * Section guard for a route.
 *
 * The route is GUARDED instead of not being mounted, on purpose: an absent route gives a
 * 404, and a 404 does not say "turn this on". With the 409 the panel can show what
 * is missing and where it is enabled — the difference between a configurable installation and
 * one that looks broken.
 *
 * It lives here and not in each router so the response is THE SAME in all
 * sections: a panel that has to recognize three different forms of "this
 * is off" will end up recognizing two.
 *
 * Typed as `MiddlewareHandler` and not as `(c: Context, next)`: with a
 * `Context` without route parameters, Hono stopped inferring the path's `:id`
 * in the next handler and `c.req.param("id")` came out as `string |
 * undefined` — eight TS2345 in live/routes.ts and the kon would not compile.
 */
export function requiresSection(
  sections: BroadcastSections,
  section: keyof BroadcastSections
): MiddlewareHandler {
  return async (c, next) => {
    if (sections[section]) return next();
    return c.json(
      {
        error: `The section «${section}» of Broadcast is turned off in this installation.`,
        section: section,
        description: EXPLANATION[section],
        // Where it is turned on, literally: having to look it up is what makes it not get done.
        enableWith: `konConfig["${KON_ID}"].${SECTION_SETTING[section]} = true`,
      },
      409
    );
  };
}
