/**
 * Public registration and result report routes
 * ============================================================================
 *
 * The two things for which a TO stays on start.gg and does not come here:
 *
 *   1. That people sign up on their own. Without this, someone types in 128 people.
 *   2. That people report their own sets. Without this, someone presses 254
 *      times, in series, while the room waits.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE IDENTITY IS THE USER'S, THE PERMISSION IS THE PARTICIPANT'S
 *
 * Whoever comes in has a session (`c.get("user")`), but what decides whether they can
 * report a set is their `tournamentParticipants` row. It is resolved once
 * per request (`resolveParticipant`) and from there on reasoning is in terms
 * of the tournament, not of accounts.
 *
 * Intended consequence: an IMPORTED or manually created participant has no
 * `registeredByUserId`, so they cannot self-report. It is correct — nobody has
 * proven to be that person.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { can, type AuthzUser, type AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";

import { applyResult } from "./bracket.persistence";
import { canCheckIn } from "./checkin";
import { publicAnswers, validateAnswers, type CustomFieldDefinition } from "./custom-fields";
import type { EsportsDb } from "./esports.db";
import { Obj, ParamSet, TournamentParam, withData, query, text } from "./schemas";
import { ANY_ACCOUNT, ORGANIZATION_ONLY, registry, type KonPath } from "./operations";
import { aliasOwnership } from "./player-identity";
import {
  matchReports,
  matches,
  players,
  reportEvidence,
  tournamentParticipants,
  tournaments,
} from "./esports.schema";
import {
  hashAccessToken,
  issueAccessToken,
  participantLink,
  publicSiteUrl,
  readAccessToken,
} from "./guest-access";
import {
  guestRegistrationAllowed,
  looksLikeEmail,
  nextWaitlistPosition,
  planPromotions,
  planRegistration,
  planWithdrawal,
  queuePlace,
  registrationState,
  spotsLeft,
  type RegistrationMode,
  type RegistrationTournament,
} from "./registration";
import {
  canAutoConfirm,
  reconcileReports,
  ReportError,
  validateReport,
  type MatchReport,
} from "./reporting";
import { applyRoundRobinResult } from "./roundrobin.persistence";

type TournamentRow = typeof tournaments.$inferSelect;

/**
 * The requested alias already belongs to someone else.
 *
 * Its own class and not just any `Error` because it has to be distinguished from a
 * transaction failure: one is fixed by choosing another name (409) and the
 * other is not fixed by retrying (500).
 */
class AliasTakenError extends Error {}

/** The quota filled up (or registration closed) between planning and inserting. */
class PlanClosedError extends Error {
  constructor(
    message: string,
    readonly state?: unknown
  ) {
    super(message);
  }
}

/**
 * Per-tournament lock for a registration's transaction (an earlier
 * audit): the plan (is there a spot?) was computed OUTSIDE and several simultaneous requests
 * all saw "there is room". With the lock, each one recounts after
 * the previous one has written.
 */
async function registrationLock(tx: EsportsDb, tournamentId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`esports:registration:${tournamentId}`}))`
  );
}

/** Cap on evidence per report. Nobody looks at more than this. */
const MAX_EVIDENCE = 6;

/** Caps on what a registrant writes: what the column admits, no more. */
const MAX_ALIAS = 200;
const MAX_HANDLE = 120;
/** No community set goes over this; more is a typo or an attempt at a 500. */
const MAX_SCORE = 999;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Alpha-2 country in uppercase, or nothing (same rule as player creation). */
function normalizeCountry(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
}

function normalizeHandle(value: unknown): string | null {
  return typeof value === "string" ? value.trim().slice(0, MAX_HANDLE) || null : null;
}

/** Score of a report: exactly two bounded integers. */
function validScores(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => Number.isInteger(n) && n >= 0 && n <= MAX_SCORE)
  );
}

/** Translates the row into what the rules engine needs to know. */
function asRegistrationTournament(
  row: TournamentRow,
  bracketGenerated: boolean
): RegistrationTournament {
  return {
    registrationMode: row.registrationMode as RegistrationMode,
    registrationOpensAt: row.registrationOpensAt,
    registrationClosesAt: row.registrationClosesAt,
    maxParticipants: row.maxParticipants,
    waitlistEnabled: row.waitlistEnabled,
    requiresRulesAcceptance: row.requiresRulesAcceptance,
    isTeamEvent: row.format === "Team",
    allowGuestRegistration: row.allowGuestRegistration,
    bracketGenerated,
  };
}

/**
 * Typed variables: without this `c.get("user")` does not compile (Hono infers
 * `key: never`). Same pattern as `kon-games`.
 */
type RegistrationEnv = { Variables: { user: SessionUser | null } };
type C = Context<RegistrationEnv, KonPath>;

/** The little that is needed from the session. No role, no permissions: only identity. */
interface SessionUser {
  id: string;
  name?: string;
  email?: string;
}

/** Answers to the tournament's custom fields. */
const CustomAnswers = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe("Answers to the custom fields of the tournament, by field key");

/**
 * What the person signing up sends. `passthrough`: the route has always ignored
 * what it does not know. The limits (empty or long alias, email) are still reported
 * by the handler with its message.
 */
const Registration = z
  .object({
    alias: z.string().optional().describe("Name in the bracket (default: the account name)"),
    country: z.string().optional().describe("ISO alpha-2"),
    contactHandle: z.string().optional().describe("Discord handle or similar, for the organizers"),
    acceptRules: z
      .boolean()
      .optional()
      .describe("Required when the tournament asks to accept its rules"),
    customData: CustomAnswers.optional(),
  })
  .passthrough();
const GuestRegistration = Registration.extend({
  email: z.string().optional().describe("Where the personal link goes (required)"),
}).passthrough();

const Evidence = z.object({
  mediaId: z.string().optional().describe("An uploaded file (kon-media)"),
  url: z.string().optional().describe("A pasted http(s) link"),
  caption: z.string().optional(),
});
const SetReport = z
  .object({
    winnerId: z.string().optional().describe("PARTICIPANT id of the winner (required)"),
    // No shape in the schema: an odd score is the handler's usual 400
    // (`validScores`), which says which values are valid.
    scores: z
      .unknown()
      .optional()
      .describe("[participant 1, participant 2]: two integers from 0 to 999"),
    evidence: z.array(Evidence).optional().describe("Screenshots: `mediaId` OR `url` each, max 6"),
  })
  .passthrough();
const ResultSignature = z
  .object({
    winnerId: z.string().optional().describe("PARTICIPANT id of the winner (required)"),
    scores: z.array(z.number().int()).optional().describe("[participant 1, participant 2]"),
  })
  .passthrough();

export function registrationOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const db = ctx.db.instance as EsportsDb;

  /**
   * Does a bracket already exist? It is what really closes registration.
   *
   * It asks about the EXISTENCE of sets and not about a `status` field: the
   * status is moved by a person and forgotten, sets either exist or they do not.
   */
  /** Can the asker see this tournament? A draft, only the organization. */
  async function visible(c: { get: (k: "user") => unknown }, row: TournamentRow) {
    return can(
      (c.get("user") ?? null) as AuthzUser | null,
      "view",
      { status: row.status },
      "esports"
    );
  }

  async function hasBracket(tournamentId: string): Promise<boolean> {
    const [row] = await db
      .select({ total: count() })
      .from(matches)
      .where(eq(matches.tournamentId, tournamentId));
    return (row?.total ?? 0) > 0;
  }

  /**
   * `q` is the transaction when called inside one. With a single connection (PGlite, lite mode)
   * a query on the outer `db` while a transaction holds that connection never returns.
   */
  async function countsFor(tournamentId: string, q: EsportsDb = db) {
    const [registered] = await q
      .select({ total: count() })
      .from(tournamentParticipants)
      .where(
        and(
          eq(tournamentParticipants.tournamentId, tournamentId),
          isNull(tournamentParticipants.waitlistPosition)
        )
      );
    const [waitlisted] = await q
      .select({ total: count() })
      .from(tournamentParticipants)
      .where(
        and(
          eq(tournamentParticipants.tournamentId, tournamentId),
          isNotNull(tournamentParticipants.waitlistPosition)
        )
      );
    return { registered: registered?.total ?? 0, waitlisted: waitlisted?.total ?? 0 };
  }

  async function waitlistOf(tournamentId: string, q: EsportsDb = db) {
    const rows = await q
      .select({
        participantId: tournamentParticipants.id,
        waitlistPosition: tournamentParticipants.waitlistPosition,
      })
      .from(tournamentParticipants)
      .where(
        and(
          eq(tournamentParticipants.tournamentId, tournamentId),
          isNotNull(tournamentParticipants.waitlistPosition)
        )
      )
      .orderBy(asc(tournamentParticipants.waitlistPosition));
    return rows.map((r) => ({
      participantId: r.participantId,
      waitlistPosition: r.waitlistPosition!,
    }));
  }

  // ── Public face ────────────────────────────────────────────────────────────

  /**
   * Public tournament record. **No session**: it is the page that gets shared.
   *
   * It returns the already computed status instead of the raw dates so the
   * page does not have to reimplement the rules —and does not say "open" when
   * the bracket is already seeded.
   */
  app.get(
    "/public/tournament/:id",
    {
      id: "tournament-public-card",
      summary: "Public page of a tournament",
      description:
        "Title, formats, rules and prize pool, plus the registration state already computed (open, closed, full, waitlist), capacity, registered and spots left. A draft is a 404 from outside.",
      access: "optional",
      input: { params: TournamentParam },
      output: { schema: z.object({ data: Obj, registration: Obj }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const id = c.req.param("id");
      const [row] = await db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
      // A draft does not exist from outside (same rule as `GET /tournaments/:id`):
      // this record published the title, rules and prize of unannounced tournaments.
      if (!row || !(await visible(c, row))) return c.json({ error: "Tournament not found" }, 404);

      const counts = await countsFor(id);
      const t = asRegistrationTournament(row, await hasBracket(id));
      const state = registrationState(t, counts, new Date());

      return c.json({
        data: {
          id: row.id,
          title: row.title,
          format: row.format,
          bracketFormat: row.bracketFormat,
          startsAt: row.registrationOpensAt,
          rulesText: row.rulesText,
          requiresRulesAcceptance: row.requiresRulesAcceptance,
          prizePool:
            row.prizePoolCents === null
              ? null
              : {
                  cents: row.prizePoolCents,
                  currency: row.prizePoolCurrency,
                  syncedAt: row.prizePoolSyncedAt,
                },
        },
        registration: {
          state,
          opensAt: row.registrationOpensAt,
          closesAt: row.registrationClosesAt,
          capacity: row.maxParticipants,
          registered: counts.registered,
          waitlisted: counts.waitlisted,
          spotsLeft: spotsLeft(t, counts),
          waitlistEnabled: row.waitlistEnabled,
        },
      });
    }
  );

  /** My situation in this tournament. What the button draws: sign up or leave. */
  app.get(
    "/public/tournament/:id/me",
    {
      id: "my-registration",
      summary: "My registration in a tournament",
      description:
        "Whether your account is registered, with your participantId, status, place in the waitlist, check-in time and seed.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: TournamentParam },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const id = c.req.param("id");
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const [mine] = await db
        .select()
        .from(tournamentParticipants)
        .where(
          and(
            eq(tournamentParticipants.tournamentId, id),
            eq(tournamentParticipants.registeredByUserId, user.id)
          )
        )
        .limit(1);

      if (!mine) return c.json({ registered: false });

      const waitlisted = mine.waitlistPosition !== null;
      return c.json({
        registered: true,
        participantId: mine.id,
        status: mine.status,
        waitlisted,
        // The spot IN THE QUEUE, not the stored arrival number: that one has
        // gaps and would say "you are 47th" in a queue of three.
        queuePlace: waitlisted ? queuePlace(await waitlistOf(id), mine.id) : null,
        checkedInAt: mine.checkedInAt,
        seed: mine.seed,
      });
    }
  );

  /**
   * Sign up.
   *
   * It requires a session, but NOT a CMS one: any site account works, which is what
   * makes Discord login useful — one button, and the TO already gets the handle
   * through which it will announce that it is time to play.
   */
  app.post(
    "/public/tournament/:id/register",
    {
      id: "register-me",
      summary: "Sign up for a tournament",
      description:
        "Registers your account in a 1v1 tournament (approved, pending approval or waitlisted, depending on the tournament). Reuses your player profile; a taken alias is a 409. Team tournaments go through register-my-team (this answers 501 for them).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: TournamentParam, body: Registration.optional() },
      output: { status: 201, schema: z.object({ data: Obj, result: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const id = c.req.param("id");
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const body = (await c.req.json().catch(() => ({}))) as {
        alias?: string;
        country?: string;
        contactHandle?: string;
        acceptRules?: boolean;
        customData?: Record<string, string | number | boolean | null>;
      };

      const [row] = await db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
      if (!row || !(await visible(c, row))) return c.json({ error: "Tournament not found" }, 404);

      const [existing] = await db
        .select({ id: tournamentParticipants.id })
        .from(tournamentParticipants)
        .where(
          and(
            eq(tournamentParticipants.tournamentId, id),
            eq(tournamentParticipants.registeredByUserId, user.id)
          )
        )
        .limit(1);

      const counts = await countsFor(id);
      const t = asRegistrationTournament(row, await hasBracket(id));

      const plan = planRegistration(
        t,
        counts,
        {
          acceptedRules: body.acceptRules === true,
          alreadyRegistered: Boolean(existing),
          isGuest: false,
        },
        new Date()
      );

      if (!plan.ok) return c.json({ error: plan.reason, state: plan.state }, 409);

      // Teams are NOT registered through here: a captain, invitations and
      // acceptances are needed, and pretending a person "is" a team would leave
      // empty rosters on tournament day.
      if (row.format === "Team") {
        return c.json(
          { error: "This tournament is for teams; team registration is not open yet." },
          501
        );
      }

      const alias = (body.alias ?? user.name ?? "").trim();
      if (!alias) return c.json({ error: "An alias is required for the bracket." }, 400);
      if (alias.length > MAX_ALIAS) return c.json({ error: "Alias too long." }, 400);

      // Custom fields are validated BEFORE writing anything: half a registration
      // saved and then rejected leaves the TO with rows they cannot interpret.
      const answers = validateAnswers(
        (row.customFields ?? []) as CustomFieldDefinition[],
        (body.customData ?? {}) as Record<string, string | number | boolean | null>
      );
      if (!answers.ok) return c.json({ error: "Missing data", issues: answers.issues }, 422);

      /**
       * This account's player, if they have played something before.
       *
       * It is looked up through their earlier participations and NOT by `players.coreUserId`,
       * which is a `uuid` column: Better-Auth ids are free text, so
       * comparing them there blows up the query as soon as the id is not a uuid — that
       * is, always. `registeredByUserId` is text and already stores that link.
       *
       * Reusing the record matters: the history across tournaments is half
       * the value of having profiles.
       */
      const [previous] = await db
        .select({ playerId: tournamentParticipants.playerId })
        .from(tournamentParticipants)
        .where(
          and(
            eq(tournamentParticipants.registeredByUserId, user.id),
            isNotNull(tournamentParticipants.playerId)
          )
        )
        .limit(1);

      // If they did not play before with this account, the alias may already be THEIRS by another
      // route (captain of a team, accepted invitation). If it belongs to someone else, it is
      // rejected below just as before.
      const ownership = previous?.playerId ? null : await aliasOwnership(db, alias, user.id);

      let created;
      let result = plan.result;
      try {
        created = await db.transaction(async (tx: EsportsDb) => {
          await registrationLock(tx, id);
          const current = planRegistration(
            t,
            await countsFor(id, tx),
            {
              acceptedRules: body.acceptRules === true,
              alreadyRegistered: Boolean(existing),
              isGuest: false,
            },
            new Date()
          );
          if (!current.ok) throw new PlanClosedError(current.reason, current.state);
          result = current.result;

          let playerId =
            previous?.playerId ?? (ownership?.status === "mine" ? ownership.playerId : null);

          if (!playerId) {
            const [inserted] = await tx
              .insert(players)
              .values({ alias, country: normalizeCountry(body.country) })
              .onConflictDoNothing()
              .returning({ id: players.id });

            if (!inserted) {
              // The alias already exists and is not recorded as belonging to this account. Reusing that
              // record would give someone else's history —and identity— to another person.
              throw new AliasTakenError(
                `The alias "${alias}" is already in use. Choose another for this tournament.`
              );
            }
            playerId = inserted.id;
          }

          const waitlisted = current.result === "waitlisted";
          const [participant] = await tx
            .insert(tournamentParticipants)
            .values({
              tournamentId: id,
              playerId,
              status: current.result === "pending_approval" ? "Pending" : "Approved",
              registeredByUserId: user.id,
              // It is computed INSIDE the transaction: between reading the queue and
              // writing, another registration may have taken that number.
              waitlistPosition: waitlisted ? nextWaitlistPosition(await waitlistOf(id, tx)) : null,
              acceptedRulesAt: body.acceptRules ? new Date() : null,
              contactHandle: normalizeHandle(body.contactHandle),
              customData: answers.clean,
            })
            .returning();

          return participant;
        });
      } catch (err) {
        if (err instanceof AliasTakenError) return c.json({ error: err.message }, 409);
        if (err instanceof PlanClosedError)
          return c.json({ error: err.message, state: err.state }, 409);
        throw err;
      }

      return c.json({ data: created, result: result }, 201);
    }
  );

  /**
   * Withdraw, and promote whoever is next.
   *
   * Both things go in the SAME transaction: if the withdrawal is saved and the
   * promotion is not, a free spot is left that nobody fills and a queue that
   * does not advance — and that is not seen until someone asks.
   */
  app.delete(
    "/public/tournament/:id/register",
    {
      id: "delete-my-registration",
      summary: "Withdraw my registration",
      description:
        "Withdraws your account from the tournament and promotes whoever is next in the waitlist. 409 once the bracket exists.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: TournamentParam },
      output: { schema: z.object({ withdrawn: z.literal(true), promoted: z.array(z.string()) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const id = c.req.param("id");
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const [row] = await db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
      if (!row) return c.json({ error: "Tournament not found" }, 404);

      const [mine] = await db
        .select()
        .from(tournamentParticipants)
        .where(
          and(
            eq(tournamentParticipants.tournamentId, id),
            eq(tournamentParticipants.registeredByUserId, user.id)
          )
        )
        .limit(1);
      if (!mine) return c.json({ error: "You are not registered in this tournament." }, 404);

      const t = asRegistrationTournament(row, await hasBracket(id));
      const plan = planWithdrawal(t, { waitlisted: mine.waitlistPosition !== null });
      if (!plan.ok) return c.json({ error: plan.reason }, 409);

      const promoted = await db.transaction(async (tx: EsportsDb) => {
        await tx.delete(tournamentParticipants).where(eq(tournamentParticipants.id, mine.id));

        if (!plan.freesSpot) return [];

        const counts = await countsFor(id, tx);
        const ids = planPromotions(await waitlistOf(id, tx), spotsLeft(t, counts));
        for (const participantId of ids) {
          // `waitlistPosition` set to null IS the promotion: they are no longer in the queue.
          await tx
            .update(tournamentParticipants)
            .set({ waitlistPosition: null })
            .where(eq(tournamentParticipants.id, participantId));
        }
        return ids;
      });

      return c.json({ withdrawn: true, promoted });
    }
  );

  /**
   * Sign up WITHOUT an account. 1v1 only.
   *
   * It is the route that decides whether a community grows: someone arriving from a tweet does not
   * want one more account, they want to play. The email is enough.
   *
   * The email is NOT verified before accepting, and that is deliberate: the verification
   * IS the link. If you do not control that mailbox you never receive the link, and without the
   * link the registration is useless — you cannot check in, report, or
   * withdraw it. Putting a confirmation step in front would only add
   * a screen where people are lost.
   */
  app.post(
    "/public/tournament/:id/register-guest",
    {
      id: "register-guest",
      summary: "Sign up without an account (1v1)",
      description:
        "Registers a guest with an email and an alias, when the tournament allows it. Returns the personal link (`accessToken`, `accessLink`) ONCE: it is needed for check-in, reporting and withdrawing, and cannot be recovered.",
      access: "public",
      input: { params: TournamentParam, body: GuestRegistration.optional() },
      output: {
        status: 201,
        schema: z.object({
          data: Obj,
          result: z.string(),
          accessToken: z.string(),
          accessLink: z.string(),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const id = c.req.param("id");
      const body = (await c.req.json().catch(() => ({}))) as {
        alias?: string;
        email?: string;
        country?: string;
        contactHandle?: string;
        acceptRules?: boolean;
        customData?: Record<string, string | number | boolean | null>;
      };

      const [row] = await db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
      // Without a session a draft is never visible: signing up for one is also "viewing" it.
      if (!row || row.status === "Draft") return c.json({ error: "Tournament not found" }, 404);

      const email = (body.email ?? "").trim().toLowerCase();
      if (!looksLikeEmail(email)) {
        return c.json({ error: "A valid email is required: it is where your link goes." }, 400);
      }

      const alias = (body.alias ?? "").trim();
      if (!alias) return c.json({ error: "An alias is required for the bracket." }, 400);
      if (alias.length > MAX_ALIAS) return c.json({ error: "Alias too long." }, 400);

      const answers = validateAnswers(
        (row.customFields ?? []) as CustomFieldDefinition[],
        (body.customData ?? {}) as Record<string, string | number | boolean | null>
      );
      if (!answers.ok) return c.json({ error: "Missing data", issues: answers.issues }, 422);

      const t = asRegistrationTournament(row, await hasBracket(id));

      // The "an account is needed here" message has to come out BEFORE looking at
      // spots: whoever cannot get in this way must be told what they are missing.
      if (!guestRegistrationAllowed(t)) {
        const plan = planRegistration(
          t,
          await countsFor(id),
          { acceptedRules: true, alreadyRegistered: false, isGuest: true },
          new Date()
        );
        return c.json({ error: plan.ok ? "This tournament requires an account." : plan.reason }, 409);
      }

      const [existing] = await db
        .select({ id: tournamentParticipants.id })
        .from(tournamentParticipants)
        .where(
          and(
            eq(tournamentParticipants.tournamentId, id),
            eq(tournamentParticipants.guestEmail, email)
          )
        )
        .limit(1);

      const plan = planRegistration(
        t,
        await countsFor(id),
        {
          acceptedRules: body.acceptRules === true,
          alreadyRegistered: Boolean(existing),
          isGuest: true,
        },
        new Date()
      );
      if (!plan.ok) return c.json({ error: plan.reason, state: plan.state }, 409);

      const issued = issueAccessToken();

      let created;
      let result = plan.result;
      try {
        created = await db.transaction(async (tx: EsportsDb) => {
          await registrationLock(tx, id);
          const current = planRegistration(
            t,
            await countsFor(id, tx),
            {
              acceptedRules: body.acceptRules === true,
              alreadyRegistered: Boolean(existing),
              isGuest: true,
            },
            new Date()
          );
          if (!current.ok) throw new PlanClosedError(current.reason, current.state);
          result = current.result;

          const [inserted] = await tx
            .insert(players)
            .values({ alias, country: normalizeCountry(body.country) })
            .onConflictDoNothing()
            .returning({ id: players.id });

          if (!inserted) {
            throw new AliasTakenError(
              `The alias "${alias}" is already in use. Choose another for this tournament.`
            );
          }

          const waitlisted = current.result === "waitlisted";
          const [participant] = await tx
            .insert(tournamentParticipants)
            .values({
              tournamentId: id,
              playerId: inserted.id,
              status: current.result === "pending_approval" ? "Pending" : "Approved",
              guestEmail: email,
              // The HASH is stored. The token is shown once and does not come back.
              accessTokenHash: issued.hash,
              waitlistPosition: waitlisted ? nextWaitlistPosition(await waitlistOf(id, tx)) : null,
              acceptedRulesAt: body.acceptRules ? new Date() : null,
              contactHandle: normalizeHandle(body.contactHandle),
              customData: answers.clean,
            })
            .returning();

          return participant;
        });
      } catch (err) {
        if (err instanceof AliasTakenError) return c.json({ error: err.message }, 409);
        if (err instanceof PlanClosedError)
          return c.json({ error: err.message, state: err.state }, 409);
        throw err;
      }

      // The guest page is on the public site, not on the API host that answered this request.
      const origin = await publicSiteUrl(ctx);

      return c.json(
        {
          data: publicParticipant(created),
          result: result,
          /**
           * The link comes out HERE and only here. There is no way to recover it: asking for
           * another generates a new one and invalidates this one. Save it or send it by email
           * in the same step.
           */
          accessToken: issued.token,
          accessLink: participantLink(origin, id, issued.token),
        },
        201
      );
    }
  );

  /**
   * Status of MY registration, with the personal link.
   *
   * Twin of `/me`, but for someone without an account. It is separate and not an
   * `if` inside the other because the account one requires a session and this one does not: mixing them
   * would require removing `requireAuth` from an authenticated route, which is how
   * holes get opened by accident.
   */
  app.get(
    "/public/tournament/:id/guest",
    {
      id: "my-guest-registration",
      summary: "My guest registration (personal link)",
      description:
        "The guest registration that the personal link token identifies, and its place in the waitlist.",
      access: "public",
      input: {
        params: TournamentParam,
        query: query({
          token: text(
            "Personal link token (or the X-Participant-Token header, or Authorization: Participant <token>)"
          ),
        }),
      },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_UNAUTHENTICATED", "KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const participant = await resolveGuest(c.req.raw.headers, c.req.url, c.req.param("id"));
      if (!participant) return c.json({ error: "Invalid link" }, 401);

      const waitlisted = participant.waitlistPosition !== null;
      return c.json({
        data: publicParticipant(participant),
        waitlisted,
        queuePlace: waitlisted
          ? queuePlace(await waitlistOf(participant.tournamentId), participant.id)
          : null,
      });
    }
  );

  /** Check-in with the link. Without this, a guest could not confirm they are here. */
  app.post(
    "/public/tournament/:id/guest/check-in",
    {
      id: "guest-check-in",
      summary: "Check in with the personal link",
      description: "Check-in for a guest, inside the same window as account check-in.",
      access: "public",
      idempotent: true,
      input: {
        params: TournamentParam,
        query: query({
          token: text(
            "Personal link token (or the X-Participant-Token header, or Authorization: Participant <token>)"
          ),
        }),
      },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_UNAUTHENTICATED", "KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const participant = await resolveGuest(c.req.raw.headers, c.req.url, c.req.param("id"));
      if (!participant) return c.json({ error: "Invalid link" }, 401);

      // The same window as account check-in (phases.routes.ts). Before, the
      // link confirmed before opening or after closing, and thereby dodged the
      // `drop`/`dq` of absentees (an earlier audit).
      const [tournamentValue] = await db
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, participant.tournamentId))
        .limit(1);
      if (!tournamentValue) return c.json({ error: "Tournament not found" }, 404);
      const allowed = canCheckIn(
        { opensAt: tournamentValue.checkInOpensAt, closesAt: tournamentValue.checkInClosesAt },
        participant,
        new Date()
      );
      if (!allowed.ok) return c.json({ error: allowed.reason }, 409);
      if (participant.checkedInAt) {
        return c.json({ data: publicParticipant(participant), alreadyCheckedIn: true });
      }

      const [updated] = await db
        .update(tournamentParticipants)
        .set({ checkedInAt: new Date() })
        .where(eq(tournamentParticipants.id, participant.id))
        .returning();

      return c.json({ data: publicParticipant(updated) });
    }
  );

  /** Withdraw with the link, promoting whoever is next. */
  app.delete(
    "/public/tournament/:id/guest",
    {
      id: "guest-withdraw",
      summary: "Withdraw a guest registration",
      description:
        "Withdraws the guest registration of the personal link and promotes the waitlist.",
      access: "public",
      input: {
        params: TournamentParam,
        query: query({
          token: text(
            "Personal link token (or the X-Participant-Token header, or Authorization: Participant <token>)"
          ),
        }),
      },
      output: { schema: z.object({ withdrawn: z.literal(true), promoted: z.array(z.string()) }) },
      errors: ["KITSUDEN_E_UNAUTHENTICATED", "KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const id = c.req.param("id");
      const participant = await resolveGuest(c.req.raw.headers, c.req.url, id);
      if (!participant) return c.json({ error: "Invalid link" }, 401);

      const [row] = await db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
      if (!row) return c.json({ error: "Tournament not found" }, 404);

      const t = asRegistrationTournament(row, await hasBracket(id));
      const plan = planWithdrawal(t, { waitlisted: participant.waitlistPosition !== null });
      if (!plan.ok) return c.json({ error: plan.reason }, 409);

      const promoted = await db.transaction(async (tx: EsportsDb) => {
        await tx
          .delete(tournamentParticipants)
          .where(eq(tournamentParticipants.id, participant.id));
        if (!plan.freesSpot) return [];

        const ids = planPromotions(await waitlistOf(id, tx), spotsLeft(t, await countsFor(id, tx)));
        for (const participantId of ids) {
          await tx
            .update(tournamentParticipants)
            .set({ waitlistPosition: null })
            .where(eq(tournamentParticipants.id, participantId));
        }
        return ids;
      });

      return c.json({ withdrawn: true, promoted });
    }
  );

  // ── Result reports ─────────────────────────────────────────────────────────

  /**
   * Removes from the row what must NOT come out of here.
   *
   * The list of a tournament's registrants is public; those people's email and the
   * hash of their link are not. It is filtered in a single function so that no
   * stray `returning()` publishes them by oversight — which is exactly how
   * emails leak.
   */
  function publicParticipant(
    row: typeof tournamentParticipants.$inferSelect,
    fields: CustomFieldDefinition[] = []
  ) {
    const { guestEmail: _email, accessTokenHash: _hash, customData, ...safe } = row;
    return {
      ...safe,
      // `organizer` fields (PayPal, phone, address) do NOT come out. By
      // default a field is private: if someone defines one and forgets to
      // declare visibility, the safe outcome is that it is not published — the other way around,
      // the omission would publish phone numbers.
      customData: publicAnswers(fields, (customData ?? {}) as Record<string, string>),
    };
  }

  /**
   * From the link to the participant.
   *
   * The TOURNAMENT is also checked: a link is valid for one participation, not
   * for the whole platform. Without that check, one tournament's link
   * could be used to act in another.
   */
  async function resolveGuest(headers: Headers, url: string, tournamentId: string) {
    const token = readAccessToken(headers, url);
    if (!token) return null;

    const [row] = await db
      .select()
      .from(tournamentParticipants)
      .where(
        and(
          eq(tournamentParticipants.accessTokenHash, hashAccessToken(token)),
          eq(tournamentParticipants.tournamentId, tournamentId)
        )
      )
      .limit(1);

    return row ?? null;
  }

  /** From the session to the participant. `null` if that account is not in the tournament. */
  async function resolveParticipant(tournamentId: string, userId: string) {
    const [row] = await db
      .select()
      .from(tournamentParticipants)
      .where(
        and(
          eq(tournamentParticipants.tournamentId, tournamentId),
          eq(tournamentParticipants.registeredByUserId, userId)
        )
      )
      .limit(1);
    return row ?? null;
  }

  async function loadMatch(matchId: string) {
    const [row] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!row) return null;
    const [tournament] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, row.tournamentId))
      .limit(1);
    return tournament ? { match: row, tournament } : null;
  }

  /**
   * Validates the evidence that comes with a report.
   *
   * A piece of evidence is one thing OR the other, never both nor neither. And a `url`
   * can only be http(s): this is drawn as a link —and sometimes as an image—
   * in the TO panel, so a `javascript:` there is XSS served on a platter.
   */
  function normalizeEvidence(
    raw: Array<{ mediaId?: string; url?: string; caption?: string }> | undefined
  ):
    | { ok: true; items: Array<{ mediaId?: string; url?: string; caption?: string }> }
    | {
        ok: false;
        reason: string;
      } {
    if (!raw) return { ok: true, items: [] };
    if (!Array.isArray(raw)) return { ok: false, reason: "`evidence` must be a list." };
    if (raw.length > MAX_EVIDENCE) {
      return { ok: false, reason: `At most ${MAX_EVIDENCE} pieces of evidence per report.` };
    }

    const items: Array<{ mediaId?: string; url?: string; caption?: string }> = [];
    for (const entry of raw) {
      const hasMedia = Boolean(entry.mediaId);
      const hasUrl = Boolean(entry.url?.trim());

      if (hasMedia === hasUrl) {
        return { ok: false, reason: "Each piece of evidence needs `mediaId` OR `url`, not both." };
      }

      if (hasUrl) {
        try {
          const parsed = new URL(entry.url!.trim());
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return { ok: false, reason: "Evidence links must be http or https." };
          }
          const url = parsed.toString();
          if (url.length > 2000) return { ok: false, reason: "Evidence link too long." };
          items.push({ url, caption: entry.caption?.slice(0, 300) });
        } catch {
          return { ok: false, reason: `"${entry.url}" is not a valid link.` };
        }
      } else {
        // `media_id` is a uuid: anything else blew up the INSERT (500) with
        // the report already half-written inside the transaction.
        if (typeof entry.mediaId !== "string" || !UUID.test(entry.mediaId)) {
          return { ok: false, reason: "`mediaId` is not a valid file id." };
        }
        items.push({ mediaId: entry.mediaId, caption: entry.caption?.slice(0, 300) });
      }
    }

    return { ok: true, items };
  }

  /** The evidence of several reports, grouped by report. */
  async function evidenceFor(reportIds: string[]) {
    if (reportIds.length === 0) return new Map<string, unknown[]>();
    const rows = await db
      .select()
      .from(reportEvidence)
      .where(inArray(reportEvidence.reportId, reportIds));

    const byReport = new Map<string, unknown[]>();
    for (const row of rows) {
      const list = byReport.get(row.reportId) ?? [];
      list.push({
        mediaId: row.mediaId,
        url: row.url,
        caption: row.caption,
        // Where it came from is declared: an upload of ours cannot be changed
        // afterwards or leak the viewer's IP; a pasted link can.
        trusted: row.mediaId !== null,
      });
      byReport.set(row.reportId, list);
    }
    return byReport;
  }

  async function reportsOf(matchId: string): Promise<Array<MatchReport & { createdAt: Date }>> {
    const rows = await db
      .select()
      .from(matchReports)
      .where(eq(matchReports.matchId, matchId))
      .orderBy(asc(matchReports.createdAt));

    return rows.map((r) => ({
      reportedBy: r.reportedBy,
      winnerId: r.winnerId,
      scores:
        r.score1 === null || r.score2 === null ? null : ([r.score1, r.score2] as [number, number]),
      createdAt: r.createdAt,
    }));
  }

  /**
   * Writes the agreed result into the bracket.
   *
   * It reuses exactly the same path as the TO's report: if the advancement
   * of double elimination lived in two places, one of them would fall
   * behind, and the one that falls behind breaks brackets live.
   */
  async function applyAgreed(
    tournament: TournamentRow,
    match: typeof matches.$inferSelect,
    winnerId: string,
    scores: [number, number] | null
  ) {
    const bracketMatchId = match.bracketMatchId;
    if (!bracketMatchId) throw new ReportError("This set has no bracket id.");

    if (tournament.bracketFormat === "round_robin") {
      return applyRoundRobinResult(db, tournament, bracketMatchId, {
        winnerId,
        scores: scores ?? undefined,
      });
    }
    return applyResult(db, tournament, bracketMatchId, {
      winnerId,
      scores: scores ? { participant1: scores[0], participant2: scores[1] } : undefined,
    });
  }

  /** Status of the set according to the reports. Both players query it. */
  app.get(
    "/match/:matchId/report",
    {
      id: "reports-status",
      summary: "Reports of a set",
      description:
        "What the two players reported for the set and the reconciliation (agreed, waiting, disputed).",
      access: "optional",
      input: { params: ParamSet },
      output: { schema: z.object({ data: Obj, reports: z.array(Obj) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const loaded = await loadMatch(c.req.param("matchId"));
      if (!loaded) return c.json({ error: "Match not found" }, 404);

      const reports = await reportsOf(loaded.match.id);
      const reconciliation = reconcileReports(
        { participants: [loaded.match.participant1Id, loaded.match.participant2Id] },
        reports
      );

      return c.json({ data: reconciliation, reports });
    }
  );

  /**
   * A player reports their set.
   *
   * Confirming the opponent's report is sending the SAME report: no separate
   * route is needed, and so "I confirm" and "I report" are the same act — which is what
   * keeps someone from confirming without looking at the score.
   */
  app.post(
    "/match/:matchId/report",
    {
      id: "report-my-set",
      summary: "Report my set (player)",
      description:
        "A player of the set (account, or guest with the personal link) reports the winner and score, with screenshots if the tournament requires them. Confirming the opponent's report is sending the same report; when both agree the bracket advances (`applied`). Someone who does not play the tournament gets a 404.",
      access: "optional",
      input: {
        params: ParamSet,
        query: query({
          token: text(
            "Personal link token (or the X-Participant-Token header, or Authorization: Participant <token>)"
          ),
        }),
        body: SetReport.optional(),
      },
      output: { schema: z.object({ data: Obj, applied: z.boolean() }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const loaded = await loadMatch(c.req.param("matchId"));
      if (!loaded) return c.json({ error: "Match not found" }, 404);
      const { match, tournament } = loaded;

      // `optionalAuth` and not `requireAuth`: a 1v1 guest has no session,
      // and reporting their own set is exactly what makes signing up without an account
      // worthwhile. The identity comes from the session OR the personal link; what
      // authorizes in both cases is the participant row.
      const user = c.get("user");
      const me = user
        ? await resolveParticipant(tournament.id, user.id)
        : await resolveGuest(c.req.raw.headers, c.req.url, tournament.id);

      if (!me) {
        // 404 and not 403: whoever is not in the tournament need not find out
        // that the set exists.
        return c.json({ error: "Match not found" }, 404);
      }

      const body = (await c.req.json().catch(() => ({}))) as {
        winnerId?: string;
        scores?: [number, number];
        /** Screenshots: uploaded through kon-media (`mediaId`) or pasted (`url`). */
        evidence?: Array<{ mediaId?: string; url?: string; caption?: string }>;
      };
      if (!body.winnerId) return c.json({ error: "`winnerId` is missing" }, 400);
      if (body.scores !== undefined && body.scores !== null && !validScores(body.scores)) {
        return c.json(
          {
            error: `\`scores\` are two integers between 0 and ${MAX_SCORE} (participant 1, participant 2).`,
          },
          400
        );
      }

      const evidence = normalizeEvidence(body.evidence);
      if (!evidence.ok) return c.json({ error: evidence.reason }, 400);

      /**
       * The TO can REQUIRE a screenshot, and it is checked before saving.
       *
       * It is what turns "I think I won" into something resolvable without knowing
       * anyone: without proof, the disputes screen shows two contradictory
       * versions and the TO ends up deciding by who wrote better.
       */
      if (tournament.requiresEvidence && evidence.items.length === 0) {
        return c.json(
          { error: "This tournament requires a screenshot of the result in order to report." },
          422
        );
      }

      const report: MatchReport = {
        reportedBy: me.id,
        winnerId: body.winnerId,
        scores: body.scores ?? null,
      };

      try {
        validateReport(
          {
            participants: [match.participant1Id, match.participant2Id],
            resolved: match.winnerId !== null,
            bestOf: null,
          },
          report
        );
      } catch (err) {
        return c.json({ error: err instanceof ReportError ? err.message : "Invalid report" }, 400);
      }

      // It is always INSERTED, never overwritten: the report history is the
      // evidence when a "I reported correctly" complaint arrives.
      //
      // Report and evidence go TOGETHER in one transaction: a report without its
      // screenshot, or an orphan screenshot, is exactly what is of no use
      // for resolving a dispute.
      await db.transaction(async (tx: EsportsDb) => {
        const [saved] = await tx
          .insert(matchReports)
          .values({
            matchId: match.id,
            reportedBy: me.id,
            winnerId: body.winnerId!,
            score1: body.scores?.[0] ?? null,
            score2: body.scores?.[1] ?? null,
          })
          .returning({ id: matchReports.id });

        if (evidence.items.length > 0) {
          await tx.insert(reportEvidence).values(
            evidence.items.map((item) => ({
              reportId: saved.id,
              mediaId: item.mediaId ?? null,
              url: item.url ?? null,
              caption: item.caption ?? null,
            }))
          );
        }
      });

      const reconciliation = reconcileReports(
        { participants: [match.participant1Id, match.participant2Id] },
        await reportsOf(match.id)
      );

      if (reconciliation.status !== "agreed" || !reconciliation.winnerId) {
        return c.json({ data: reconciliation, applied: false });
      }

      try {
        await applyAgreed(tournament, match, reconciliation.winnerId, reconciliation.scores);
      } catch (err) {
        // The report is ALREADY saved; what failed is the advancement. It is said as it is
        // instead of pretending the report did not arrive: repeating it would fix nothing
        // and the TO can sign it by hand.
        const message = err instanceof Error ? err.message : "Could not advance the bracket";
        return c.json({ data: reconciliation, applied: false, error: message }, 409);
      }

      return c.json({ data: reconciliation, applied: true });
    }
  );

  /**
   * What needs a person.
   *
   * It is THE TO screen during the tournament: everything else resolves itself, and
   * what is left here is the little that requires judgment. It also includes reports that
   * have been waiting longer than the deadline, because a stuck set blocks two
   * players and everything that depends on it.
   */
  app.get(
    "/tournament/:id/pending-reports",
    {
      id: "pending-reports",
      summary: "Disputed and stale reports",
      description:
        "What needs a person: disputed sets (with each side's evidence) and sets whose report has waited longer than the grace period. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: TournamentParam },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const id = c.req.param("id");
      const [tournament] = await db
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, id))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);

      const openMatches = await db
        .select()
        .from(matches)
        .where(and(eq(matches.tournamentId, id), isNull(matches.winnerId)));

      const now = new Date();
      const disputed: unknown[] = [];
      const stale: unknown[] = [];

      for (const match of openMatches) {
        const reports = await reportsOf(match.id);
        if (reports.length === 0) continue;

        const reconciliation = reconcileReports(
          { participants: [match.participant1Id, match.participant2Id] },
          reports
        );

        if (reconciliation.status === "disputed") {
          // With the EVIDENCE of each report. It is the reason this screen
          // works online: without it, it shows two contradictory versions and nothing
          // to decide with.
          const rows = await db
            .select({ id: matchReports.id, reportedBy: matchReports.reportedBy })
            .from(matchReports)
            .where(eq(matchReports.matchId, match.id));
          const byReport = await evidenceFor(rows.map((r) => r.id));

          disputed.push({
            matchId: match.id,
            bracketMatchId: match.bracketMatchId,
            reconciliation,
            reports,
            evidence: rows.map((r) => ({
              reportedBy: r.reportedBy,
              items: byReport.get(r.id) ?? [],
            })),
          });
        } else if (
          canAutoConfirm(
            reconciliation,
            reports[reports.length - 1].createdAt,
            now,
            tournament.reportGraceMinutes
          )
        ) {
          stale.push({ matchId: match.id, bracketMatchId: match.bracketMatchId, reconciliation });
        }
      }

      return c.json({ disputed, stale, graceMinutes: tournament.reportGraceMinutes });
    }
  );

  /**
   * The TO signs a result.
   *
   * It is recorded as a `byStaff` report: in a complaint, "both
   * agreed" and "the organization decided" are not the same thing, and
   * without that mark they cannot be told apart three months later.
   */
  app.post(
    "/match/:matchId/resolve",
    {
      id: "sign-result",
      summary: "Decide a set result (staff)",
      description:
        "The organization signs the result of a set (recorded as a staff report) and advances the bracket. `winnerId` must be one of the two participants. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: ParamSet, body: ResultSignature.optional() },
      output: { schema: z.object({ resolved: z.literal(true), winnerId: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const loaded = await loadMatch(c.req.param("matchId"));
      if (!loaded) return c.json({ error: "Match not found" }, 404);
      const { match, tournament } = loaded;

      const body = (await c.req.json().catch(() => ({}))) as {
        winnerId?: string;
        scores?: [number, number];
      };
      if (!body.winnerId) return c.json({ error: "`winnerId` is missing" }, 400);

      if (body.winnerId !== match.participant1Id && body.winnerId !== match.participant2Id) {
        return c.json({ error: "The winner must be one of the two participants." }, 400);
      }

      await db.insert(matchReports).values({
        matchId: match.id,
        reportedBy: body.winnerId,
        winnerId: body.winnerId,
        score1: body.scores?.[0] ?? null,
        score2: body.scores?.[1] ?? null,
        byStaff: true,
      });

      try {
        await applyAgreed(tournament, match, body.winnerId, body.scores ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not advance the bracket";
        return c.json({ error: message }, 400);
      }

      return c.json({ resolved: true, winnerId: body.winnerId });
    }
  );

  return app.ops;
}
