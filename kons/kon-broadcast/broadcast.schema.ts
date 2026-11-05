import { createId } from "@paralleldrive/cuid2";
import { pgTable, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Types of the live subsystem. These are TYPE-ONLY imports: they disappear at
 * compile time, so declaring the columns does not drag in the section's code
 * nor require it to be turned on.
 */
import type { DraftState, SeriesHistory } from "./live/draft.js";
import type { LiveFrame } from "./live/frame.js";
import type { GoldPoint } from "./live/gold.js";

/**
 * Broadcast — Broadcast graphics for FGC tournaments (2XKO)
 * ============================================================================
 *
 * Models what the original Broadcast "bridge" kept in `state.json`: the
 * authoritative state of a tournament set that feeds the OBS overlay.
 * Here it lives in Postgres, so it survives restarts, is multi-operator and
 * is subject to Kitsuden's policies and RLS.
 */

/**
 * One side of the scoreboard (player or team).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REFERENCE + SNAPSHOT, and why both
 *
 * `playerId` points to the canonical `kon-esports` record — the player table is
 * NOT duplicated here. But the fields below are not redundant either: they are
 * the snapshot "as it went on air".
 *
 * The reason is about broadcasting, not the database: if a player changes their
 * gamertag next month, the VODs and the sets already played **must not be
 * rewritten**. Linking fills in the snapshot once; from then on,
 * editing the scoreboard does not touch the player's record, and editing the record does not touch
 * past sets.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface BroadcastSide {
  /**
   * Player from the `kon-esports` registry, if linked.
   * `null` = typed by hand (guest, new player, improvised event).
   *
   * Required-but-nullable, not optional: `undefined` and `null` would mean
   * the same thing and drizzle's insert type rejects the ambiguity.
   */
  playerId: string | null;
  /**
   * Row of `esports_tournament_participants` when the set was built from the
   * bracket. It is what allows reporting the result without asking again
   * who is who.
   *
   * Different from `playerId`: a participant can be a team, and the same
   * player can take part in several tournaments at once.
   */
  participantId: string | null;
  /**
   * Country (ISO alpha-2) as it went on air, or `null`.
   *
   * Snapshot, like the rest of the side: if the player corrects their country in
   * the record, the VODs are not rewritten.
   */
  country: string | null;
  /** Sponsor/team prefix, e.g. "TSM". */
  sponsor: string;
  /**
   * Side's crest. External or served by `kon-media`.
   *
   * It lives on the side and not in a teams table because, like the rest of the
   * side, it is a SNAPSHOT: if a team changes crest, the VODs are not
   * rewritten.
   */
  logoUrl?: string | null;
  /** Gamertag shown on the scoreboard. */
  name: string;
  /**
   * Player's selection (characters, champions, agents…). How many fit and
   * what they are called is decided by the set's game profile; here it is a list of
   * slugs because that is the shape all of them share.
   */
  chars: string[];
  score: number;
  /** Comes from the losers side of the bracket. */
  losers: boolean;
  /** Side's accent color, in hex. */
  color: string;
}

/** Lower bar sponsor. */
export interface BroadcastSponsor {
  name: string;
  logoUrl: string | null;
}

/**
 * Visual theme of the broadcast.
 *
 * It is what lets the same graphic serve two different leagues without
 * forking it. It is applied as CSS variables, so a third party can take it
 * further with their own stylesheet without touching this kon.
 *
 * It came from the MOBA kon, but there is nothing MOBA about it: a fighting league wants
 * exactly the same.
 */
export interface BroadcastTheme {
  /** Production accent, above each side's color. */
  accent: string;
  /** Panel background. Translucent over the game. */
  surface: string;
  /** Panel opacity, 0–1. */
  surfaceOpacity: number;
  /** `sharp` (hard corners) or `soft` (rounded). */
  corners: "sharp" | "soft";
  /** Font family. Must be available on the broadcasting machine. */
  fontFamily: string | null;
}

export const DEFAULT_THEME: BroadcastTheme = {
  accent: "#4c8dff",
  surface: "#070a10",
  surfaceOpacity: 0.86,
  corners: "sharp",
  fontFamily: null,
};

/**
 * Fearless mode: champions/characters that can no longer be repeated within the
 * same match.
 *
 *   · `off`    — everything can be repeated.
 *   · `global` — what is picked is locked for both sides.
 *   · `team`   — locked only for whoever picked it.
 *
 * It was born in MOBA but the rule is about FORMAT, not game: any title with
 * character selection can be played this way.
 */
export type FearlessMode = "off" | "global" | "team";

/** Lower third commentator. */
export interface BroadcastCaster {
  name: string;
  handle: string;
}

/** Which screens are on air right now. */
export interface BroadcastScreens {
  ko: boolean;
  versus: boolean;
  casters: boolean;
  /**
   * Set result screen.
   *
   * The K.O. is a two-second dramatic effect; this is the one left
   * up while the caster summarizes, and the one that tells someone who has just
   * joined the stream who won.
   */
  result: boolean;
}

// ── Sets / matches ───────────────────────────────────────────────────────────

export const broadcastMatches = pgTable(
  "broadcast_matches",
  {
    id: text("id").primaryKey().$defaultFn(createId),

    // ── Event ──
    eventTitle: text("event_title").default("TOURNAMENT").notNull(),
    round: text("round").default("Winners Finals").notNull(),
    firstTo: integer("first_to").default(3).notNull(),

    /**
     * Game profile the set was created with (`2xko`, `sf6`, `1v1`…).
     *
     * It is stored IN THE ROW, not only in the grimoire's configuration, because it
     * defines the shape of `side_a`/`side_b`. If it lived only in the
     * configuration, changing the tournament's game would reinterpret the payload of
     * sets already played —and the VODs would stop matching what the
     * API returns—. Here, a set is born with its profile and keeps it.
     *
     * `null` on rows from before profiles: they are resolved against the
     * configured one, which is the behavior they already had.
     */
    profileId: text("profile_id"),

    // ── Scoreboard sides ──
    sideA: jsonb("side_a").$type<BroadcastSide>().notNull(),
    sideB: jsonb("side_b").$type<BroadcastSide>().notNull(),

    // ── Talent and screens ──
    casters: jsonb("casters").$type<BroadcastCaster[]>().default([]).notNull(),
    screens: jsonb("screens").$type<BroadcastScreens>().notNull(),

    /** Set on air: at most one per operator. */
    live: boolean("live").default(false).notNull(),

    /**
     * Top banner message, or `null` if there is none.
     *
     * "Registration open for next weekly", "Top 8 at 19:00".
     * A field, not a queue: in a rushed booth, the current message is
     * one and the operator overwrites or removes it. A queue would force managing it
     * live, which is exactly the kind of task nobody does well in a rush.
     */
    ticker: text("ticker"),

    // ── Production ──
    /**
     * Visual theme and sponsors of THIS broadcast.
     *
     * On the row and not in the grimoire's configuration for the same reason as
     * `profileId`: two different tournaments on the same weekend do not share
     * branding, and a VOD has to be able to reproduce how it went on air.
     */
    theme: jsonb("theme").$type<BroadcastTheme>().default(DEFAULT_THEME).notNull(),
    sponsors: jsonb("sponsors").$type<BroadcastSponsor[]>().default([]).notNull(),

    /**
     * Scheduled start time. Feeds the pre-match countdown.
     *
     * The overlay receives the SECONDS remaining, not this timestamp: the clock of the PC
     * that broadcasts and the server's do not match, and a countdown computed on
     * the client would drift from what the operator sees.
     */
    startsAt: timestamp("starts_at", { withTimezone: true }),

    /**
     * Fearless mode of the match.
     *
     * It goes here and not on the game because it is a rule of the FORMAT: changing it
     * in the middle of a Bo5 would invalidate the earlier drafts.
     *
     * Only the draft section consumes it; with that section turned off it is an
     * inert field, and that is the idea — the data survives the section being turned off.
     */
    fearless: text("fearless").$type<FearlessMode>().default("off").notNull(),

    /** start.gg set it was imported from, if applicable. */
    startggSetId: text("startgg_set_id"),

    /**
     * `kon-esports` bracket set it was built from, if applicable.
     *
     * They go together on purpose: `bracketMatchId` (`W2M1`) is only unique WITHIN
     * a tournament, so without the tournament it identifies nothing. They are the pair
     * that allows returning the result to the bracket without asking again.
     *
     * No foreign key: `kon-esports` may not be installed, and an FK
     * between kons would stop Broadcast from creating its table without it —
     * exactly the coupling the dynamic bridge avoids.
     */
    tournamentId: text("tournament_id"),
    bracketMatchId: text("bracket_match_id"),

    status: text("status").default("draft").notNull(),

    // ownerId: used by the "broadcast" policy (owner isolation) and by RLS.
    ownerId: text("owner_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("broadcast_matches_owner_live_idx").on(t.ownerId, t.live),
    // The TO's panel asks "which sets do I have built for this tournament?" every
    // time it opens; without this it is a scan of the whole table.
    index("broadcast_matches_tournament_idx").on(t.tournamentId, t.bracketMatchId),
  ]
);

export type BroadcastMatch = typeof broadcastMatches.$inferSelect;
export type NewBroadcastMatch = typeof broadcastMatches.$inferInsert;

// ── Games within a match ─────────────────────────────────────────────────────

/**
 * A specific game of a best-of-N match.
 *
 * ── WHY IT IS OPTIONAL ─────────────────────────────────────────────────────
 *
 * A best-of-five fighting set does not need five rows: the score is a
 * counter and there is nothing else to store about each game. A MOBA Bo5 does,
 * because each game carries its draft, its gold and its telemetry.
 *
 * That is why this table always exists but is only used by profiles that
 * declare it (`games` section). A match with no rows here is not
 * incomplete: its game simply stores nothing per game.
 *
 * ── AND WHY IT DOES NOT FIT IN THE CONTAINER ───────────────────────────────
 *
 * Putting both things in one table would force repeating each side's crest and color
 * five times in a Bo5, and renaming a team mid-broadcast
 * would leave the earlier games with the old name.
 *
 * LIVE state is not here: it lives in the synced state (see
 * `live/session.ts`). Persisting 5 frames per second would be 18,000 writes
 * per game to paint something nobody will look at two minutes later.
 */
export const broadcastGames = pgTable(
  "broadcast_games",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    matchId: text("match_id").notNull(),

    /** 1-based. Game 1 of a Bo5 is 1, not 0. */
    gameNumber: integer("game_number").default(1).notNull(),

    /**
     * Whether the match's side A takes the first side WITHIN the
     * game (blue in a MOBA, P1 in fighting).
     *
     * It is game data and not match data because in competition sides
     * are swapped between games.
     */
    sideAFirst: boolean("side_a_first").default(true).notNull(),

    draft: jsonb("draft").$type<DraftState | null>(),

    /**
     * Selected characters, **indexed by MATCH side**, not
     * by game side.
     *
     * The distinction is not cosmetic: since sides are swapped, the
     * "first" of game 2 may be the match's side B.
     * Storing it by game side would make Fearless in `team` mode
     * lock characters to the WRONG side from the second game on — and
     * that invalidates the whole match.
     */
    drafted: jsonb("drafted").$type<SeriesHistory>().default({ blue: [], red: [] }).notNull(),

    /** Ingest adapter used. Stored so it can be diagnosed later. */
    ingestId: text("ingest_id"),
    /**
     * Local agent token, if one was issued.
     *
     * It lives on the GAME row and not the user's on purpose: that way the
     * scope of a leak is one specific game, and revoking it means issuing
     * another — without touching anyone's session.
     */
    ingestToken: text("ingest_token"),
    /** Patch it was played on. Changes the gold and objective constants. */
    patch: text("patch"),

    /**
     * Last known frame. It is a SNAPSHOT for the post-game and for
     * recovering if the production restarts, not a continuous log.
     */
    snapshot: jsonb("snapshot").$type<LiveFrame | null>(),
    /** Gold difference series, already downsampled. It is what the chart paints. */
    goldSeries: jsonb("gold_series").$type<GoldPoint[]>().default([]).notNull(),

    /** `blue` | `red` | null. GAME side, not match side. */
    winner: text("winner"),
    /** Duration in seconds. */
    duration: integer("duration"),

    status: text("status").default("pending").notNull(),

    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("broadcast_games_match_idx").on(t.matchId, t.gameNumber)]
);

export type BroadcastGame = typeof broadcastGames.$inferSelect;
export type NewBroadcastGame = typeof broadcastGames.$inferInsert;

// ── Champion roster ──────────────────────────────────────────────────────────

/**
 * Local 2XKO roster. The original Broadcast read the roster from Riot's CDN and
 * fell back to a local list if the API did not respond; here the table IS that fallback,
 * and can be refreshed without touching code.
 */
export const broadcastChampions = pgTable("broadcast_champions", {
  id: text("id").primaryKey().$defaultFn(createId),
  /** Stable champion slug, e.g. "ahri". */
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  /** Roster season it entered in. */
  season: integer("season").default(1).notNull(),
  portraitUrl: text("portrait_url"),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type BroadcastChampion = typeof broadcastChampions.$inferSelect;
export type NewBroadcastChampion = typeof broadcastChampions.$inferInsert;

// ── Defaults ─────────────────────────────────────────────────────────────────

export function defaultSide(name: string, color: string): BroadcastSide {
  return {
    playerId: null,
    participantId: null,
    country: null,
    sponsor: "",
    name,
    chars: [],
    score: 0,
    losers: false,
    color,
  };
}

/**
 * Seconds remaining until start, or `null` if there is no time or it has passed.
 *
 * Capped at 99 minutes: a match scheduled for tomorrow would
 * give a six-digit countdown that does not fit on screen and adds nothing
 * —nobody leaves the overlay up a day before—.
 */
export function countdownFor(startsAt: Date | null, now: Date): number | null {
  if (!startsAt) return null;
  const seconds = Math.ceil((startsAt.getTime() - now.getTime()) / 1000);
  if (seconds <= 0) return null;
  return Math.min(seconds, 99 * 60);
}

/**
 * How many games must be won, from the "best of N".
 *
 * `firstTo` is the canonical field —what is stored— because it is what decides
 * when the match closes. `bestOf` is the way people
 * say it. They are NOT the same number: a Bo3 is won on reaching 2.
 *
 * Having it written once avoids the silent failure of storing a 3 where a
 * 2 belonged and the bracket advancing a round too early.
 */
export function firstToFromBestOf(bestOf: number): number {
  return Math.floor(Math.max(1, bestOf) / 2) + 1;
}

/** The inverse: a `firstTo` of 3 is announced as "Bo5". */
export function bestOfFromFirstTo(firstTo: number): number {
  return Math.max(1, firstTo) * 2 - 1;
}

export const DEFAULT_SCREENS: BroadcastScreens = {
  ko: false,
  versus: false,
  casters: false,
  result: false,
};
