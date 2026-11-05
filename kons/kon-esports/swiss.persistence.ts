/**
 * Swiss persistence
 * ============================================================================
 *
 * It reuses `esports_matches`, like round robin: a Swiss game
 * is a game, with its round in `round` and its table in `matchOrder`. The engine
 * id (`S3M2`) goes in `bracketMatchId`, the same reconciliation key used by
 * elimination and groups — so Broadcast and the TO panel
 * reference all three formats with the same field.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DIFFERENCE FROM THE OTHER FORMATS: IT IS GENERATED ROUND BY ROUND
 *
 * A bracket is dumped whole at the start. A Swiss one CANNOT be: round 3
 * depends on who won in round 2. That is why there is no "generate the tournament" here, there is
 * "pair the next round", and the state we start from is REBUILT
 * by reading the games already played.
 *
 * Rebuilding instead of carrying a stored accumulator is deliberate: a
 * points counter updated by hand goes out of sync as soon as the TO
 * corrects a result, and then the standings lie without anything failing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { EsportsDb } from "./esports.db";
import { matches, tournamentParticipants } from "./esports.schema";
import {
  isSwissComplete,
  pairSwissRound,
  recommendedRounds,
  swissStandings,
  SwissError,
  type SwissPairing,
  type SwissPlayer,
  type SwissStanding,
} from "./swiss";

/** Only Swiss sets have a `bracketMatchId` of this shape. */
const SWISS_ID = /^S(\d+)M(\d+)$/;

export interface SwissScope {
  phaseId?: string | null;
}

/**
 * Rebuilds the players from the games already played.
 *
 * Everything —points, opponents, byes, games— comes from the `esports_matches` rows.
 * There is no stored total that could go stale.
 */
export async function loadSwissPlayers(
  db: EsportsDb,
  tournamentId: string,
  scope: SwissScope = {}
): Promise<SwissPlayer[]> {
  const { and, eq, isNull } = await import("drizzle-orm");

  const participants = await db
    .select({
      id: tournamentParticipants.id,
      seed: tournamentParticipants.seed,
      droppedAt: tournamentParticipants.droppedAt,
      eliminated: tournamentParticipants.eliminated,
    })
    .from(tournamentParticipants)
    .where(eq(tournamentParticipants.tournamentId, tournamentId));

  const rows = await db
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.tournamentId, tournamentId),
        scope.phaseId ? eq(matches.phaseId, scope.phaseId) : isNull(matches.phaseId)
      )
    );

  const byId = new Map<string, SwissPlayer>(
    participants.map((p) => [
      p.id,
      {
        participantId: p.id,
        results: [],
        // Withdrawn and disqualified are the same thing for the purposes of
        // pairing: they are not given an opponent again. What does NOT change is that their
        // results still count toward the others' tiebreakers.
        dropped: p.droppedAt !== null || p.eliminated,
        seed: p.seed,
      },
    ])
  );

  // By round and table: results have to be in the order in which they were
  // played, or "your first opponent" stops meaning anything.
  const swissRows = rows
    .filter((row) => row.bracketMatchId && SWISS_ID.test(row.bracketMatchId))
    .sort((a, b) => a.round - b.round || a.matchOrder - b.matchOrder);

  for (const row of swissRows) {
    // Without a winner the game is in progress: it does not contribute to the record yet.
    if (!row.winnerId) continue;

    const [p1, p2] = [row.participant1Id, row.participant2Id];

    // Bye: one side empty and the other the winner.
    if (p1 && !p2) {
      byId.get(p1)?.results.push({ opponentId: null, outcome: "win" });
      continue;
    }
    if (!p1 || !p2) continue;

    const push = (me: string, rival: string, won: number, lost: number) => {
      byId.get(me)?.results.push({
        opponentId: rival,
        outcome: row.winnerId === me ? "win" : "loss",
        gamesWon: won,
        gamesLost: lost,
      });
    };

    push(p1, p2, row.participant1Score, row.participant2Score);
    push(p2, p1, row.participant2Score, row.participant1Score);
  }

  return [...byId.values()];
}

/** The highest round already generated. 0 = not started yet. */
export function lastRoundOf(players: SwissPlayer[]): number {
  return players.reduce((max, p) => Math.max(max, p.results.length), 0);
}

export interface GeneratedSwissRound {
  round: number;
  pairings: SwissPairing[];
  warnings: string[];
}

/**
 * Pairs and DUMPS the next round.
 *
 * It refuses if games of the previous round remain without a result. It is not a technical
 * limitation: pairing with half the results produces matchups that have to
 * be undone, and undoing an already published round is worse than waiting for the
 * two that are missing.
 */
export async function generateSwissRound(
  db: EsportsDb,
  tournamentId: string,
  totalRounds: number,
  scope: SwissScope = {}
): Promise<GeneratedSwissRound> {
  const { and, eq, isNull } = await import("drizzle-orm");

  const players = await loadSwissPlayers(db, tournamentId, scope);
  const previousRound = lastRoundOf(players);

  if (totalRounds > 0 && previousRound >= totalRounds) {
    throw new SwissError(`The tournament still has ${totalRounds} rounds.`);
  }

  const pending = await db
    .select({ id: matches.id, bracketMatchId: matches.bracketMatchId })
    .from(matches)
    .where(
      and(
        eq(matches.tournamentId, tournamentId),
        scope.phaseId ? eq(matches.phaseId, scope.phaseId) : isNull(matches.phaseId),
        isNull(matches.winnerId)
      )
    );

  const openSwiss = pending.filter((m) => m.bracketMatchId && SWISS_ID.test(m.bracketMatchId));
  if (openSwiss.length > 0) {
    throw new SwissError(
      `There are still ${openSwiss.length} game(s) without a result. Pairing while the round is ` +
        "half done forces undoing already published matchups."
    );
  }

  const round = previousRound + 1;
  const { pairings, warnings } = pairSwissRound(players, round);

  await db.insert(matches).values(
    pairings.map((pairing) => ({
      tournamentId,
      phaseId: scope.phaseId ?? null,
      round: pairing.round,
      matchOrder: pairing.table,
      bracketMatchId: pairing.id,
      participant1Id: pairing.participant1,
      participant2Id: pairing.participant2,
      // The bye is stored ALREADY RESOLVED: it is not a game that anyone is going to
      // play, and leaving it pending would block the next round forever.
      winnerId: pairing.participant2 === null ? pairing.participant1 : null,
      status: pairing.participant2 === null ? ("Completed" as const) : ("Pending" as const),
    }))
  );

  return { round, pairings, warnings };
}

export interface SwissState {
  round: number;
  totalRounds: number;
  complete: boolean;
  standings: SwissStanding[];
}

/** Standings and where the tournament stands. */
export async function loadSwissState(
  db: EsportsDb,
  tournamentId: string,
  configuredRounds: number | null,
  scope: SwissScope = {}
): Promise<SwissState> {
  const players = await loadSwissPlayers(db, tournamentId, scope);
  const totalRounds = configuredRounds ?? recommendedRounds(players.length);

  return {
    round: lastRoundOf(players),
    totalRounds,
    complete: isSwissComplete(players, totalRounds),
    standings: swissStandings(players),
  };
}
