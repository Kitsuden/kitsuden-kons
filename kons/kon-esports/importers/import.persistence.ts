/**
 * Writing an import
 * ============================================================================
 *
 * Takes an `ImportedTournament` —wherever it comes from— and leaves it in Kitsuden.
 * Everything specific to each platform is already behind us; here is only the hard
 * part, which is writing without breaking what was already there.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO RULES THAT OVERRIDE THE REST
 *
 * 1. **Idempotent.** Re-importing is NORMAL, not the exception: five
 *    registrations come in late and the TO runs it again. Matching goes by
 *    `(source, externalId)`, never by name — a rename cannot create
 *    a new player, and two people with the same gamertag on different
 *    platforms cannot be merged into one.
 *
 * 2. **Never deletes.** Someone who withdrew at the source is marked
 *    `eliminated`, not removed: if they already played sets, deleting them would leave the bracket
 *    pointing at a nonexistent participant. It is the same verb check-in uses
 *    for a DQ, and on purpose: the TO already knows what it means.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SETS are not written here. A half-imported bracket is worse than none:
 * Kitsuden generates its own with its own engine from the imported seeding,
 * so advancement and tiebreakers remain a single piece. The source's sets
 * travel in the model so they can be SHOWN in the preview.
 */

import type { EsportsDb } from "../esports.db.js";
import { players, teams, tournaments, tournamentParticipants } from "../esports.schema.js";

import type { ImportedParticipant, ImportedTournament } from "./import.types.js";

export interface ImportPlan {
  /** Participants that would enter as new. */
  toCreate: ImportedParticipant[];
  /** Already existing by `(source, externalId)`: name and seeding are updated. */
  toUpdate: ImportedParticipant[];
  /**
   * Registered in Kitsuden who are NO LONGER in the source.
   *
   * They are listed separately and not touched without confirmation: it may be a real
   * withdrawal, or the TO may have previously imported from another platform.
   */
  missing: Array<{ participantId: string; name: string }>;
  prizePool: ImportedTournament["prizePool"];
  warnings: string[];
  /** Sets the source already has played. Informational: they are not written. */
  playedSets: number;
}

export interface ApplyOptions {
  /**
   * What to do with those no longer in the source. By default, NOTHING.
   *
   * `eliminate` sets `eliminated: true` (the same mark as the check-in
   * DQ) and does not delete the row: if that person already played, deleting it would leave
   * sets pointing at a participant that does not exist.
   */
  onMissing?: "ignore" | "eliminate";
}

/**
 * Computes what the import would do, WITHOUT touching anything.
 *
 * It is the half that makes an importer get used: showing "47 enter, 3 are
 * updated, 2 are no longer there" before writing. Without this, importing onto a
 * tournament with registrations already loaded is an act of faith.
 */
export async function planImport(
  db: EsportsDb,
  tournamentId: string,
  imported: ImportedTournament
): Promise<ImportPlan> {
  const { and, eq, inArray, isNotNull } = await import("drizzle-orm");

  const table = imported.isTeamEvent ? teams : players;
  const externalIds = imported.participants.map((p) => p.externalId);

  const existing = externalIds.length
    ? await db
        .select({ id: table.id, externalId: table.externalId })
        .from(table)
        .where(
          and(eq(table.externalSource, imported.source), inArray(table.externalId, externalIds))
        )
    : [];

  const knownExternal = new Set(existing.map((row) => row.externalId));

  const toCreate: ImportedParticipant[] = [];
  const toUpdate: ImportedParticipant[] = [];
  for (const participant of imported.participants) {
    (knownExternal.has(participant.externalId) ? toUpdate : toCreate).push(participant);
  }

  // Those registered here who no longer come from the source. They are resolved
  // against the SAME platform: if a participant came in via Matcherino, their
  // absence from a start.gg import does not mean they left.
  const idColumn = imported.isTeamEvent
    ? tournamentParticipants.teamId
    : tournamentParticipants.playerId;
  const registered = await db
    .select({
      participantId: tournamentParticipants.id,
      externalId: table.externalId,
      name: imported.isTeamEvent ? teams.name : players.alias,
    })
    .from(tournamentParticipants)
    .innerJoin(table, eq(idColumn, table.id))
    .where(
      and(
        eq(tournamentParticipants.tournamentId, tournamentId),
        eq(table.externalSource, imported.source),
        isNotNull(idColumn)
      )
    );

  const incoming = new Set(externalIds);
  const missing = registered
    .filter((row) => row.externalId && !incoming.has(row.externalId))
    .map((row) => ({ participantId: row.participantId, name: row.name }));

  return {
    toCreate,
    toUpdate,
    missing,
    prizePool: imported.prizePool,
    warnings: imported.warnings,
    playedSets: imported.sets.filter((s) => s.winnerExternalId !== null).length,
  };
}

export interface ImportOutcome {
  created: number;
  updated: number;
  eliminated: number;
  /** Already registered before: left as they were. */
  alreadyRegistered: number;
}

/**
 * Writes the import.
 *
 * It runs in ONE transaction: halfway through, a tournament with the players
 * created but not registered is a state nobody knows how to interpret —not even the
 * TO, who sees people in the database but not in the bracket— and fixing it by hand is
 * worse than repeating the whole import.
 */
export async function applyImport(
  db: EsportsDb,
  tournamentId: string,
  imported: ImportedTournament,
  options: ApplyOptions = {}
): Promise<ImportOutcome> {
  const { and, eq, inArray } = await import("drizzle-orm");
  const plan = await planImport(db, tournamentId, imported);

  const outcome: ImportOutcome = {
    created: 0,
    updated: 0,
    eliminated: 0,
    alreadyRegistered: 0,
  };

  await db.transaction(async (tx: EsportsDb) => {
    const table = imported.isTeamEvent ? teams : players;

    /**
     * Creation of an entity.
     *
     * Both branches are written out in full instead of composing an object of
     * variable columns: `players` and `teams` do NOT have the same columns, and
     * a mixed literal stops being checked against either — which
     * is exactly when an `alias` ends up inserted into a table
     * that expects `name`.
     */
    const createEntity = async (
      participant: ImportedParticipant
    ): Promise<"created" | "adopted" | null> => {
      // `onConflictDoNothing` on the alias/name index: someone with that
      // gamertag may already exist WITHOUT an external origin (created by hand in a
      // previous tournament). Blowing up the whole import over that would be
      // disproportionate; the row is reused and we move on.
      if (imported.isTeamEvent) {
        const inserted = await tx
          .insert(teams)
          .values({
            name: participant.name,
            externalSource: imported.source,
            externalId: participant.externalId,
          })
          .onConflictDoNothing()
          .returning({ id: teams.id });
        if (inserted.length > 0) return "created";

        // It existed by name: it is ADOPTED and given the origin, so that the
        // next import matches it by id and not by text.
        const [row] = await tx
          .select({ id: teams.id })
          .from(teams)
          .where(eq(teams.name, participant.name))
          .limit(1);
        if (!row) return null;
        await tx
          .update(teams)
          .set({ externalSource: imported.source, externalId: participant.externalId })
          .where(eq(teams.id, row.id));
        return "adopted";
      }

      const inserted = await tx
        .insert(players)
        .values({
          alias: participant.name,
          country: participant.country ?? null,
          externalSource: imported.source,
          externalId: participant.externalId,
        })
        .onConflictDoNothing()
        .returning({ id: players.id });
      if (inserted.length > 0) return "created";

      const [row] = await tx
        .select({ id: players.id })
        .from(players)
        .where(eq(players.alias, participant.name))
        .limit(1);
      if (!row) return null;
      await tx
        .update(players)
        .set({ externalSource: imported.source, externalId: participant.externalId })
        .where(eq(players.id, row.id));
      return "adopted";
    };

    // ── 1. Creations ──
    for (const participant of plan.toCreate) {
      const result = await createEntity(participant);
      if (result === "created") outcome.created += 1;
      else if (result === "adopted") outcome.updated += 1;
    }

    // ── 2. Updates ──
    // The source is authoritative for the NAME (someone renames between tournaments) but not
    // for anything else: the country or logo that have been curated here are not overwritten with
    // a null from the source.
    for (const participant of plan.toUpdate) {
      const where = and(
        eq(table.externalSource, imported.source),
        eq(table.externalId, participant.externalId)
      );
      if (imported.isTeamEvent) {
        await tx.update(teams).set({ name: participant.name }).where(where);
      } else {
        await tx.update(players).set({ alias: participant.name }).where(where);
      }
      outcome.updated += 1;
    }

    // ── 3. Registration in the tournament ──
    const allExternalIds = imported.participants.map((p) => p.externalId);
    const rows = allExternalIds.length
      ? await tx
          .select({ id: table.id, externalId: table.externalId })
          .from(table)
          .where(
            and(
              eq(table.externalSource, imported.source),
              inArray(table.externalId, allExternalIds)
            )
          )
      : [];

    const idByExternal = new Map(rows.map((row) => [row.externalId!, row.id]));
    const seedByExternal = new Map(
      imported.participants.map((p) => [p.externalId, p.seed ?? null])
    );

    for (const [externalId, entityId] of idByExternal) {
      const values = {
        tournamentId,
        ...(imported.isTeamEvent ? { teamId: entityId } : { playerId: entityId }),
        seed: seedByExternal.get(externalId) ?? null,
      };

      // The unique index (tournament, player) is what makes this part
      // idempotent: re-importing does not register anyone again.
      const inserted = await tx
        .insert(tournamentParticipants)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: tournamentParticipants.id });

      if (inserted.length === 0) outcome.alreadyRegistered += 1;
    }

    // ── 4. Bajas ──
    if (options.onMissing === "eliminate" && plan.missing.length > 0) {
      await tx
        .update(tournamentParticipants)
        .set({ eliminated: true })
        .where(
          inArray(
            tournamentParticipants.id,
            plan.missing.map((m) => m.participantId)
          )
        );
      outcome.eliminated = plan.missing.length;
    }

    // ── 5. Origin and pool on the tournament ──
    await tx
      .update(tournaments)
      .set({
        externalSource: imported.source,
        externalId: imported.externalId,
        externalUrl: imported.url,
        ...(imported.prizePool
          ? {
              prizePoolCents: imported.prizePool.cents,
              prizePoolCurrency: imported.prizePool.currency,
              prizePoolSyncedAt: new Date(),
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(tournaments.id, tournamentId));
  });

  return outcome;
}
