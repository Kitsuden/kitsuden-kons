import { createId } from "@paralleldrive/cuid2";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { Action, GameDefinition, GameResult } from "./cardsim.engine.js";

/**
 * CardSim — games, cards, decks, rooms, matches and ranking
 * ============================================================================
 *
 * Tables are separated by the NATURE of the data, not for convenience:
 *
 *   · The GAME and its CARDS are editorial: they are published by whoever creates
 *     the simulator and read by everyone. No ownership.
 *   · The DECK is PERSONAL (`owner_id`, RLS): your list of 50 is yours, and in
 *     competitive it is genuinely sensitive information.
 *   · The SESSION is SHARED between its players and its spectators — but
 *     what each one SEES is decided by `viewFor`, not the row: the row stores the
 *     full log and the views are computed per seat.
 *   · The MATCH groups sessions (the Bo3 with side change between games).
 *   · The RANKING is derived: it is recomputed at the end of each game.
 *
 * The session does NOT store the state: it stores `{seed, decks, actions}` and the
 * state is rebuilt with `replay`. A whole game is a few KB of
 * actions — and replay, synchronization and undo come for free.
 */

export const cardsimGames = pgTable(
  "cardsim_games",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** The whole definition, validated by `validateGameDefinition` on publishing. */
    definition: jsonb("definition").$type<GameDefinition>().notNull(),
    published: text("published").default("draft").notNull(),

    /**
     * CMS dataset the catalog is synced from, if any.
     *
     * Without this, the cards have to be dumped through the request body and
     * become a second copy that drifts from the dataset as soon as
     * someone fixes a typo in only one of the two places.
     */
    catalogDatasetId: text("catalog_dataset_id"),
    /** Dataset field that carries the `card_id`. `null` = the row id. */
    catalogIdField: text("catalog_id_field"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("cardsim_games_slug_idx").on(t.slug)]
);

export const cardsimCards = pgTable(
  "cardsim_cards",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    gameId: text("game_id").notNull(),
    /** Stable id WITHIN the game: it is what decks reference. */
    cardId: text("card_id").notNull(),
    name: text("name").notNull(),
    /**
     * Card properties as a document: cost, type, color, text… The
     * engine does not interpret them (it moves cards, it does not read rules), but
     * `validateDeck` DOES read them for the caps per group and per distinct colors.
     */
    data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
    imageUrl: text("image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("cardsim_cards_game_card_idx").on(t.gameId, t.cardId),
    // The deck builder searches by name within a game.
    index("cardsim_cards_game_name_idx").on(t.gameId, t.name),
  ]
);

export const cardsimDecks = pgTable(
  "cardsim_decks",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    gameId: text("game_id").notNull(),
    name: text("name").default("Deck").notNull(),
    /**
     * List of `cardId` (repeated = copies) or map by section
     * (`{main: [...], soul: [...]}`). The bare list is accepted so as not to
     * invalidate decks saved before sections existed.
     */
    cards: jsonb("cards").$type<string[] | Record<string, string[]>>().notNull(),
    ownerId: text("owner_id"),
    /** Share a deck by URL without exposing its internal id. */
    shareId: text("share_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("cardsim_decks_owner_idx").on(t.ownerId, t.gameId),
    uniqueIndex("cardsim_decks_share_idx").on(t.shareId),
  ]
);

/**
 * A match is the Bo3: several sessions that share a score. It exists because
 * between games the deck is CHANGED (side deck), so each game needs
 * its own snapshot of decks — reusing the session will not do.
 */
export const cardsimMatches = pgTable(
  "cardsim_matches",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    gameId: text("game_id").notNull(),
    bestOf: integer("best_of").default(1).notNull(),
    /** User ids per seat, fixed throughout the match. */
    seats: jsonb("seats").$type<(string | null)[]>().notNull(),
    /** Games won per seat. */
    wins: jsonb("wins").$type<number[]>().default([]).notNull(),
    status: text("status").default("open").notNull(),
    rated: boolean("rated").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("cardsim_matches_status_idx").on(t.gameId, t.status)]
);

export const cardsimSessions = pgTable(
  "cardsim_sessions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    gameId: text("game_id").notNull(),
    name: text("name"),
    /** RNG seed. With it and the actions, the game is reproducible. */
    seed: integer("seed").notNull(),
    /**
     * Randomness secret (256 bits, hex). NULL in old games and in
     * solitaire with a fixed seed. See cardsim.seed.ts.
     */
    secretRng: text("secret_rng"),
    /** Snapshot of the decks AT THE START: editing the deck does not rewrite games. */
    decks: jsonb("decks").$type<(string[] | Record<string, string[]>)[]>().notNull(),
    /** User ids per seat. `null` = open seat. */
    seats: jsonb("seats").$type<(string | null)[]>().notNull(),
    /** The complete log. IT IS the state: it is rebuilt with `replay`. */
    actions: jsonb("actions").$type<Action[]>().default([]).notNull(),
    status: text("status").default("open").notNull(),

    // ── Room ──────────────────────────────────────────────────────────────
    /** `public` appears in the lobby; `private` is only entered with the link. */
    visibility: text("visibility").default("public").notNull(),
    /**
     * Short code to enter or watch without passing the internal id. It is what is
     * dictated aloud or pasted into a chat — a 24-character cuid2 cannot be
     * dictated.
     */
    code: text("code"),
    /**
     * Salted scrypt hash, never the password. It is a room password, not an account one, but
     * people reuse passwords — storing it in plaintext would be handing out
     * other people's credentials.
     */
    passwordHash: text("password_hash"),
    allowSpectators: boolean("allow_spectators").default(true).notNull(),

    // ── Match ─────────────────────────────────────────────────────────────
    matchId: text("match_id"),
    gameIndex: integer("game_index").default(0).notNull(),

    /**
     * Undo REQUESTED and pending the opponent's acceptance. Undoing is
     * truncating the action list, so it is enough to store how far back.
     */
    undoRequest: jsonb("undo_request").$type<{ by: number; toActionCount: number } | null>(),

    /**
     * State epoch. It goes up when the action prefix stops describing
     * this game: on UNDO (which truncates) and on SITTING (which changes the
     * decks). Everything else only adds actions, and from there it can continue.
     *
     * It is what allows caching the state without risking serving an old
     * board: an entry from another epoch is discarded without looking at it.
     */
    stateEpoch: integer("state_epoch").default(0).notNull(),

    // ── Clock ─────────────────────────────────────────────────────────────
    // The clock lives OUTSIDE the engine on purpose: time is wall-clock and the
    // engine has to be reproducible. If the clock were inside, every
    // replay would give a different game. Here it is only subtracted; when it
    // runs out, the server sends a NORMAL `concede`, which does enter the log.
    /** Milliseconds remaining per seat. `null` = game without a clock. */
    clocks: jsonb("clocks").$type<number[] | null>(),
    /** When the active player's clock started running. */
    clockStartedAt: timestamp("clock_started_at", { withTimezone: true }),
    /** Increment per finished turn (Fischer style), in milliseconds. */
    incrementMs: integer("increment_ms").default(0).notNull(),

    /** Result frozen at the end: avoids replaying the game to read it. */
    result: jsonb("result").$type<GameResult | null>(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    ownerId: text("owner_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("cardsim_sessions_owner_idx").on(t.ownerId, t.status),
    uniqueIndex("cardsim_sessions_code_idx").on(t.code),
    // The lobby: open public games of a game.
    index("cardsim_sessions_lobby_idx").on(t.gameId, t.status, t.visibility),
    index("cardsim_sessions_match_idx").on(t.matchId),
  ]
);

/**
 * Ranking per game. It is DERIVED from finished games, but it is
 * materialized: recomputing the Elo of thousands of games to paint a table
 * would be absurd.
 */
export const cardsimRatings = pgTable(
  "cardsim_ratings",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    gameId: text("game_id").notNull(),
    userId: text("user_id").notNull(),
    rating: integer("rating").default(1200).notNull(),
    wins: integer("wins").default(0).notNull(),
    losses: integer("losses").default(0).notNull(),
    draws: integer("draws").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("cardsim_ratings_game_user_idx").on(t.gameId, t.userId),
    index("cardsim_ratings_board_idx").on(t.gameId, t.rating),
  ]
);

/** Matchmaking queue. One row per user: you do not queue twice. */
export const cardsimQueue = pgTable(
  "cardsim_queue",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    gameId: text("game_id").notNull(),
    userId: text("user_id").notNull(),
    deckId: text("deck_id").notNull(),
    rated: boolean("rated").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("cardsim_queue_user_idx").on(t.userId),
    index("cardsim_queue_game_idx").on(t.gameId, t.createdAt),
  ]
);

export type CardsimGame = typeof cardsimGames.$inferSelect;
export type CardsimCard = typeof cardsimCards.$inferSelect;
export type CardsimDeck = typeof cardsimDecks.$inferSelect;
export type CardsimMatch = typeof cardsimMatches.$inferSelect;
export type CardsimSession = typeof cardsimSessions.$inferSelect;
export type CardsimRating = typeof cardsimRatings.$inferSelect;
