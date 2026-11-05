/**
 * Bridge to `kon-esports`' bracket engine
 * ============================================================================
 *
 * Broadcast has the scoreboard; esports has the bracket. Without this bridge the
 * operator types the same thing twice: the names when building the set in the
 * overlay, and the result when closing it in the bracket. It is exactly the duplicated
 * work that makes a broadcast tool get abandoned.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHO RULES THE SCOREBOARD
 *
 * **Broadcast, while the set is in progress. The bracket, when it is closed.**
 *
 * The scoreboard changes many times a minute live and not all of those
 * states are results: a wrong `+1` is corrected with a `-1`. Pushing them
 * to the bracket as they happen would force reopening and re-advancing the bracket, and the
 * bracket is what people look at to know when they play.
 *
 * That is why the flow has two steps: `fromSet` brings the pairing, and
 * `report` returns the result ONCE. In between, the bracket is not touched.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * As in the players bridge, the import is DYNAMIC: Broadcast keeps
 * working without `kon-esports` (hand-written scoreboard) and gains the bracket
 * when it is enabled. Its absence is a mode of use, not a failure.
 */

import { withSavepoint } from "@kitsuden/engine";

/** One side of the pairing, as the bracket knows it. */
export interface BracketSeat {
  /** Row of `esports_tournament_participants`. It is the id `report` expects. */
  participantId: string | null;
  /** Player from `esports_players`, if the participant is an individual. */
  playerId: string | null;
  /** Name to draw. Empty if the slot has no occupant yet. */
  name: string;
  /** Falls on the losers side of the bracket. */
  losers: boolean;
}

/** Pairing ready to build a Broadcast set. */
export interface BracketPairing {
  /** Engine id: `W2M1`, `L3M2`, `GF`. */
  bracketMatchId: string;
  /** Readable round for the overlay: "Winners Semifinal". */
  round: string;
  a: BracketSeat;
  b: BracketSeat;
}

export type BracketAvailability<T> =
  | { available: true; value: T }
  | { available: true; value: null; reason: string }
  | { available: false; reason: string };

const UNAVAILABLE =
  "The kon 'kon-esports' is not enabled. Enable it to build sets from the bracket, " +
  "or create the set by hand.";

/** What this bridge needs from the esports module. */
type EsportsBracketModule = {
  tournaments: unknown;
  tournamentParticipants: unknown;
  matches: unknown;
  players: unknown;
  /**
   * Bracket advancement, as the TO panel uses it. It is reused instead of
   * reimplemented: double elimination cannot have two truths.
   */
  applyResult: (
    db: unknown,
    tournament: unknown,
    bracketMatchId: string,
    options: {
      winnerId: string;
      dqId?: string;
      eliminate?: boolean;
      scores?: { participant1: number; participant2: number };
    }
  ) => Promise<{ championId: string | null; complete: boolean }>;
} | null;

let cached: EsportsBracketModule | undefined;

/**
 * Loads the esports module only once, failure included: if the kon is not
 * installed, retrying the import on every set is not going to install it.
 */
async function loadEsports(): Promise<EsportsBracketModule> {
  if (cached !== undefined) return cached;
  try {
    const mod = (await import("@kitsuden/kon-esports")) as Record<string, unknown>;
    const required = ["tournaments", "tournamentParticipants", "matches", "players", "applyResult"];
    cached = required.every((k) => mod[k]) ? (mod as unknown as EsportsBracketModule) : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** For tests only: forgets the cached result. */
export function resetBracketCache(): void {
  cached = undefined;
}

/**
 * Readable name of a round from the engine id.
 *
 * The overlay draws this text live, so "Winners Semifinal" works and
 * "W3M1" does not. It is derived from the id and the bracket size: the highest
 * winners round is the final, the one before the semifinal, and so on backwards.
 */
export function roundLabel(bracketMatchId: string, size: number): string {
  if (bracketMatchId === "GF") return "Grand Final";
  if (bracketMatchId === "GFR") return "Grand Final Reset";

  const parsed = /^([WL])(\d+)M\d+$/.exec(bracketMatchId);
  if (!parsed) return bracketMatchId;

  const [, sideCode, roundStr] = parsed;
  const side = sideCode === "W" ? "Winners" : "Losers";
  const round = Number(roundStr);

  // Total rounds on the winners side: log2 of the bracket size.
  const winnersRounds = Math.max(1, Math.log2(size));
  // Losers runs almost twice the rounds for the same bracket.
  const totalRounds = sideCode === "W" ? winnersRounds : Math.max(1, (winnersRounds - 1) * 2);

  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return `${side} Final`;
  if (fromEnd === 1) return `${side} Semifinal`;
  if (fromEnd === 2) return `${side} Cuartos`;
  return `${side} Round ${round}`;
}

/** Minimal signature of the drizzle executor this bridge needs. */
type Selector = {
  select: () => {
    from: (t: unknown) => {
      where: (c: unknown) => { limit: (n: number) => Promise<unknown[]> } & Promise<unknown[]>;
    };
  };
};

/**
 * Brings a pairing from the bracket, ready to build the scoreboard.
 *
 * It returns the participants **with their row id**, not just the name: it is
 * what later lets the result be reported without the operator choosing
 * again from a list who won.
 */
export async function fetchPairing(
  db: Selector,
  tournamentId: string,
  bracketMatchId: string
): Promise<BracketAvailability<BracketPairing>> {
  const esports = await loadEsports();
  if (!esports) return { available: false, reason: UNAVAILABLE };
  // An id that is not a uuid is not a kon-esports tournament (and in the WHERE gives 22P02).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tournamentId)) {
    return { available: true, value: null, reason: "That tournament does not exist" };
  }

  const { eq, and } = await import("drizzle-orm");
  const matches = esports.matches as Record<string, unknown>;
  const participantsTable = esports.tournamentParticipants as Record<string, unknown>;
  const playersTable = esports.players as Record<string, unknown>;
  const tournamentsTable = esports.tournaments as Record<string, unknown>;

  const [tournament] = (await db
    .select()
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id as never, tournamentId))
    .limit(1)) as Array<{ maxParticipants?: number } | undefined>;

  if (!tournament) {
    return { available: true, value: null, reason: "That tournament does not exist" };
  }

  const rows = (await db
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.tournamentId as never, tournamentId),
        eq(matches.bracketMatchId as never, bracketMatchId)
      )
    )
    .limit(1)) as Array<
    | {
        participant1Id: string | null;
        participant2Id: string | null;
        bracketSide: string;
        status: string;
      }
    | undefined
  >;

  const row = rows[0];
  if (!row) {
    return {
      available: true,
      value: null,
      reason: `Set "${bracketMatchId}" is not in the bracket`,
    };
  }

  // A set already played or voided is not built in the overlay: the operator would be
  // broadcasting a pairing the bracket has already left behind.
  if (row.status === "Completed" || row.status === "Void") {
    return {
      available: true,
      value: null,
      reason: `Set "${bracketMatchId}" is already closed (${row.status})`,
    };
  }

  const losers = row.bracketSide === "losers";
  /**
   * The size of the GENERATED bracket, not the quota: with a quota of 8 and 4 registered
   * the engine makes a bracket of 4, and measuring by `maxParticipants` put
   * "Winners Quarterfinals" live on a semifinal (phase D, 2026-10-25). The highest
   * winners round says how many there are: 2^rounds. Without winners sets, the quota.
   */
  const ofTournament = (await db
    .select()
    .from(matches)
    .where(eq(matches.tournamentId as never, tournamentId))) as Array<{
    bracketMatchId?: string | null;
  }>;
  const winnersRoundsOf = Math.max(
    0,
    ...ofTournament.map((m) => Number(/^W(\d+)M\d+$/.exec(m.bracketMatchId ?? "")?.[1] ?? 0))
  );
  const size =
    winnersRoundsOf > 0 ? 2 ** winnersRoundsOf : nextPowerOfTwo(tournament.maxParticipants ?? 0);

  return {
    available: true,
    value: {
      bracketMatchId,
      round: roundLabel(bracketMatchId, size),
      a: await seat(db, participantsTable, playersTable, row.participant1Id, losers, eq),
      b: await seat(db, participantsTable, playersTable, row.participant2Id, losers, eq),
    },
  };
}

/** Power of two equal or greater — the real size of the bracket. */
function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Resolves a bracket slot to a scoreboard side.
 *
 * An empty slot is NOT an error: in a bracket in progress, half of the sets
 * are still waiting for the previous one to resolve. It is returned with a blank
 * name so the operator can build the graphic in advance.
 */
async function seat(
  db: Selector,
  participantsTable: Record<string, unknown>,
  playersTable: Record<string, unknown>,
  participantId: string | null,
  losers: boolean,
  eq: (a: never, b: unknown) => unknown
): Promise<BracketSeat> {
  const empty: BracketSeat = { participantId: null, playerId: null, name: "", losers };
  if (!participantId) return empty;

  const [participant] = (await db
    .select()
    .from(participantsTable)
    .where(eq(participantsTable.id as never, participantId))
    .limit(1)) as Array<{ playerId: string | null } | undefined>;

  if (!participant) return empty;
  if (!participant.playerId) {
    // Participant per team: the name is set by the operator or the teams
    // bridge. The reference is kept so the result can be reported.
    return { participantId, playerId: null, name: "", losers };
  }

  const [player] = (await db
    .select()
    .from(playersTable)
    .where(eq(playersTable.id as never, participant.playerId))
    .limit(1)) as Array<{ alias: string } | undefined>;

  return {
    participantId,
    playerId: participant.playerId,
    name: player?.alias ?? "",
    losers,
  };
}

/**
 * Closes the set against the bracket and advances it.
 *
 * It reuses `applyResult` from `kon-esports` —the same one the TO panel uses—
 * instead of reimplementing the advancement here. A bracket with two implementations of
 * double elimination ends up diverging, and it is only discovered live.
 */
export async function reportToBracket(
  db: Selector,
  tournamentId: string,
  bracketMatchId: string,
  options: {
    winnerParticipantId: string;
    dqParticipantId?: string;
    eliminate?: boolean;
    scores: { participant1: number; participant2: number };
  }
): Promise<BracketAvailability<{ championId: string | null; complete: boolean }>> {
  const esports = await loadEsports();
  if (!esports) return { available: false, reason: UNAVAILABLE };

  const { eq } = await import("drizzle-orm");
  const tournamentsTable = esports.tournaments as Record<string, unknown>;

  const [tournament] = (await db
    .select()
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id as never, tournamentId))
    .limit(1)) as Array<Record<string, unknown> | undefined>;

  if (!tournament) return { available: true, value: null, reason: "That tournament no longer exists" };

  try {
    // In a SAVEPOINT: if the engine rejects the result halfway through writing (or
    // because of a SQL error), only its own work is undone and the request's
    // transaction stays alive for the scoreboard, which does not fall over because of this (below).
    const result = await withSavepoint(() =>
      esports.applyResult(db, tournament, bracketMatchId, {
        winnerId: options.winnerParticipantId,
        dqId: options.dqParticipantId,
        eliminate: options.eliminate,
        scores: options.scores,
      })
    );
    return { available: true, value: result };
  } catch (err) {
    // The engine rejects the result (set already closed, winner who does not play that
    // set). It is information for the operator, not a 500: the scoreboard stays alive.
    return {
      available: true,
      value: null,
      reason: err instanceof Error ? err.message : "The bracket rejected the result",
    };
  }
}

/**
 * Checks that a scoreboard set can be reported to the bracket.
 *
 * It is validated BEFORE touching the bracket because advancing a bracket is hard to
 * undo: if the set does not have both participants linked, the result
 * is not attributable and it is better to say so than to guess.
 */
export function checkReportable(sides: {
  a: { participantId?: string | null; score: number };
  b: { participantId?: string | null; score: number };
  /**
   * How many games must be won to close the set.
   *
   * ── WHY IT IS MANDATORY ───────────────────────────────────────────────────
   *
   * Without it, this function accepted ANY uneven score: a Bo5 at 1-0 was
   * reported to the bracket and advanced whoever was winning the first game. The
   * MOBA bridge did check it —"a series is only reported when it has
   * ENDED"— and when unifying the two kons it was discovered that the fighting one did not.
   *
   * It goes as a parameter and not as optional with a default value on purpose: a
   * default would turn "the caller forgot" into "it is not checked", which is
   * exactly how a safeguard gets lost when refactoring.
   */
  firstTo: number;
}): { ok: true; winner: "a" | "b" } | { ok: false; reason: string } {
  if (!sides.a.participantId || !sides.b.participantId) {
    return {
      ok: false,
      reason:
        "This set is not linked to the bracket on both sides. Build it with /matches/from-set " +
        "so the result can be reported.",
    };
  }
  if (sides.a.score === sides.b.score) {
    return { ok: false, reason: "The set is tied: there is no winner to report" };
  }

  const meta = Math.max(1, sides.firstTo);
  const major = Math.max(sides.a.score, sides.b.score);
  if (major < meta) {
    return {
      ok: false,
      reason:
        `The set is not over: it stands at ${sides.a.score}–${sides.b.score} and a player needs ` +
        `to reach ${meta}. Reporting it now would advance the bracket with whoever is ahead.`,
    };
  }

  return { ok: true, winner: sides.a.score > sides.b.score ? "a" : "b" };
}
