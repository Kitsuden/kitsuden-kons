/**
 * Kitsuden CMS — Esports Module Schema
 *
 * Consolidated schema for players, teams, tournaments, and matches.
 * All esports competitive features in one kon.
 */

import { relations, isNotNull } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
  pgEnum,
  boolean,
} from "drizzle-orm/pg-core";

// ═══════════════════════════════════════════════
// Enums
// ═══════════════════════════════════════════════

export const tournamentFormatEnum = pgEnum("esports_tournament_format", ["1v1", "Team"]);
export const tournamentStatusEnum = pgEnum("esports_tournament_status", [
  "Draft",
  "Open",
  "InProgress",
  "Completed",
]);
export const participantStatusEnum = pgEnum("esports_participant_status", [
  "Pending",
  "Approved",
  "Rejected",
]);
export const matchStatusEnum = pgEnum("esports_match_status", [
  "Pending",
  "Ready",
  "InProgress",
  "Completed",
  /** Advanced without playing: the opponent could never arrive (bye). */
  "Bye",
  /** The set never comes to exist: branch empty due to byes or a total DQ. */
  "Void",
]);

/** Bracket format. Resolved by the pure engine in `bracket.ts`. */
export const bracketFormatEnum = pgEnum("esports_bracket_format", [
  "single_elimination",
  "double_elimination",
  /** Everyone against everyone: groups, leagues, pools with advancement by points. */
  "round_robin",
  /**
   * Swiss: everyone plays all the rounds, paired by score.
   *
   * It is the format of Magic, Pokémon and Hearthstone, and the one most used online
   * — nobody goes home after two games.
   */
  "swiss",
]);

/** Seeding method. `random` stores the seed so the draw can be audited. */
export const seedMethodEnum = pgEnum("esports_seed_method", ["as_entered", "random", "by_rating"]);

/** Side of the bracket a set belongs to. */
export const bracketSideEnum = pgEnum("esports_bracket_side", ["winners", "losers", "grand_final"]);

// ═══════════════════════════════════════════════
// Players Table
// ═══════════════════════════════════════════════

export const players = pgTable(
  "esports_players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alias: varchar("alias", { length: 200 }).notNull(),
    /**
     * Country, as ISO 3166-1 alpha-2 in uppercase (`JP`, `MX`).
     *
     * Two letters and not the name: the overlay derives the flag from the code
     * (Unicode regional indicators) without a country table or CDN, and the translated
     * name is the interface's problem, not the data's.
     */
    country: varchar("country", { length: 2 }),
    avatarId: uuid("avatar_id"),
    bio: text("bio"),
    socialLinks: text("social_links"), // JSON string
    coreUserId: uuid("core_user_id"), // Optional core user link
    /**
     * Where it came from, if it was imported (`startgg`, `matcherino`).
     *
     * It is the key of the idempotent import. Matching by `alias` will not do: two
     * people share a gamertag across platforms (and would end up merged), and
     * a rename between tournaments creates a duplicate that splits the history.
     */
    externalSource: varchar("external_source", { length: 20 }),
    externalId: varchar("external_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("players_alias_idx").on(t.alias)]
);

// ═══════════════════════════════════════════════
// Teams Table
// ═══════════════════════════════════════════════

export const teams = pgTable(
  "esports_teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    logoId: uuid("logo_id"),
    captainId: uuid("captain_id").references(() => players.id, { onDelete: "set null" }),
    /** Who created it. It is who can invite while there is no linked captain. */
    createdByUserId: text("created_by_user_id"),
    /** See `players.externalSource`: same reason, same pair. */
    externalSource: varchar("external_source", { length: 20 }),
    externalId: varchar("external_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("teams_name_idx").on(t.name)]
);

// ═══════════════════════════════════════════════
// Players to Teams Junction Table
// ═══════════════════════════════════════════════

export const playersToTeams = pgTable(
  "esports_players_to_teams",
  {
    playerId: uuid("player_id")
      .references(() => players.id, { onDelete: "cascade" })
      .notNull(),
    teamId: uuid("team_id")
      .references(() => teams.id, { onDelete: "cascade" })
      .notNull(),
    /**
     * `captain` | `player` | `sub`.
     *
     * A substitute does NOT count toward the roster minimum: without distinguishing, a
     * team of 3 with 2 substitutes looks complete and is not.
     */
    role: varchar("role", { length: 20 }).default("player"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [uniqueIndex("pt_unique").on(t.playerId, t.teamId)]
);

// ═══════════════════════════════════════════════
// Tournaments Table
// ═══════════════════════════════════════════════

export const tournaments = pgTable("esports_tournaments", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 200 }).notNull(),
  gameId: uuid("game_id").notNull(), // References games.id from kon-games
  format: tournamentFormatEnum("format").default("1v1").notNull(),
  maxParticipants: integer("max_participants").notNull(),
  status: tournamentStatusEnum("status").default("Draft").notNull(),

  // ── Bracket configuration ──
  bracketFormat: bracketFormatEnum("bracket_format").default("single_elimination").notNull(),
  seedMethod: seedMethodEnum("seed_method").default("as_entered").notNull(),
  /**
   * Draw seed. It is stored so the same bracket can be REGENERATED: faced with
   * a complaint, a TO has to be able to prove the draw was not tampered with.
   */
  shuffleSeed: integer("shuffle_seed"),
  championId: uuid("champion_id"),

  /**
   * Check-in window. `checkInOpensAt` null = the tournament does not use check-in.
   *
   * Without `closesAt` the window does not close by itself: some TOs close by hand
   * when they see the room full, and forcing a time would require inventing one.
   */
  checkInOpensAt: timestamp("check_in_opens_at", { withTimezone: true }),
  checkInClosesAt: timestamp("check_in_closes_at", { withTimezone: true }),

  /**
   * Public registration. `closed` by default and on purpose: opening it is a
   * decision, not something that happens to a tournament by existing.
   */
  registrationMode: varchar("registration_mode", { length: 20 }).default("closed").notNull(),
  registrationOpensAt: timestamp("registration_opens_at", { withTimezone: true }),
  registrationClosesAt: timestamp("registration_closes_at", { withTimezone: true }),
  /**
   * Independent of the window: an in-person event with 16 setups does NOT want a waiting
   * list (no more people fit), and an online one usually does.
   */
  waitlistEnabled: boolean("waitlist_enabled").default(false).notNull(),
  rulesText: text("rules_text"),
  requiresRulesAcceptance: boolean("requires_rules_acceptance").default(false).notNull(),
  /**
   * Minutes an unconfirmed report waits for the opponent before it can be taken
   * as good. 0 = never; someone always signs it.
   *
   * It belongs to the TO and not the player: without a deadline, the first to press would decide
   * any set just by waiting a while.
   */
  reportGraceMinutes: integer("report_grace_minutes").default(0).notNull(),

  /**
   * Minimum and maximum roster, in team tournaments.
   *
   * A 5v5 with teams of 3 cannot be played, and finding that out when generating the
   * bracket is too late: by then registration is closed.
   */
  minRosterSize: integer("min_roster_size"),
  maxRosterSize: integer("max_roster_size"),

  /**
   * Can one sign up WITHOUT an account? Only applies to 1v1 tournaments.
   *
   * Asking for an account in a community 1v1 is where half the people are lost:
   * someone arriving from a tweet does not want one more account, they want to play.
   *
   * In TEAM tournaments the account is mandatory and this is not consulted: a
   * team needs a captain who answers and invitations someone accepts, and
   * that cannot rest on an identity that is forgotten that same afternoon.
   */
  // Off by default (an earlier audit): without verifying the email, a
  // script filled any open tournament. Whoever wants it turns it on.
  allowGuestRegistration: boolean("allow_guest_registration").default(false).notNull(),

  /**
   * Is a screenshot required when reporting?
   *
   * Online it is what turns "I think I won" into something that can be resolved
   * without knowing anyone: without proof, the TO's disputes screen shows two
   * contradictory versions and nothing else.
   */
  requiresEvidence: boolean("requires_evidence").default(false).notNull(),

  /**
   * Definition of the custom registration fields (Riot ID, region,
   * deck list, PayPal email…).
   *
   * In jsonb and not in tables because it is data only THIS tournament understands:
   * normalizing it would require a values table per field in order never to
   * query it. Each field declares its `visibility`, and that is what
   * keeps a phone number from ending up in the public list of registrants.
   */
  customFields: jsonb("custom_fields").$type<unknown[]>().default([]).notNull(),

  /**
   * Swiss rounds. It is STORED instead of computed on each query because it is
   * an announced decision: "it is 5 rounds" appears in the tournament rules and
   * cannot change by itself because three more people sign up.
   */
  swissRounds: integer("swiss_rounds"),

  /**
   * Origin, if the tournament was imported. No unique index on purpose: the same
   * event may be imported twice deliberately (a test run and the real one).
   */
  externalSource: varchar("external_source", { length: 20 }),
  externalId: varchar("external_id", { length: 64 }),
  externalUrl: text("external_url"),

  /**
   * Prize pool in CENTS, integer.
   *
   * Never floating point: it is money, and it appears on screen. It is also how
   * Matcherino publishes it, so there is no conversion to lose along the way.
   * The currency goes alongside because a figure without a currency in an overlay is worse
   * than not showing it.
   */
  prizePoolCents: integer("prize_pool_cents"),
  prizePoolCurrency: varchar("prize_pool_currency", { length: 3 }),
  prizePoolSyncedAt: timestamp("prize_pool_synced_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════
// Tournament Participants Table
// ═══════════════════════════════════════════════

export const tournamentParticipants = pgTable(
  "esports_tournament_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .references(() => tournaments.id, { onDelete: "cascade" })
      .notNull(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    status: participantStatusEnum("status").default("Pending").notNull(),
    /**
     * When they confirmed presence. `null` = has not checked in.
     *
     * It is a TIMESTAMP and not a boolean because the TO needs to know
     * who arrived late when deciding whom to wait for.
     */
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    /** Seeding position (1 = best). Assigned by the engine on generation. */
    seed: integer("seed"),
    /** Score used by `by_rating` seeding. */
    rating: integer("rating"),
    /** Total DQ: out of the tournament even if the format gave them another life. */
    eliminated: boolean("eliminated").default(false).notNull(),

    /**
     * Who PRESSED the sign-up button.
     *
     * Different from the player: a captain registers their team, and whoever can
     * withdraw is the one who signed up, not just anyone with that name.
     */
    registeredByUserId: text("registered_by_user_id"),
    /**
     * ARRIVAL order on the waiting list. `null` = actually registered.
     *
     * It only grows and is never reused; "you are 3rd in the queue" is computed
     * by counting how many are ahead. Renumbering when someone leaves would rewrite N
     * rows per withdrawal and, with two withdrawals at once, two concurrent promotions
     * would compute the same slot and leave duplicate positions.
     */
    waitlistPosition: integer("waitlist_position"),
    /**
     * Email of the guest who signed up without an account.
     *
     * **It is personal data and NEVER appears in a public response.** The list
     * of a tournament's registrants is public; the emails in that list are not.
     */
    guestEmail: varchar("guest_email", { length: 160 }),
    /**
     * HASH of the personal link, never the link.
     *
     * Without an account there is no session, so the link IS the credential: with it
     * you check in, report the set and withdraw the registration. In plain text,
     * a database leak would grant the ability to report on behalf of everyone.
     *
     * SHA-256 and not bcrypt: it has to be looked up on every request, so it
     * must be deterministic and indexable. The entropy comes from the token (32 random
     * bytes), not from a password chosen by someone.
     */
    accessTokenHash: varchar("access_token_hash", { length: 64 }),
    /** Answers to the custom fields. See `tournaments.customFields`. */
    customData: jsonb("custom_data").$type<Record<string, unknown>>().default({}).notNull(),
    /**
     * When they withdrew, in Swiss.
     *
     * Different from `eliminated`: whoever withdraws **keeps their record** for the
     * tiebreakers of others. If it disappeared, everyone who beat them would
     * lose the credit for that win.
     */
    droppedAt: timestamp("dropped_at", { withTimezone: true }),
    acceptedRulesAt: timestamp("accepted_rules_at", { withTimezone: true }),
    /** Contact handle (Discord). It is how the TO announces that it is time to play. */
    contactHandle: varchar("contact_handle", { length: 120 }),

    registeredAt: timestamp("registered_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Ensuring a player or team does not register multiple times in the same tournament
    uniqueIndex("tp_player_unique").on(t.tournamentId, t.playerId).where(isNotNull(t.playerId)),
    uniqueIndex("tp_team_unique").on(t.tournamentId, t.teamId).where(isNotNull(t.teamId)),
    // One account, one registration. It is what keeps the same person from entering
    // three times with three aliases to triple their chances in the draw.
    uniqueIndex("tp_user_unique")
      .on(t.tournamentId, t.registeredByUserId)
      .where(isNotNull(t.registeredByUserId)),
  ]
);

// ═══════════════════════════════════════════════
// Match Reports Table
// ═══════════════════════════════════════════════

/**
 * A result report. **It is not a result**: it is what ONE of the
 * parties declares, and it becomes a result when it matches the other or when
 * the TO signs it.
 *
 * It lives in its own table instead of writing the set winner directly
 * because, if that distinction is lost, the first to press decides the set — and
 * in double elimination that sends someone to losers for no reason.
 *
 * Reports are NOT overwritten: the history is the evidence when there is
 * a complaint.
 */
export const matchReports = pgTable(
  "esports_match_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .references(() => matches.id, { onDelete: "cascade" })
      .notNull(),
    /**
     * Who sends it, as a PARTICIPANT and not as a user: it is what allows
     * checking that they play that set without resolving identities on every query.
     */
    reportedBy: uuid("reported_by")
      .references(() => tournamentParticipants.id, { onDelete: "cascade" })
      .notNull(),
    winnerId: uuid("winner_id")
      .references(() => tournamentParticipants.id, { onDelete: "cascade" })
      .notNull(),
    /**
     * Score in the order [participant 1, participant 2] of the SET, always.
     * Storing it "from the reporter" would require knowing who reported in order to read it.
     */
    score1: integer("score_1"),
    score2: integer("score_2"),
    /**
     * `true` if the organization signed it. What distinguishes "both agreed"
     * from "the TO decided" when a complaint comes in.
     */
    byStaff: boolean("by_staff").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("match_reports_match_idx").on(t.matchId, t.createdAt)]
);

// ═══════════════════════════════════════════════
// Matches Table
// ═══════════════════════════════════════════════

export const matches = pgTable("esports_matches", {
  id: uuid("id").primaryKey().defaultRandom(),
  tournamentId: uuid("tournament_id")
    .references(() => tournaments.id, { onDelete: "cascade" })
    .notNull(),

  /**
   * Phase the set belongs to. `null` = single-phase tournament.
   *
   * Nullable on purpose: a tournament without phases keeps working exactly
   * as before, with all its sets in `phase_id IS NULL`. Without that, adding
   * phases would have required migrating every existing tournament to a fictitious phase.
   */
  phaseId: uuid("phase_id"),

  // Bracket positioning
  round: integer("round").notNull(), // 1, 2, 3...
  matchOrder: integer("match_order").notNull(), // Position within the round (1, 2, 3...)

  /**
   * Stable engine id: `W2M1`, `L3M2`, `GF`, `GFR`. It is the key with which
   * rows are reconciled against the recomputed bracket, so as not to depend
   * on insertion order.
   */
  bracketMatchId: varchar("bracket_match_id", { length: 20 }),
  bracketSide: bracketSideEnum("bracket_side").default("winners").notNull(),

  // Participants
  participant1Id: uuid("participant_1_id").references(() => tournamentParticipants.id, {
    onDelete: "set null",
  }),
  participant2Id: uuid("participant_2_id").references(() => tournamentParticipants.id, {
    onDelete: "set null",
  }),

  // Link to the NEXT match they will advance to
  nextMatchId: uuid("next_match_id"), // Self-referential
  /** Where the LOSER goes. It is what makes double elimination possible. */
  loserNextMatchId: uuid("loser_next_match_id"),
  /** Participant disqualified in this set, if any. */
  dqParticipantId: uuid("dq_participant_id"),

  // Results
  participant1Score: integer("participant_1_score").default(0).notNull(),
  participant2Score: integer("participant_2_score").default(0).notNull(),
  winnerId: uuid("winner_id").references(() => tournamentParticipants.id, { onDelete: "set null" }),

  status: matchStatusEnum("status").default("Pending").notNull(),

  /** Where it is played: a setup in the room, or a game lobby. */
  stationId: uuid("station_id"),

  /**
   * Broadcast. `streamQueuePosition` null = not in any queue.
   *
   * The position lives here and not in a join table: a set is in one queue
   * or in none, and a table for a 1-to-1 relation only adds a way for
   * the two to get out of sync.
   */
  streamId: uuid("stream_id"),
  streamQueuePosition: integer("stream_queue_position"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════
// Online Operations
// ═══════════════════════════════════════════════

/**
 * Outbox of notices.
 *
 * It is a TABLE and not a direct call to Discord, and that decision underpins
 * everything else in an online tournament:
 *
 *   1. The row is written in the SAME transaction as the fact that causes it.
 *      With an HTTP call, a failure between "advance the bracket" and "notify"
 *      loses the notice, and nobody finds out until two people have been waiting
 *      twenty minutes for a set that was already ready.
 *   2. The bot POLLS and acknowledges. A community bot restarts and loses its
 *      network; with webhooks, everything that happens while it is down is lost.
 *   3. Discord rate-limits. The pace has to be set by the bot.
 */
export const notifications = pgTable(
  "esports_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .references(() => tournaments.id, { onDelete: "cascade" })
      .notNull(),
    /** Who it goes to. `null` = announcement for the whole tournament. */
    participantId: uuid("participant_id").references(() => tournamentParticipants.id, {
      onDelete: "cascade",
    }),
    type: varchar("type", { length: 40 }).notNull(),
    /**
     * Deduplication key, built from the FACT and not the moment
     * (`match.ready:<matchId>:<participantId>`). The bot retries and the TO
     * presses again; the same fact cannot send two DMs.
     */
    dedupeKey: varchar("dedupe_key", { length: 160 }).notNull(),
    /**
     * Everything needed to write the message, ALREADY RESOLVED.
     *
     * A bot that needs five more calls to learn the opponent's name
     * is a bot that sends messages without names. Also, copying them here makes
     * the notice say what was true when it happened.
     */
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /** `null` = pending. It is the only state needed. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
  },
  (t) => [
    uniqueIndex("notifications_dedupe_unique").on(t.dedupeKey),
    index("notifications_pending_idx").on(t.tournamentId, t.createdAt),
  ]
);

/**
 * Invitation to a team.
 *
 * A team is not a name with people written next to it: it is people who have said
 * yes. Without acceptance, anyone registers whoever they feel like and on tournament
 * day half the roster does not know they are playing.
 */
export const teamInvites = pgTable(
  "esports_team_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .references(() => teams.id, { onDelete: "cascade" })
      .notNull(),
    /**
     * Who is invited. One of the two, not both:
     *   · `invitedUserId` — already has an account; it shows up in their panel.
     *   · `invitedHandle` — their Discord; the link is sent to them and they will join later.
     *
     * Without the second form, inviting would require the person to ALREADY be
     * registered — the reverse of the order in which it happens in a community.
     */
    invitedUserId: text("invited_user_id"),
    invitedHandle: varchar("invited_handle", { length: 120 }),
    /**
     * Link token. It is the credential that travels through Discord: random,
     * unique and single-use.
     */
    token: varchar("token", { length: 64 }).notNull(),
    role: varchar("role", { length: 20 }).default("player").notNull(),
    /** `pending` | `accepted` | `declined` | `revoked`. */
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    invitedByUserId: text("invited_by_user_id"),
    /**
     * The player it was ACCEPTED with (the alias of whoever accepted). It is the only thing
     * an invitation makes "yours": before, any player of the
     * team was valid, and a guest registered with the captain's alias
     * (an earlier audit).
     */
    acceptedPlayerId: uuid("accepted_player_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    /** A year-old link cannot get anyone into a team. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("team_invites_token_unique").on(t.token),
    index("team_invites_team_idx").on(t.teamId, t.status),
  ]
);

/**
 * Where a set is played.
 *
 * In person it is a setup with a number; online it is a lobby code. It is THE
 * SAME slot —"where you two go"— so it is the same table with a
 * `kind`. Separating them would have duplicated assignment, state and notice, only to end up
 * diverging.
 */
export const stations = pgTable(
  "esports_stations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .references(() => tournaments.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 60 }).notNull(),
    /** `physical` = a setup in the room. `lobby` = a game lobby. */
    kind: varchar("kind", { length: 20 }).default("physical").notNull(),
    /**
     * Lobby code or password.
     *
     * ONLY delivered to whoever plays that set and to the organization: publishing it is
     * inviting anyone to come in and wreck the game, which is the
     * classic problem of online tournaments.
     */
    accessDetails: text("access_details"),
    /** `open` | `in_use` | `closed`. */
    status: varchar("status", { length: 20 }).default("open").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("stations_tournament_idx").on(t.tournamentId, t.status)]
);

/**
 * Broadcast channel of the tournament.
 *
 * Online the stream is not an extra: it is the venue. That is why it is stored as part
 * of the tournament and not as a loose link in the description.
 */
export const streams = pgTable(
  "esports_streams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .references(() => tournaments.id, { onDelete: "cascade" })
      .notNull(),
    /** `twitch` | `youtube` | `kick`. Determines how the embed is built. */
    platform: varchar("platform", { length: 20 }).notNull(),
    /**
     * The channel, NOT the full URL: the URL is built, and one pasted by hand
     * ends up pointing at a specific video that does not exist tomorrow.
     */
    channel: varchar("channel", { length: 120 }).notNull(),
    title: varchar("title", { length: 160 }),
    /**
     * `public` | `registered`. Who can watch it FROM THE WEB.
     *
     * **`public` by default**: the stream is the tournament's showcase, and asking for
     * an account to watch it closes the door precisely on those who are not yet part of the
     * community.
     *
     * What this setting DOES and does NOT do: it blocks Kitsuden's page and embed,
     * but the Twitch channel is still public ON Twitch. It is a door,
     * not a lock.
     */
    viewerAccess: varchar("viewer_access", { length: 20 }).default("public").notNull(),
    /** The main channel. The others are secondary stages. */
    isPrimary: boolean("is_primary").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("streams_tournament_idx").on(t.tournamentId)]
);

// ═══════════════════════════════════════════════
// Phases Table
// ═══════════════════════════════════════════════

/** Format of a phase. Same vocabulary as the tournament's. */
export const phaseFormatEnum = bracketFormatEnum;

/**
 * A phase of a tournament: pools, top 8, regular league.
 *
 * The ORDER is the sequence. The phase owns its sets; the tournament remains
 * the owner of its census of participants, which is not duplicated per phase.
 */
export const phases = pgTable(
  "esports_phases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .references(() => tournaments.id, { onDelete: "cascade" })
      .notNull(),

    /** 1-based. The order IS the sequence. */
    order: integer("order").notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    format: bracketFormatEnum("format").default("double_elimination").notNull(),

    /** Parallel groups. >1 are pools played at the same time. */
    groups: integer("groups").default(1).notNull(),
    /**
     * How many advance PER GROUP, not in total.
     *
     * It is how it is announced and how it is played ("the top two of each pool"), and
     * it spares the TO from dividing in their head when the pools do not all
     * come out the same size.
     */
    advancesPerGroup: integer("advances_per_group").default(1).notNull(),

    status: varchar("status", { length: 20 }).default("pending").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("phases_order_unique").on(t.tournamentId, t.order)]
);

// ═══════════════════════════════════════════════
// Phase Entries Table
// ═══════════════════════════════════════════════

/**
 * Who enters a phase, in which group and with which seed.
 *
 * It is the ONLY thing duplicated per phase, and it is just three numbers: the player
 * remains the same row of `tournament_participants` in pools and in top 8,
 * so their history is not split in two.
 */
export const phaseEntries = pgTable(
  "esports_phase_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phaseId: uuid("phase_id")
      .references(() => phases.id, { onDelete: "cascade" })
      .notNull(),
    participantId: uuid("participant_id")
      .references(() => tournamentParticipants.id, { onDelete: "cascade" })
      .notNull(),

    /** Group within the phase, 1-based. Always 1 if the phase has no pools. */
    group: integer("group").default(1).notNull(),
    /** Seed WITHIN its group. */
    seed: integer("seed").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("phase_entries_unique").on(t.phaseId, t.participantId)]
);

// ═══════════════════════════════════════════════
// Relations
// ═══════════════════════════════════════════════

export const esportsPlayersRelations = relations(players, ({ many }) => ({
  teams: many(playersToTeams),
}));

export const esportsTeamsRelations = relations(teams, ({ one, many }) => ({
  captain: one(players, { fields: [teams.captainId], references: [players.id] }),
  members: many(playersToTeams),
}));

export const esportsPlayersToTeamsRelations = relations(playersToTeams, ({ one }) => ({
  player: one(players, { fields: [playersToTeams.playerId], references: [players.id] }),
  team: one(teams, { fields: [playersToTeams.teamId], references: [teams.id] }),
}));

export const esportsTournamentsRelations = relations(tournaments, ({ many }) => ({
  participants: many(tournamentParticipants),
  matches: many(matches),
}));

export const esportsTournamentParticipantsRelations = relations(
  tournamentParticipants,
  ({ one }) => ({
    tournament: one(tournaments, {
      fields: [tournamentParticipants.tournamentId],
      references: [tournaments.id],
    }),
    player: one(players, { fields: [tournamentParticipants.playerId], references: [players.id] }),
    team: one(teams, { fields: [tournamentParticipants.teamId], references: [teams.id] }),
  })
);

export const esportsMatchesRelations = relations(matches, ({ one }) => ({
  tournament: one(tournaments, { fields: [matches.tournamentId], references: [tournaments.id] }),
  participant1: one(tournamentParticipants, {
    fields: [matches.participant1Id],
    references: [tournamentParticipants.id],
  }),
  participant2: one(tournamentParticipants, {
    fields: [matches.participant2Id],
    references: [tournamentParticipants.id],
  }),
  winner: one(tournamentParticipants, {
    fields: [matches.winnerId],
    references: [tournamentParticipants.id],
  }),
  nextMatch: one(matches, { fields: [matches.nextMatchId], references: [matches.id] }),
}));

/**
 * Snapshot of the prize pool.
 *
 * Storing only the current figure wastes the one interesting thing about a
 * crowdfunding pot: **that it rises**. A still number is a data point; the same number
 * rising is what makes people contribute.
 */
export const prizePoolSnapshots = pgTable(
  "esports_prize_pool_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .references(() => tournaments.id, { onDelete: "cascade" })
      .notNull(),
    /** In CENTS, integer: it is real money and appears on screen. */
    cents: integer("cents").notNull(),
    currency: varchar("currency", { length: 3 }).default("USD").notNull(),
    contributors: integer("contributors"),
    /**
     * Where it came from. Today always `matcherino`, but a pot can come from a
     * spreadsheet or from kon-payments, and mixing origins without distinguishing them
     * would make the curve unreadable.
     */
    source: varchar("source", { length: 20 }).default("matcherino").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("prize_snapshots_tournament_idx").on(t.tournamentId, t.capturedAt)]
);

/**
 * Evidence submitted with a result report.
 *
 * It hangs from the REPORT and not the set: each side contributes its own, and hanging it from the set
 * would lose who submitted what — which is exactly what the TO has to compare.
 */
export const reportEvidence = pgTable(
  "esports_report_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .references(() => matchReports.id, { onDelete: "cascade" })
      .notNull(),
    /**
     * Uploaded through kon-media. It is OURS: it cannot be changed later, it does not leak
     * the IP of whoever views it, and it is still there in three months.
     */
    mediaId: uuid("media_id"),
    /**
     * Pasted by the player (imgur, gyazo). It is what people actually do,
     * so it is allowed — but it is THIRD-PARTY CONTENT: it can change, expire or
     * log whoever opens it. It is stored apart from `mediaId` precisely
     * so the TO knows which one to trust.
     */
    url: text("url"),
    caption: varchar("caption", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("report_evidence_report_idx").on(t.reportId)]
);

// ═══════════════════════════════════════════════
// Scene matches — those of OTHER teams
// ═══════════════════════════════════════════════

/**
 * The professional scene, which is NOT our tournaments
 * ============================================================================
 *
 * `esports_matches` are the sets of one of OUR tournaments: they hang from a bracket,
 * have a round and participants registered here. What the esports blog shows is
 * something else —"today G2 plays Fnatic"— and has nothing to do with it:
 * there is no bracket, no registration, and the teams do not exist in our database.
 *
 * Putting them in the same table would have required inventing a tournament and two
 * participants for each LEC match. They go separately, and that is why this table
 * DOES have a time: it is the first thing you look at in a match calendar.
 *
 * ── WHERE THEY COME FROM ───────────────────────────────────────────────────
 *
 * From anywhere: by hand from the panel, or from a licensed source. `source`
 * and `external_id` store where each row came from, and their unique index makes
 * re-importing UPDATE instead of duplicate. Without a declared source, it is understood
 * that a person wrote it.
 */
export const proMatches = pgTable(
  "esports_pro_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * The game from our catalog, if we have it. Nullable on purpose: League
     * of Legends or CS2 may not be in the site's catalog and the match is
     * shown anyway with `game_name`.
     */
    gameId: uuid("game_id"),
    gameName: varchar("game_name", { length: 120 }).notNull(),

    /** The league or event: "LEC Summer 2026", "IEM Katowice". */
    event: varchar("event", { length: 200 }),

    teamOne: varchar("team_one", { length: 160 }).notNull(),
    teamTwo: varchar("team_two", { length: 160 }).notNull(),
    /** Crests LINKED to their source; no one's images are copied here. */
    logoOne: text("logo_one"),
    logoTwo: text("logo_two"),

    /** When it is played. It is the difference from a tournament set, which only has a round. */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    status: varchar("status", { length: 20 }).notNull().default("scheduled"),
    scoreOne: integer("score_one"),
    scoreTwo: integer("score_two"),
    /** 1, 3, 5… `null` si no se sabe. */
    bestOf: integer("best_of"),

    streamUrl: text("stream_url"),

    /** Where the row came from. Empty = a person wrote it in the panel. */
    source: varchar("source", { length: 60 }),
    externalId: varchar("external_id", { length: 120 }),
    externalUrl: text("external_url"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /** Re-importing updates and does not duplicate; hand-entered rows carry no source. */
    uniqueIndex("esports_pro_matches_source_idx")
      .on(t.source, t.externalId)
      .where(isNotNull(t.externalId)),
    /** The panel's query: "what's coming", by time. */
    index("esports_pro_matches_agenda_idx").on(t.status, t.scheduledAt),
  ]
);

export type ProMatch = typeof proMatches.$inferSelect;
export type NewProMatch = typeof proMatches.$inferInsert;
