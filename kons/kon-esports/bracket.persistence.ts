/**
 * Bracket persistence — bridge between the pure engine and the tables
 * ============================================================================
 *
 * `bracket.ts` is pure arithmetic and is exhaustively tested. This file is
 * the ONLY translation between that engine and Postgres: generate = dump,
 * report = reread, apply and dump again.
 *
 * It lives outside the routes because it has two consumers, not one: the
 * TO's panel (`POST /tournament/:id/report`) and the broadcast scoreboard,
 * which closes the set from the overlay. If each reimplemented bracket
 * advancement, double elimination would have two truths and it would only
 * show live.
 */

import {
  createBracket,
  isComplete,
  reportResult,
  type Bracket,
  type BracketMatch,
} from "./bracket";
import type { EsportsDb } from "./esports.db";
import { tournaments, tournamentParticipants, matches } from "./esports.schema";

/**
 * The kon's drizzle executor. It is received as a parameter —and the host's
 * `db` is not imported— so queries travel inside the transaction and the RLS
 * context of the current request.
 *
 * It is the kon's REAL type, not a tailor-made structural signature: that way
 * the queries below keep schema inference. The broadcast bridge calls through
 * the kon context, whose `db.instance` is not narrowed, so it does not need
 * to know this type.
 */
type Executor = EsportsDb;

export type TournamentRow = typeof tournaments.$inferSelect;

/**
 * Scope of a bracket: the tournament, and optionally a phase and a group
 * within it.
 *
 * `phaseId: null` means "the tournament does not use phases" and filters by
 * `phase_id IS NULL` — which is what makes a single-phase tournament keep
 * working exactly as before phases existed.
 */
export interface BracketScope {
  phaseId?: string | null;
  /** Participants of this bracket. Without this, all of the tournament's are taken. */
  participantIds?: string[];
}

/** SQL condition of the scope. Centralized: it is easy to forget the `IS NULL`. */
async function scopeWhere(tournamentId: string, phaseId: string | null | undefined) {
  const { and, eq, isNull } = await import("drizzle-orm");
  return and(
    eq(matches.tournamentId, tournamentId),
    phaseId ? eq(matches.phaseId, phaseId) : isNull(matches.phaseId)
  );
}

export interface LoadedBracket {
  bracket: Bracket;
  /** `W2M1` → row uuid. It is the reconciliation key. */
  idByBracketId: Map<string, string>;
}

/** Engine state → table enum. */
export function toDbStatus(s: BracketMatch["status"]) {
  switch (s) {
    case "done":
      return "Completed" as const;
    case "ready":
      return "Ready" as const;
    case "bye":
      return "Bye" as const;
    case "void":
      return "Void" as const;
    default:
      return "Pending" as const;
  }
}

/** Dumps an engine bracket into the kon's tables. */
export async function persistBracket(
  db: Executor,
  tournamentId: string,
  bracket: Bracket,
  idByBracketId: Map<string, string>,
  scope: BracketScope = {}
): Promise<void> {
  const rows = bracket.matches.map((m) => ({
    id: idByBracketId.get(m.id)!,
    tournamentId,
    phaseId: scope.phaseId ?? null,
    round: m.round,
    matchOrder: m.order,
    bracketMatchId: m.id,
    bracketSide: m.side,
    participant1Id: m.participants[0],
    participant2Id: m.participants[1],
    winnerId: m.winnerId,
    dqParticipantId: m.dqId ?? null,
    status: toDbStatus(m.status),
    nextMatchId: m.winnerTo ? (idByBracketId.get(m.winnerTo.matchId) ?? null) : null,
    loserNextMatchId: m.loserTo ? (idByBracketId.get(m.loserTo.matchId) ?? null) : null,
    updatedAt: new Date(),
  }));

  // ONLY the scope is deleted: with parallel pools, a per-tournament delete would
  // take the other pools' brackets with it.
  await db.delete(matches).where(await scopeWhere(tournamentId, scope.phaseId));
  if (rows.length > 0) {
    await db.insert(matches).values(rows as (typeof matches.$inferInsert)[]);
  }
}

/**
 * Rebuilds the engine bracket from the persisted rows.
 *
 * The STRUCTURE is regenerated with the same seed (that is why it is stored)
 * and then the results are reapplied in order. Rebuilding instead of
 * serializing the whole bracket avoids having two representations that could
 * diverge.
 */
export async function loadBracket(
  db: Executor,
  tournament: TournamentRow,
  scope: BracketScope = {}
): Promise<LoadedBracket> {
  const { eq } = await import("drizzle-orm");

  const parts = await db
    .select()
    .from(tournamentParticipants)
    .where(eq(tournamentParticipants.tournamentId, tournament.id));

  // With phases, the bracket is only for those who entered THIS phase and group.
  const scoped = scope.participantIds
    ? parts.filter((p: { id: string }) => scope.participantIds!.includes(p.id))
    : parts;

  const ordered = [...scoped].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));

  // Neither round robin nor Swiss has a bracket: asking them for one is a
  // caller error, and failing clearly here avoids rebuilding a phantom
  // elimination over games that are not elimination games.
  if (tournament.bracketFormat === "round_robin") {
    throw new Error("[bracket] this tournament is round robin; use roundrobin.persistence");
  }
  if (tournament.bracketFormat === "swiss") {
    throw new Error("[bracket] this tournament is Swiss; use swiss.persistence");
  }

  let bracket = createBracket(
    ordered.map((p) => ({ id: p.id, name: p.id, rating: p.rating ?? undefined })),
    {
      format: tournament.bracketFormat,
      // They already come seeded from the DB: do not draw again.
      seeding: "as_entered",
      shuffleSeed: tournament.shuffleSeed ?? 1,
    }
  );

  const rows = await db
    .select()
    .from(matches)
    .where(await scopeWhere(tournament.id, scope.phaseId));

  const idByBracketId = new Map<string, string>();
  for (const r of rows) {
    if (r.bracketMatchId) idByBracketId.set(r.bracketMatchId, r.id);
  }
  for (const m of bracket.matches) {
    if (!idByBracketId.has(m.id)) idByBracketId.set(m.id, crypto.randomUUID());
  }

  // Reapply the already reported results, round by round, so the engine
  // receives them in an order consistent with the bracket's progression.
  const reported = rows
    .filter((r) => r.status === "Completed" && r.winnerId && r.bracketMatchId)
    .sort((a, b) => a.round - b.round || a.matchOrder - b.matchOrder);

  for (const r of reported) {
    try {
      bracket = reportResult(bracket, r.bracketMatchId!, {
        winnerId: r.winnerId!,
        dqId: r.dqParticipantId ?? undefined,
      });
    } catch {
      // A set that no longer fits (bracket regenerated by hand) is ignored instead of
      // taking the request down: the TO will see the bracket and can fix it.
    }
  }

  return { bracket, idByBracketId };
}

export interface ApplyResultOptions {
  winnerId: string;
  dqId?: string;
  eliminate?: boolean;
  /** Informational score of the set. The winner was already decided by the caller. */
  scores?: { participant1: number; participant2: number };
}

export interface AppliedResult {
  bracket: Bracket;
  idByBracketId: Map<string, string>;
  championId: string | null;
  complete: boolean;
}

/**
 * Applies a result and advances the bracket. It is the complete operation:
 * reread, apply, dump, mark eliminated and crown the champion if due.
 *
 * It throws if the engine rejects the result (nonexistent set, already
 * closed, winner who does not play that set). The caller translates that into
 * its response —the panel into a 400, the scoreboard into a message for the
 * operator—; swallowing it here would leave the TO believing the bracket
 * advanced when it did not.
 */
export async function applyResult(
  db: Executor,
  tournament: TournamentRow,
  bracketMatchId: string,
  options: ApplyResultOptions,
  scope: BracketScope = {}
): Promise<AppliedResult> {
  const { eq } = await import("drizzle-orm");
  const { bracket, idByBracketId } = await loadBracket(db, tournament, scope);

  const next = reportResult(bracket, bracketMatchId, {
    winnerId: options.winnerId,
    dqId: options.dqId,
    eliminate: options.eliminate,
  });

  await persistBracket(db, tournament.id, next, idByBracketId, scope);

  for (const pid of next.eliminated) {
    await db
      .update(tournamentParticipants)
      .set({ eliminated: true })
      .where(eq(tournamentParticipants.id, pid));
  }

  // The TOURNAMENT champion is only crowned by a bracket without a phase: in a sequence,
  // winning the pools is not winning the tournament, and writing it here would leave the tournament
  // closed with the top 8 unplayed.
  if (next.championId && !scope.phaseId) {
    await db
      .update(tournaments)
      .set({ status: "Completed", championId: next.championId, updatedAt: new Date() })
      .where(eq(tournaments.id, tournament.id));
  }

  // The score is saved AFTER dumping the bracket: `persistBracket` rewrites
  // the rows, so writing it earlier would lose it.
  if (options.scores) {
    const rowId = idByBracketId.get(bracketMatchId);
    if (rowId) {
      await db
        .update(matches)
        .set({
          participant1Score: options.scores.participant1,
          participant2Score: options.scores.participant2,
        })
        .where(eq(matches.id, rowId));
    }
  }

  return {
    bracket: next,
    idByBracketId,
    championId: next.championId,
    complete: isComplete(next),
  };
}
