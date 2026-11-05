/**
 * Neutral import model
 * ============================================================================
 *
 * Every importer —start.gg, Matcherino, and whatever comes next— produces THIS shape, and
 * a single function writes it into Kitsuden.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY AN INTERMEDIATE LAYER AND NOT WRITING DIRECTLY
 *
 * The obvious thing is for each importer to insert into the database and be done. What happens then
 * is that the hard part —matching existing players, not duplicating on
 * re-import, deciding what to do with a participant who is no longer there— gets written
 * once PER PLATFORM, and by the second they already diverge. The easy part is talking
 * to the other API; the hard part is writing without breaking anything.
 *
 * With this model, adding Challonge or Toornament is one file that returns
 * `ImportedTournament`. Nothing more.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Platforms that can be imported from.
 *
 * Each comes in through the door it leaves open: start.gg through its documented API, Matcherino
 * through its internal endpoint, and Battlefy by FILE — its API answers
 * "Direct API access is not permitted", and that is not sidestepped.
 */
export type ImportSource = "startgg" | "matcherino" | "battlefy";

export class ImportError extends Error {
  constructor(
    message: string,
    /** `true` if retrying later may work (network, rate limit). */
    readonly retryable = false
  ) {
    super(message);
  }
}

/**
 * A participant as published by the source platform.
 *
 * `externalId` is MANDATORY. It is the only thing that survives a rename and the
 * thing that makes re-importing update instead of duplicate; an importer that cannot
 * provide one should not import.
 */
export interface ImportedParticipant {
  externalId: string;
  /** Display name: the bracket gamertag, not the legal name. */
  name: string;
  /** ISO 3166-1 alpha-2 in uppercase, if the platform publishes it. */
  country?: string | null;
  avatarUrl?: string | null;
  /** Source seeding (1 = best), if it came seeded. */
  seed?: number | null;
  /**
   * Members, if it is a team. Empty or absent = individual participant.
   *
   * The distinction is not deduced from the tournament format: in Matcherino a single
   * event accepts individual registration AND team registration.
   */
  members?: Array<{ externalId: string; name: string }>;
}

/** A set already played on the source platform. */
export interface ImportedSet {
  externalId: string;
  /** Both sides, by participant `externalId`. `null` = empty slot. */
  participants: [string | null, string | null];
  /** `externalId` of the winner, or `null` if it has not been played yet. */
  winnerExternalId: string | null;
  /** Round text exactly as the source gives it ("Winners Semi-Final"). */
  roundLabel?: string | null;
  scores?: [number, number] | null;
}

/**
 * Prize pool.
 *
 * In cents and integer. See migration 0006: it is money and appears on screen.
 */
export interface ImportedPrizePool {
  cents: number;
  currency: string;
  /** How many people have contributed, if the platform publishes it. */
  contributors?: number | null;
}

export interface ImportedTournament {
  source: ImportSource;
  externalId: string;
  /** Public URL of the event. It is what a TO recognizes; it is stored as is. */
  url: string | null;
  title: string;
  /** Name of the game AS GIVEN BY THE SOURCE. Matching it with `kon-games` is another step. */
  gameName: string | null;
  startsAt: string | null;
  /** `true` if teams compete. */
  isTeamEvent: boolean;
  participants: ImportedParticipant[];
  /** Empty if the bracket has not started yet, or if the source does not publish it. */
  sets: ImportedSet[];
  prizePool: ImportedPrizePool | null;
  /**
   * What the importer could NOT bring, in plain language.
   *
   * It goes in the model and not in a log because it is what has to be shown to the TO
   * BEFORE confirming: an importer that stays quiet about what it did not bring produces a
   * silently incomplete tournament, and that is discovered on the day of the event.
   */
  warnings: string[];
}

/** What an importer understands: a URL, or a platform id. */
export interface ImportRequest {
  source: ImportSource;
  /** Event URL or direct identifier. */
  reference: string;
  /** Platform credential, when it requires one (start.gg does, Matcherino does not). */
  token?: string;
}
