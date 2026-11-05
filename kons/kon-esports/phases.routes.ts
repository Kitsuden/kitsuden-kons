/**
 * Phase and check-in routes
 * ============================================================================
 *
 * They live apart from `esports.routes.ts` because they are a subsystem with its own
 * cycle: plan the sequence, open check-in, start each phase and
 * advance qualifiers. Putting them in the CRUD file would have taken it to
 * a thousand lines where it is already hard to find anything.
 */

import type { AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { createBracket, seedParticipants } from "./bracket";
import { loadBracket, persistBracket } from "./bracket.persistence";
import {
  canCheckIn,
  checkInCountdown,
  checkInState,
  checkInSummary,
  planNoShows,
  validateNoShowPlan,
  type NoShowAction,
} from "./checkin";
import type { EsportsDb } from "./esports.db";
import { denyUnless } from "./esports.guard";
import {
  bracketFormatEnum,
  phases,
  phaseEntries,
  players,
  teams,
  tournaments,
  tournamentParticipants,
  matches,
} from "./esports.schema";
import {
  computeAdvancement,
  fgcTemplate,
  snakeDraw,
  validatePhasePlan,
  type GroupResult,
  type PhaseFormat,
} from "./phases";
import { createRoundRobin, roundRobinStandings } from "./roundrobin";
import { loadRoundRobin, persistRoundRobin } from "./roundrobin.persistence";
import { generateSwissRound } from "./swiss.persistence";
import { Row, Obj, PhaseParam, ParticipantParam, TournamentParam, withData } from "./schemas";
import { ANY_ACCOUNT, ORGANIZATION_ONLY, registry } from "./operations";

/** An ISO 8601 date, or `null`. Before, a misspelled one reached the column. */
const DateOrNull = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "Invalid date (ISO 8601)" })
  .nullable()
  .optional();

const CheckInWindow = z.object({
  opensAt: DateOrNull.describe("When check-in opens; null (or absent) turns check-in off"),
  closesAt: DateOrNull.describe("When it closes"),
});

const ResolveNoShows = z.object({
  action: z
    .enum(["drop", "dq"])
    .optional()
    .describe("drop = before generating the bracket, dq = after. Required."),
  confirm: z.boolean().optional().describe("Without it, only a preview of what would happen"),
});

const PhasePlan = z.object({
  phases: z
    .array(
      z.object({
        order: z.number().int().min(1),
        name: z.string().min(1).max(80),
        format: z.enum(bracketFormatEnum.enumValues),
        groups: z.number().int().min(1).max(256).optional(),
        advancesPerGroup: z.number().int().min(1).max(4096).optional(),
      })
    )
    .max(20)
    .optional(),
  template: z
    .literal("fgc")
    .optional()
    .describe("FGC template (pools then top 8) instead of `phases`"),
  force: z.boolean().optional().describe("Accept a plan that only has warnings"),
});

export function phasesOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const { db: rawDb } = ctx;
  const db = { ...rawDb, instance: rawDb.instance as EsportsDb };

  // ── Check-in ───────────────────────────────────────────────────────────────

  /**
   * Check-in status. Public: it is the clock the player watches to know
   * whether they can confirm yet, and requiring a session to see a countdown is unnecessary.
   */
  app.get(
    "/tournament/:id/check-in",
    {
      id: "check-in-status",
      summary: "Check-in status",
      description:
        "Whether check-in is pending, open or closed, the seconds until it opens or closes (server clock), the window, and how many have checked in.",
      access: "public",
      input: { params: TournamentParam },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { id } = c.req.param();
      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, id))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);

      const window = {
        opensAt: tournament.checkInOpensAt,
        closesAt: tournament.checkInClosesAt,
      };
      const now = new Date();
      const parts = await db.instance
        .select()
        .from(tournamentParticipants)
        .where(eq(tournamentParticipants.tournamentId, id));

      return c.json({
        state: checkInState(window, now),
        // SECONDS, not the time: the client's clock and the server's do not
        // match, and a countdown computed in the browser drifts.
        countdown: checkInCountdown(window, now),
        opensAt: window.opensAt,
        closesAt: window.closesAt,
        summary: checkInSummary(parts),
      });
    }
  );

  /** Opens or reschedules the window. `null` in `opensAt` disables check-in. */
  app.post(
    "/tournament/:id/check-in/window",
    {
      id: "check-in-window",
      summary: "Open or reschedule check-in",
      description:
        "Sets the check-in window. `opensAt: null` (or no body) turns check-in off; to close it now, set `closesAt` to now. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      // Setting the same window twice leaves the same result.
      idempotent: true,
      input: { params: TournamentParam, body: CheckInWindow.optional() },
      output: { schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { id } = c.req.param();
      const body = (await c.req.json().catch(() => ({}))) as {
        opensAt?: string | null;
        closesAt?: string | null;
      };

      const [updated] = await db.instance
        .update(tournaments)
        .set({
          checkInOpensAt: body.opensAt ? new Date(body.opensAt) : null,
          checkInClosesAt: body.closesAt ? new Date(body.closesAt) : null,
          updatedAt: new Date(),
        })
        .where(eq(tournaments.id, id))
        .returning();

      if (!updated) return c.json({ error: "Tournament not found" }, 404);
      return c.json({ data: updated });
    }
  );

  /**
   * Confirms a participant's presence.
   *
   * It requires a session because it writes, but does NOT require being the player: in an
   * in-person tournament check-in is done by the registration desk as much as by the
   * player from their phone, and blocking the former would break the usual case.
   */
  app.post(
    "/participant/:participantId/check-in",
    {
      id: "check-in",
      summary: "Check a participant in",
      description:
        "Confirms presence while the window is open: your own participation, or anyone if you are tournament staff. Checking in twice keeps the original time (`alreadyCheckedIn`).",
      access: "session",
      permission: ANY_ACCOUNT,
      idempotent: true,
      input: { params: ParticipantParam },
      output: { schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { participantId } = c.req.param();

      const [participant] = await db.instance
        .select()
        .from(tournamentParticipants)
        .where(eq(tournamentParticipants.id, participantId))
        .limit(1);
      if (!participant) return c.json({ error: "Participant not found" }, 404);

      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, participant.tournamentId))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);

      // Each person confirms THEIR OWN. Without this, any registrant could confirm
      // (and above all unconfirm) any other: with public registration
      // open, "having a session" stopped meaning "being part of the organization".
      const denied = await denyUnless(c, "selfCheckIn", participant);
      if (denied) return denied;

      const allowed = canCheckIn(
        { opensAt: tournament.checkInOpensAt, closesAt: tournament.checkInClosesAt },
        participant,
        new Date()
      );
      if (!allowed.ok) return c.json({ error: allowed.reason }, 409);

      // Confirming twice does not rewrite the mark: the TO uses the original time
      // to know who arrived late.
      if (participant.checkedInAt) return c.json({ data: participant, alreadyCheckedIn: true });

      const [updated] = await db.instance
        .update(tournamentParticipants)
        .set({ checkedInAt: new Date() })
        .where(eq(tournamentParticipants.id, participantId))
        .returning();

      return c.json({ data: updated });
    }
  );

  /** Undoes a check-in. The registration desk makes mistakes too. */
  /**
   * Remove a check-in. **Organization only.**
   *
   * A player removing their own sounds harmless until you see it the other way around:
   * it is the operation used to take someone out of the tournament right before the
   * window closes.
   */
  app.delete(
    "/participant/:participantId/check-in",
    {
      id: "undo-check-in",
      summary: "Undo a check-in",
      description: "Removes the check-in of a participant. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: ParticipantParam },
      output: { schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { participantId } = c.req.param();
      const [updated] = await db.instance
        .update(tournamentParticipants)
        .set({ checkedInAt: null })
        .where(eq(tournamentParticipants.id, participantId))
        .returning();

      if (!updated) return c.json({ error: "Participant not found" }, 404);
      return c.json({ data: updated });
    }
  );

  /**
   * Resolves the absentees: removes them (`drop`) or disqualifies them (`dq`).
   *
   * The distinction is what prevents the costly mistake:
   *   · `drop` BEFORE generating the bracket — the bracket is computed over who
   *     is present and the byes fall where they should.
   *   · `dq` AFTER — removing them then would redo the bracket and move people
   *     who already have their pairing on their phone.
   *
   * There is no default: choosing wrong here is paid for live, so it is required.
   */
  app.post(
    "/tournament/:id/check-in/resolve",
    {
      id: "resolve-no-shows",
      summary: "Resolve no-shows",
      description:
        "Removes (`drop`, before generating the bracket) or disqualifies (`dq`, after) the participants who did not check in. Without `confirm: true` it only returns the plan. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      // `drop` deletes registrations.
      sensitive: true,
      input: { params: TournamentParam, body: ResolveNoShows.optional() },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { id } = c.req.param();
      const body = (await c.req.json().catch(() => ({}))) as {
        action?: NoShowAction;
        confirm?: boolean;
      };

      if (body.action !== "drop" && body.action !== "dq") {
        return c.json(
          {
            error: "`action` is required: 'drop' (before generating) or 'dq' (after)",
          },
          400
        );
      }

      const parts = await db.instance
        .select()
        .from(tournamentParticipants)
        .where(eq(tournamentParticipants.tournamentId, id));

      const plan = planNoShows(parts, body.action);
      const valid = validateNoShowPlan(plan);
      if (!valid.ok) return c.json({ error: valid.reason, plan }, 409);

      // Without `confirm` it only shows WHAT would happen: deleting registrations is
      // irreversible and the TO deserves to see the number before pressing.
      if (!body.confirm) return c.json({ preview: true, plan });

      if (plan.action === "drop") {
        await db.instance
          .delete(tournamentParticipants)
          .where(inArray(tournamentParticipants.id, plan.participantIds));
      } else {
        await db.instance
          .update(tournamentParticipants)
          .set({ eliminated: true })
          .where(inArray(tournamentParticipants.id, plan.participantIds));
      }

      return c.json({ done: true, plan });
    }
  );

  // ── Phases ─────────────────────────────────────────────────────────────────

  app.get(
    "/tournament/:id/phases",
    {
      id: "list-phases",
      summary: "List tournament phases",
      description: "The phase plan of the tournament in order (pools, top 8...), with status.",
      access: "public",
      input: { params: TournamentParam },
      output: { schema: withData(z.array(Row)) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { id } = c.req.param();
      const rows = await db.instance
        .select()
        .from(phases)
        .where(eq(phases.tournamentId, id))
        .orderBy(phases.order);
      return c.json({ data: rows });
    }
  );

  /**
   * Plans the sequence. Validates BEFORE writing.
   *
   * The errors caught here are those that ruin a tournament halfway: a
   * phase that receives more people than it admits, or one that eliminates nobody.
   */
  app.post(
    "/tournament/:id/phases",
    {
      id: "plan-phases",
      summary: "Plan the tournament phases",
      description:
        "Replaces the phase plan with `phases` or the FGC `template`. Errors are a 400 with `issues`; a plan with warnings needs `force: true` (409 otherwise). Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      // Replanning deletes the previous sequence.
      sensitive: true,
      input: { params: TournamentParam, body: PhasePlan.optional() },
      output: { status: 201, schema: withData(z.array(Row)) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { id } = c.req.param();
      const body = (await c.req.json().catch(() => ({}))) as {
        phases?: Array<{
          order: number;
          name: string;
          format: PhaseFormat;
          groups?: number;
          advancesPerGroup?: number;
        }>;
        /** Uses the FGC template (pools → top 8) instead of an explicit list. */
        template?: "fgc";
        force?: boolean;
      };

      const parts = await db.instance
        .select()
        .from(tournamentParticipants)
        .where(eq(tournamentParticipants.tournamentId, id));

      const plan = (
        body.template === "fgc"
          ? fgcTemplate(parts.length)
          : (body.phases ?? []).map((p) => ({
              order: p.order,
              name: p.name,
              format: p.format,
              groups: p.groups ?? 1,
              advancesPerGroup: p.advancesPerGroup ?? 1,
            }))
      ).sort((a, b) => a.order - b.order);

      const issues = validatePhasePlan(plan, parts.length);
      const errors = issues.filter((i) => i.level === "error");
      if (errors.length > 0) return c.json({ error: "Invalid plan", issues }, 400);
      // Warnings do not block —a 16-player round robin is legal, just long— but
      // they require the TO to say they know about it.
      if (issues.length > 0 && !body.force) {
        return c.json({ error: "The plan has warnings; resend with force:true", issues }, 409);
      }

      // Replanning deletes the previous one: half an old sequence and half a new one is
      // the worst possible state.
      await db.instance.delete(phases).where(eq(phases.tournamentId, id));

      const created = await db.instance
        .insert(phases)
        .values(plan.map((p) => ({ ...p, tournamentId: id })))
        .returning();

      return c.json({ data: created, issues }, 201);
    }
  );

  /**
   * Starts a phase: distributes its participants and generates its brackets.
   *
   * Phase 1 takes those who checked in (or everyone if there is no check-in);
   * later ones take the qualifiers, who are already in `phase_entries`
   * because the previous phase's `/advance` wrote them.
   */
  app.post(
    "/phase/:phaseId/start",
    {
      id: "start-phase",
      summary: "Start a phase",
      description:
        "Draws the participants of the phase into groups and generates the bracket of each group (swiss: round 1 only). Phase 1 takes the checked-in participants; later phases take those advanced by advance-phase. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: PhaseParam },
      output: { schema: withData(Obj) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { phaseId } = c.req.param();

      const [phase] = await db.instance
        .select()
        .from(phases)
        .where(eq(phases.id, phaseId))
        .limit(1);
      if (!phase) return c.json({ error: "Phase not found" }, 404);

      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, phase.tournamentId))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);

      let entries = await db.instance
        .select()
        .from(phaseEntries)
        .where(eq(phaseEntries.phaseId, phaseId));

      // The first phase is populated here; later ones come already populated.
      if (entries.length === 0) {
        if (phase.order !== 1) {
          return c.json(
            { error: "This phase has no participants: advance the previous phase first" },
            409
          );
        }

        const parts = await db.instance
          .select()
          .from(tournamentParticipants)
          .where(eq(tournamentParticipants.tournamentId, phase.tournamentId));

        // With check-in active only those present get in. Without it, everyone.
        const eligible = tournament.checkInOpensAt
          ? parts.filter((p) => p.checkedInAt && !p.eliminated)
          : parts.filter((p) => !p.eliminated);

        if (eligible.length < 2) {
          return c.json({ error: `Only ${eligible.length} eligible participant(s)` }, 409);
        }

        const seeded = seedParticipants(
          eligible.map((p) => ({ id: p.id, name: p.id, rating: p.rating ?? undefined })),
          tournament.seedMethod,
          tournament.shuffleSeed ?? 1
        );

        const draw = snakeDraw(
          seeded.map((p) => p.id),
          phase.groups
        );
        entries = await db.instance
          .insert(phaseEntries)
          .values(draw.map((d) => ({ ...d, phaseId })))
          .returning();
      }

      // One bracket per group. With `groups: 1` it is just one, which is the normal case.
      const byGroup = new Map<number, typeof entries>();
      for (const e of entries) {
        byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), e]);
      }

      const generated: { group: number; matches: number }[] = [];

      for (const [group, groupEntries] of [...byGroup.entries()].sort((a, b) => a[0] - b[0])) {
        const ids = [...groupEntries].sort((a, b) => a.seed - b.seed).map((e) => e.participantId);
        const scope = { phaseId, participantIds: ids };

        if (phase.format === "round_robin") {
          const rr = createRoundRobin(ids);
          const idByMatchId = new Map<string, string>();
          // The engine id carries the group in front: `G2-RR1M1`. Without that, two
          // pools of the same phase would collide in `bracket_match_id`.
          for (const m of rr.matches) idByMatchId.set(m.id, crypto.randomUUID());
          await persistRoundRobinScoped(
            db.instance,
            phase.tournamentId,
            phaseId,
            group,
            rr,
            idByMatchId
          );
          generated.push({ group, matches: rr.matches.filter((m) => m.status !== "bye").length });
        } else if (phase.format === "swiss") {
          // Swiss is NOT dumped whole: round 3 depends on who won in
          // 2. Starting the phase generates ONLY the first round; the following ones are
          // requested by the TO when the previous one is closed.
          //
          // Without this branch, "swiss" fell into the `else` and `createBracket` silently generated
          // an elimination — a whole tournament with the wrong
          // format and nobody watching.
          const round = await generateSwissRound(db.instance, phase.tournamentId, 0, { phaseId });
          generated.push({ group, matches: round.pairings.length });
        } else {
          const bracket = createBracket(
            ids.map((id) => ({ id, name: id })),
            { format: phase.format, seeding: "as_entered" }
          );
          const idByBracketId = new Map<string, string>();
          for (const m of bracket.matches) idByBracketId.set(m.id, crypto.randomUUID());
          await persistBracket(db.instance, phase.tournamentId, bracket, idByBracketId, scope);
          generated.push({ group, matches: bracket.matches.length });
        }
      }

      await db.instance
        .update(phases)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(phases.id, phaseId));

      return c.json({ data: { phaseId, groups: generated } });
    }
  );

  /**
   * Closes the phase and seeds the next one with the qualifiers.
   *
   * The seeding order **interleaves by position**: first all the group
   * winners, then all the runners-up. It is what keeps the 1st and 2nd of the
   * same pool from meeting in the first round of the finals.
   */
  app.post(
    "/phase/:phaseId/advance",
    {
      id: "advance-phase",
      summary: "Close a phase and seed the next",
      description:
        "Closes the phase and seeds the next one with those who advance, interleaved by position (all group winners first). Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: PhaseParam },
      output: { schema: withData(Obj) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { phaseId } = c.req.param();

      const [phase] = await db.instance
        .select()
        .from(phases)
        .where(eq(phases.id, phaseId))
        .limit(1);
      if (!phase) return c.json({ error: "Phase not found" }, 404);

      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, phase.tournamentId))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);

      const [next] = await db.instance
        .select()
        .from(phases)
        .where(and(eq(phases.tournamentId, phase.tournamentId), eq(phases.order, phase.order + 1)))
        .limit(1);
      if (!next) return c.json({ error: "There is no next phase to seed" }, 409);

      const results = await groupResults(db.instance, tournament, phase);
      const advancing = computeAdvancement(results, phase.advancesPerGroup);

      if (advancing.length < 2) {
        return c.json({ error: `Would advance only ${advancing.length}: check the results` }, 409);
      }

      // Reseeding deletes the previous seeding: half an old seeding and half a new one would give a
      // bracket with repeated players.
      await db.instance.delete(phaseEntries).where(eq(phaseEntries.phaseId, next.id));

      const draw = snakeDraw(
        advancing.map((a) => a.participantId),
        next.groups
      );
      await db.instance.insert(phaseEntries).values(draw.map((d) => ({ ...d, phaseId: next.id })));

      await db.instance
        .update(phases)
        .set({ status: "complete", updatedAt: new Date() })
        .where(eq(phases.id, phaseId));

      return c.json({ data: { advancing, nextPhaseId: next.id } });
    }
  );

  /** Standings of a phase, by group. Public: the graphic draws it. */
  app.get(
    "/phase/:phaseId/results",
    {
      id: "phase-results",
      summary: "Phase results by group",
      description: "The phase, display names, the order of each group and who advances.",
      access: "public",
      input: { params: PhaseParam },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { phaseId } = c.req.param();
      const [phase] = await db.instance
        .select()
        .from(phases)
        .where(eq(phases.id, phaseId))
        .limit(1);
      if (!phase) return c.json({ error: "Phase not found" }, 404);

      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, phase.tournamentId))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);

      const results = await groupResults(db.instance, tournament, phase);
      return c.json({
        phase,
        names: await nameMap(db.instance, phase.tournamentId),
        results,
        advancing: computeAdvancement(results, phase.advancesPerGroup),
      });
    }
  );

  return app.ops;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Round robin of a specific pool.
 *
 * Engine ids carry the group in front (`G2-RR1M1`): two pools of the
 * same phase both generate `RR1M1`, and without a prefix they would collide when
 * reconciling by `bracket_match_id`.
 */
async function persistRoundRobinScoped(
  db: EsportsDb,
  tournamentId: string,
  phaseId: string,
  group: number,
  rr: ReturnType<typeof createRoundRobin>,
  idByMatchId: Map<string, string>
): Promise<void> {
  const prefixed = {
    ...rr,
    matches: rr.matches.map((m) => ({ ...m, id: `G${group}-${m.id}` })),
  };
  const prefixedIds = new Map<string, string>();
  for (const [id, rowId] of idByMatchId) prefixedIds.set(`G${group}-${id}`, rowId);

  await persistRoundRobin(db, tournamentId, prefixed, prefixedIds);

  // `persistRoundRobin` does not know about phases: the freshly written rows are
  // labeled. It is the price of reusing the dump instead of duplicating it.
  await db
    .update(matches)
    .set({ phaseId })
    .where(inArray(matches.id, [...prefixedIds.values()]));
}

/** Standings of each group of a phase, already sorted. */
async function groupResults(
  db: EsportsDb,
  tournament: typeof tournaments.$inferSelect,
  phase: typeof phases.$inferSelect
): Promise<GroupResult[]> {
  const entries = await db.select().from(phaseEntries).where(eq(phaseEntries.phaseId, phase.id));

  const byGroup = new Map<number, string[]>();
  for (const e of entries) {
    byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), e.participantId]);
  }

  const results: GroupResult[] = [];

  for (const [group, ids] of [...byGroup.entries()].sort((a, b) => a[0] - b[0])) {
    if (phase.format === "round_robin") {
      const { rr } = await loadRoundRobin(db, tournament);
      // Only this pool's sets: the RR engine does not know about groups.
      const scoped = {
        ...rr,
        participants: ids,
        matches: rr.matches.filter((m) => m.id.startsWith(`G${group}-`)),
      };
      results.push({
        group,
        participantIds: roundRobinStandings(scoped).map((s) => s.participantId),
      });
    } else {
      const { bracket } = await loadBracket(db, tournament, {
        phaseId: phase.id,
        participantIds: ids,
      });
      // The bracket engine's `getStandings` already sorts by elimination round.
      const { getStandings } = await import("./bracket");
      results.push({
        group,
        participantIds: getStandings(bracket).map((s) => s.participantId),
      });
    }
  }

  return results;
}

/** `participantId` → name and country. A graphic does not draw UUIDs. */
async function nameMap(db: EsportsDb, tournamentId: string) {
  const rows = await db
    .select({
      id: tournamentParticipants.id,
      playerAlias: players.alias,
      playerCountry: players.country,
      teamName: teams.name,
    })
    .from(tournamentParticipants)
    .leftJoin(players, eq(tournamentParticipants.playerId, players.id))
    .leftJoin(teams, eq(tournamentParticipants.teamId, teams.id))
    .where(eq(tournamentParticipants.tournamentId, tournamentId));

  const names: Record<string, { name: string; country: string | null }> = {};
  for (const r of rows) {
    names[r.id] = { name: r.playerAlias ?? r.teamName ?? "", country: r.playerCountry ?? null };
  }
  return names;
}
