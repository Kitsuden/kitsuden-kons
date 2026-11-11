/**
 * Esports Module — Dependency Injection Wrapper
 *
 * All routes refactored to use KonContext for DI
 */

import {
  messageOf,
  eqEnum,
  can,
  operationsRouter,
  withSavepoint,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq, and, desc, ilike, sql, asc, ne, isNull, gt, inArray, lte } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import {
  createBracket,
  seedParticipants,
  getStandings,
  isComplete,
  playableMatches,
  type Bracket,
  type BracketFormat,
  type SeedMethod,
} from "./bracket";
import { applyResult, loadBracket, persistBracket } from "./bracket.persistence";
import type { CustomFieldDefinition } from "./custom-fields";
import type { EsportsDb } from "./esports.db";
import "./esports.policy.js";
import {
  tournaments,
  tournamentParticipants,
  players,
  teams,
  matches,
  proMatches,
  playersToTeams,
  bracketFormatEnum,
  seedMethodEnum,
  tournamentFormatEnum,
  tournamentStatusEnum,
} from "./esports.schema";
import {
  Deleted,
  Row,
  Rows,
  Obj,
  ParamId,
  TournamentParam,
  ParamTournamentId,
  ParticipantParam,
  withData,
  query,
  text,
} from "./schemas";
import { importOperations } from "./importers/import.routes";
import { leaderboardOperations } from "./leaderboard";
import { onlineOperations } from "./online.routes";
import { KON_ID, ORGANIZATION_ONLY, registry } from "./operations";
import { participantForViewer } from "./participant-privacy";
import { phasesOperations } from "./phases.routes";
import { registrationOperations } from "./registration.routes";
import { createRoundRobin, isRoundRobinComplete, roundRobinStandings } from "./roundrobin";
import { applyRoundRobinResult, loadRoundRobin, persistRoundRobin } from "./roundrobin.persistence";
import { recommendedRounds, swissCut } from "./swiss";
import { generateSwissRound, loadSwissState } from "./swiss.persistence";
import { withHiddenDrafts } from "./hidden-drafts";
import { withValidatedIds } from "./valid-ids";

/** Copy of `body` with only the allowed keys. */
function fieldsOnly(body: unknown, allowedOnes: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!body || typeof body !== "object") return out;
  for (const key of allowedOnes) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      out[key] = (body as Record<string, unknown>)[key];
    }
  }
  return out;
}

const PLAYER_FIELDS = [
  "alias",
  "country",
  "avatarId",
  "bio",
  "socialLinks",
  "coreUserId",
] as const;
const TEAM_FIELDS = ["name", "captainId"] as const;

/**
 * Create Players router with DI
 */
/**
 * What leaves a player or team toward someone who is NOT part of the organization:
 * without the account ids (`coreUserId`, `createdByUserId`). They linked a public
 * alias to the internal account (an earlier audit).
 */
function withoutAccountIds<T>(rowValue: T): T {
  if (!rowValue || typeof rowValue !== "object") return rowValue;
  const {
    coreUserId: _account,
    createdByUserId: _creator,
    ...rest
  } = rowValue as Record<string, unknown>;
  return rest as T;
}

async function seesAccountIds(c: { get: (k: string) => unknown }): Promise<boolean> {
  return can((c.get("user") ?? null) as AuthzUser | null, "manage", {}, "esports");
}

/**
 * What is written for a player. `passthrough`: the route has always ignored
 * what it does not know (the panel sends the whole row when editing), and closing it now
 * would break whoever already uses it. What is declared is validated: before, a wrong
 * type reached the column and came out as a 500.
 */
const NewPlayer = z
  .object({
    alias: z.string().min(1).max(200),
    /** Alpha-2; anything else is stored as nothing. */
    country: z.string().max(20).nullable().optional(),
    avatarId: z.guid().nullable().optional(),
    bio: z.string().max(20_000).nullable().optional(),
    socialLinks: z.unknown().optional().describe("Object of links; stored as JSON"),
    coreUserId: z.guid().nullable().optional(),
  })
  .passthrough();
const PlayerEdit = NewPlayer.partial()
  .extend({ avatarUrl: z.guid().nullable().optional().describe("Alias of avatarId") })
  .passthrough();

const NewTeam = z
  .object({
    name: z.string().min(1).max(200),
    logoId: z.guid().nullable().optional(),
    captainId: z.guid().nullable().optional(),
    memberIds: z.array(z.guid()).max(200).optional().describe("Player ids of the roster"),
  })
  .passthrough();
const TeamEdit = NewTeam.partial()
  .extend({ logoUrl: z.guid().nullable().optional().describe("Alias of logoId") })
  .passthrough();

function playersOperations(ctx: KonContext): AnyOperation[] {
  const app = registry("/players");
  const { db: rawDb } = ctx;
  // Narrowing the contract's `any` to the kon's schema gives
  // inference back to all the queries below.
  const db = { ...rawDb, instance: rawDb.instance as EsportsDb };

  // List Players
  app.get(
    "/",
    {
      id: "list-players",
      summary: "List players",
      description:
        "Up to 500 players, newest first, optionally filtered by alias (`search`). Account ids are left out unless you are tournament staff.",
      access: "optional",
      input: { query: query({ search: text("Text in the alias") }) },
      output: { schema: Rows },
    },
    async (c) => {
      const search = c.req.query("search");
      let query = db.instance.select().from(players).orderBy(desc(players.createdAt));

      if (search) {
        query = db.instance
          .select()
          .from(players)
          .where(ilike(players.alias, `%${search}%`))
          .orderBy(desc(players.createdAt)) as any;
      }

      // With a cap (it was the whole table) and without account ids outside the organization
      const results = await (query as typeof query).limit(500);
      return c.json((await seesAccountIds(c)) ? results : results.map(withoutAccountIds));
    }
  );

  // Get Player by ID
  app.get(
    "/:id",
    {
      id: "get-player",
      summary: "Read a player",
      description: "The player and the teams they belong to.",
      access: "optional",
      input: { params: ParamId },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { id } = c.req.param();
      const [player] = await db.instance.select().from(players).where(eq(players.id, id)).limit(1);

      if (!player) return c.json({ error: "Player not found" }, 404);

      const playerTeams = await db.instance
        .select({ team: teams })
        .from(playersToTeams)
        .innerJoin(teams, eq(playersToTeams.teamId, teams.id))
        .where(eq(playersToTeams.playerId, id));

      const ve = await seesAccountIds(c);
      const outside = <T>(x: T) => (ve ? x : withoutAccountIds(x));
      return c.json({ ...outside(player), teams: playerTeams.map((r) => outside(r.team)) });
    }
  );

  // Create Player
  app.post(
    "/",
    {
      id: "create-player",
      summary: "Create a player",
      description:
        "Creates a player profile (alias required; country as ISO alpha-2). Tournament staff only. To enter it in a tournament, use register-participant with the returned id.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { body: NewPlayer },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const body: any = await c.req.json();
      const [player] = await db.instance
        .insert(players)
        .values({
          alias: body.alias,
          // Alpha-2 in uppercase; anything else is discarded instead of
          // storing data the flag will not be able to derive.
          country: /^[A-Za-z]{2}$/.test(body.country ?? "") ? body.country.toUpperCase() : null,
          avatarId: body.avatarId,
          bio: body.bio,
          socialLinks: body.socialLinks ? JSON.stringify(body.socialLinks) : null,
          coreUserId: body.coreUserId,
        })
        .returning();
      return c.json(player, 201);
    }
  );

  // Update Player
  app.patch(
    "/:id",
    {
      id: "update-player",
      summary: "Edit a player",
      description:
        "Updates the editable fields of a player (alias, country, avatar, bio, links, account). Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: ParamId, body: PlayerEdit },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { id } = c.req.param();
      const body: any = await c.req.json();
      // Only editable columns: `...body` allowed rewriting `id`, `createdAt`
      // or the external identity (`externalSource`/`externalId`) that matches imports.
      const updates: any = { ...fieldsOnly(body, PLAYER_FIELDS), updatedAt: new Date() };
      // The country is normalized the same as at creation: uppercase alpha-2 or nothing.
      if (body.country !== undefined) {
        updates.country = /^[A-Za-z]{2}$/.test(body.country ?? "")
          ? body.country.toUpperCase()
          : null;
      }
      if (body.avatarUrl !== undefined) {
        updates.avatarId = body.avatarUrl;
        delete updates.avatarUrl;
      }
      if (body.socialLinks && typeof body.socialLinks === "object") {
        updates.socialLinks = JSON.stringify(body.socialLinks);
      }
      const [updated] = await db.instance
        .update(players)
        .set(updates)
        .where(eq(players.id, id))
        .returning();
      if (!updated) return c.json({ error: "Player not found" }, 404);
      return c.json(updated);
    }
  );

  // Delete Player
  app.delete(
    "/:id",
    {
      id: "delete-player",
      summary: "Delete a player",
      description:
        "Deletes a player. 409 if a tournament still references them. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: ParamId },
      output: { schema: Deleted },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { id } = c.req.param();
      const [deleted] = await db.instance
        .delete(players)
        .where(eq(players.id, id))
        .returning({ id: players.id });
      if (!deleted) return c.json({ error: "Player not found" }, 404);
      return c.json({ deleted: true, id: deleted.id });
    }
  );

  return app.ops;
}

/**
 * Create Teams router with DI
 */
function teamsOperations(ctx: KonContext): AnyOperation[] {
  const app = registry("/teams");
  const { db: rawDb } = ctx;
  // Narrowing the contract's `any` to the kon's schema gives
  // inference back to all the queries below.
  const db = { ...rawDb, instance: rawDb.instance as EsportsDb };

  // List Teams
  app.get(
    "/",
    {
      id: "list-teams",
      summary: "List teams",
      description:
        "Up to 500 teams, newest first, optionally filtered by name (`search`). Account ids are left out unless you are tournament staff.",
      access: "optional",
      input: { query: query({ search: text("Text in the team name") }) },
      output: { schema: Rows },
    },
    async (c) => {
      const search = c.req.query("search");
      let query = db.instance.select().from(teams).orderBy(desc(teams.createdAt));
      if (search) {
        query = db.instance
          .select()
          .from(teams)
          .where(ilike(teams.name, `%${search}%`))
          .orderBy(desc(teams.createdAt)) as any;
      }
      const results = await (query as typeof query).limit(500);
      return c.json((await seesAccountIds(c)) ? results : results.map(withoutAccountIds));
    }
  );

  // Get Team by ID
  app.get(
    "/:id",
    {
      id: "get-team",
      summary: "Read a team",
      description: "The team with its captain and members.",
      access: "optional",
      input: { params: ParamId },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { id } = c.req.param();
      const [team] = await db.instance.select().from(teams).where(eq(teams.id, id)).limit(1);
      if (!team) return c.json({ error: "Team not found" }, 404);

      const membersData = await db.instance
        .select({ player: players })
        .from(playersToTeams)
        .innerJoin(players, eq(playersToTeams.playerId, players.id))
        .where(eq(playersToTeams.teamId, team.id));

      let captain = null;
      if (team.captainId) {
        const [captainData] = await db.instance
          .select()
          .from(players)
          .where(eq(players.id, team.captainId))
          .limit(1);
        captain = captainData || null;
      }

      const ve = await seesAccountIds(c);
      const outside = <T>(x: T) => (ve ? x : withoutAccountIds(x));
      return c.json({
        ...outside(team),
        captain: outside(captain),
        members: membersData.map((m) => outside(m.player)),
      });
    }
  );

  // Create Team
  app.post(
    "/",
    {
      id: "create-team",
      summary: "Create a team",
      description:
        "Creates a team (name required) with an optional captain and roster (`memberIds`: player ids). Tournament staff only; players create their own with create-my-team.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { body: NewTeam },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const body: any = await c.req.json();
      const [team] = await db.instance
        .insert(teams)
        .values({ name: body.name, logoId: body.logoId, captainId: body.captainId })
        .returning();

      if (body.memberIds && Array.isArray(body.memberIds) && body.memberIds.length > 0) {
        await db.instance
          .insert(playersToTeams)
          .values(body.memberIds.map((playerId: string) => ({ teamId: team.id, playerId })));
      }
      return c.json(team, 201);
    }
  );

  // Update Team
  app.patch(
    "/:id",
    {
      id: "update-team",
      summary: "Edit a team",
      description:
        "Updates name, captain or logo. `memberIds`, when sent, REPLACES the whole roster. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: ParamId, body: TeamEdit },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { id } = c.req.param();
      const body: any = await c.req.json();
      const { memberIds, logoUrl, logoId } = body;
      // Same as in players: only what is editable, not `id` or the external identity.
      const updates: any = fieldsOnly(body, TEAM_FIELDS);
      if (logoUrl !== undefined || logoId !== undefined) {
        updates.logoId = logoId ?? logoUrl;
      }
      const [updated] = await db.instance
        .update(teams)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(teams.id, id))
        .returning();
      if (!updated) return c.json({ error: "Team not found" }, 404);

      if (memberIds !== undefined) {
        await db.instance.delete(playersToTeams).where(eq(playersToTeams.teamId, id));
        if (memberIds.length > 0) {
          await db.instance
            .insert(playersToTeams)
            .values(memberIds.map((playerId: string) => ({ teamId: id, playerId })));
        }
      }
      return c.json(updated);
    }
  );

  // Delete Team
  app.delete(
    "/:id",
    {
      id: "delete-team",
      summary: "Delete a team",
      description:
        "Deletes a team. 409 if a tournament still references it. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: ParamId },
      output: { schema: Deleted },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { id } = c.req.param();
      const [deleted] = await db.instance
        .delete(teams)
        .where(eq(teams.id, id))
        .returning({ id: teams.id });
      if (!deleted) return c.json({ error: "Team not found" }, 404);
      return c.json({ deleted: true, id: deleted.id });
    }
  );

  return app.ops;
}

/**
 * Create Tournaments router with DI
 */
/**
 * Tournament fields that can be written through the API.
 *
 * ── WHAT THERE WAS ─────────────────────────────────────────────────────────
 *
 * Create read `body: any` and did not allow setting the bracket format: a Swiss
 * was born as single elimination and had to be fixed afterwards. And edit did
 * `.set({ ...body })`: any column was writable —`championId`,
 * `externalId`—, and a typo like `swissRound` was discarded without warning.
 *
 * The enums come from the database schema so they cannot drift from it.
 */
const TournamentFields = z.object({
  title: z.string().min(1).max(200),
  /** Game from `kon-games`. Without it a local id is generated: the column does not allow nulls. */
  gameId: z.guid(),
  format: z.enum(tournamentFormatEnum.enumValues),
  maxParticipants: z.number().int().min(2).max(4096),
  status: z.enum(tournamentStatusEnum.enumValues),
  bracketFormat: z.enum(bracketFormatEnum.enumValues),
  seedMethod: z.enum(seedMethodEnum.enumValues),
  /** Swiss only. Without it the recommendation by number of players is used. */
  swissRounds: z.number().int().min(1).max(20),
  rulesText: z.string().max(20_000),
  /**
   * Public registration (phase D). No route wrote these
   * fields: the tournament was born `closed` and public registration was only opened
   * by touching the database. See tests/unit/esports-registration-by-api.test.ts.
   */
  registrationMode: z.enum(["closed", "open", "approval"]),
  registrationOpensAt: z.coerce.date().nullable(),
  registrationClosesAt: z.coerce.date().nullable(),
  waitlistEnabled: z.boolean(),
  requiresRulesAcceptance: z.boolean(),
  /** 1v1 only: in teams the account is mandatory and this is not consulted. */
  allowGuestRegistration: z.boolean(),
  /** 0 = an unconfirmed report is never accepted on its own. Maximum one week. */
  reportGraceMinutes: z.number().int().min(0).max(10_080),
  requiresEvidence: z.boolean(),
  minRosterSize: z.number().int().min(1).max(100).nullable(),
  maxRosterSize: z.number().int().min(1).max(100).nullable(),
});

type PartialFields = Partial<z.infer<typeof TournamentFields>>;

/** What cannot be seen field by field: a reversed window, an impossible roster. */
function consistent(t: PartialFields, ctx: z.RefinementCtx): void {
  if (
    t.registrationOpensAt &&
    t.registrationClosesAt &&
    t.registrationOpensAt >= t.registrationClosesAt
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["registrationClosesAt"],
      message: "registrationClosesAt must be later than registrationOpensAt",
    });
  }
  if (t.minRosterSize && t.maxRosterSize && t.minRosterSize > t.maxRosterSize) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxRosterSize"],
      message: "maxRosterSize cannot be less than minRosterSize",
    });
  }
}

const CreateTournament = TournamentFields.partial()
  .extend({ title: TournamentFields.shape.title })
  .superRefine(consistent);
const UpdateTournament = TournamentFields.partial().superRefine(consistent);

/** Registration by the organization: a player (1v1) or a team (Team). */
const RegisterParticipant = z
  .object({
    playerId: z.guid().optional().describe("For 1v1 tournaments"),
    teamId: z.guid().optional().describe("For Team tournaments"),
  })
  .passthrough();

function tournamentsOperations(ctx: KonContext): AnyOperation[] {
  const app = registry("/tournaments");
  const { db: rawDb } = ctx;
  // Narrowing the contract's `any` to the kon's schema gives
  // inference back to all the queries below.
  const db = { ...rawDb, instance: rawDb.instance as EsportsDb };

  // List Tournaments
  //
  // `optionalAuth` and not `requireAuth`: the list is public. But without it the
  // session does not reach here, and `can(...)` always decides on a null
  // user: the organization could not see its own drafts or ask for
  // `?status=Draft` either. It fails closed, which is safe, but left the panel with no
  // way to list what it has not yet announced.
  app.get(
    "/",
    {
      id: "list-tournaments",
      summary: "List tournaments",
      description:
        "Newest first, at most `limit` (default 50, max 200), filtered by text in the title. Drafts only for tournament staff (`status` filters by state for them; the public never sees Draft). Includes the approved participant count, dates and prize pool.",
      access: "optional",
      input: {
        query: query({
          search: text("Text in the title"),
          status: text("Draft | Open | InProgress | Completed … (staff only)"),
          limit: text("1-200, default 50"),
        }),
      },
      output: { schema: Rows },
    },
    async (c) => {
      const search = c.req.query("search");
      const status = c.req.query("status");
      /**
       * `?limit=` was REQUESTED and ignored: the public site sent `limit=50` and
       * received the whole table. With a history of several years that is a
       * response that grows by itself. Hard cap of 200 so the parameter is not
       * a way to ask for the whole database.
       */
      const request = Number.parseInt(c.req.query("limit") ?? "", 10);
      const limit = Number.isFinite(request) && request > 0 ? Math.min(request, 200) : 50;
      // Conditions accumulate and `.where()` is called ONCE.
      //
      // Before there were two chained `.where()`, which in Drizzle do not add up: the
      // second replaces the first. With `?search=x&status=open` the text was
      // ignored and the whole tournament came out by status. The `as any` casts that were
      // needed to chain after `.orderBy()` are also no longer needed.
      const conditions = [];
      if (search) conditions.push(ilike(tournaments.title, `%${search}%`));
      // `eqEnum` returns undefined if the value does not belong to the enum.
      /**
       * ── STATUS IS NEGOTIATED WITH THE ASKER ────────────────────────────────
       *
       * Before, this used `?status=` as is, so `?status=Draft` returned
       * all the half-built tournaments to anyone: title, rules, prize and
       * dates before announcing them.
       *
       * Now whoever is not part of the organization only sees what is NOT a draft, whatever
       * they ask for. It is not a 403: the right response to "give me the drafts"
       * from outside is the public list, not confirming that they exist.
       */
      const canViewDrafts = await can(
        (c.get("user") ?? null) as AuthzUser | null,
        "view",
        { status: "Draft" },
        "esports"
      );

      const requestedStatus = canViewDrafts ? status : undefined;
      const filter272 = eqEnum(tournaments.status, requestedStatus);
      const hideDrafts = canViewDrafts ? undefined : ne(tournaments.status, "Draft");
      if (filter272) conditions.push(filter272);
      if (hideDrafts) conditions.push(hideDrafts);

      /**
       * ── WHAT THE PUBLIC SITE NEEDS TO SEE ──────────────────────────────────
       *
       * This list served eight columns: no dates, no prize, no taken
       * spots. The tournaments page drew "Spots", "Prize" and "Closes"
       * with fields that never arrived, so they always came out empty —and the
       * link to the imported tournament, never.
       *
       * What is PUBLISHABLE is added. What belongs to the panel stays out: rules,
       * custom fields, draw seed and sync marks.
       *
       * `registrants` counts only the APPROVED: a pending one does not yet take
       * a spot, and showing it as taken would make someone not sign up for a
       * tournament where there was room.
       */
      /**
       * ── WHY IT IS HAND-WRITTEN AND NOT WITH ${columns} ─────────────────────
       *
       * Interpolating Drizzle columns, the subquery comes out UNQUALIFIED:
       *
       *   where "tournament_id" = "id" and "status" = 'Approved'
       *
       * Inside the subselect the three names resolve against the INNER table,
       * so the condition ends up being `p.tournament_id = p.id`:
       * never true, no error, and **zero registrants in every tournament**.
       * A zero is a believable answer —a newly opened tournament has nobody—,
       * so it is not noticed by looking at the screen.
       *
       * With alias `p` and the outer table fully named, the correlation is
       * explicit and does not depend on how Drizzle decides to qualify.
       */
      const registered = sql<number>`(
      select count(*)::int
      from "esports_tournament_participants" "p"
      where "p"."tournament_id" = "esports_tournaments"."id"
        and "p"."status" = 'Approved'
    )`;

      const results = await db.instance
        .select({
          id: tournaments.id,
          title: tournaments.title,
          gameId: tournaments.gameId,
          format: tournaments.format,
          bracketFormat: tournaments.bracketFormat,
          maxParticipants: tournaments.maxParticipants,
          participantCount: registered,
          status: tournaments.status,
          registrationMode: tournaments.registrationMode,
          registrationOpensAt: tournaments.registrationOpensAt,
          registrationClosesAt: tournaments.registrationClosesAt,
          checkInOpensAt: tournaments.checkInOpensAt,
          minRosterSize: tournaments.minRosterSize,
          maxRosterSize: tournaments.maxRosterSize,
          prizePoolCents: tournaments.prizePoolCents,
          prizePoolCurrency: tournaments.prizePoolCurrency,
          externalUrl: tournaments.externalUrl,
          createdAt: tournaments.createdAt,
          updatedAt: tournaments.updatedAt,
        })
        .from(tournaments)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(tournaments.createdAt))
        .limit(limit);

      return c.json(results);
    }
  );

  // Create Tournament
  app.post(
    "/",
    {
      id: "create-tournament",
      summary: "Create a tournament",
      description:
        "Born in `Draft` unless `status` says otherwise: registering needs `Open`. `bracketFormat` decides the pairing: `swiss` pairs round by round. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { body: CreateTournament },
      output: { status: 201, schema: Row },
    },
    async (c, input) => {
      const body = input.body as z.infer<typeof CreateTournament>;
      const [tournament] = await db.instance
        .insert(tournaments)
        .values({
          title: body.title,
          // Without `kon-games` there is no game to point at, and the column does not allow
          // nulls nor has a foreign key: a local id is generated.
          gameId: body.gameId ?? globalThis.crypto.randomUUID(),
          format: body.format ?? "1v1",
          maxParticipants: body.maxParticipants ?? 64,
          status: body.status ?? "Draft",
          bracketFormat: body.bracketFormat ?? "single_elimination",
          seedMethod: body.seedMethod ?? "as_entered",
          swissRounds: body.swissRounds ?? null,
          rulesText: body.rulesText ?? null,
          // Without a value, the database default (`closed`, no waiting list…).
          ...(body.registrationMode !== undefined && { registrationMode: body.registrationMode }),
          ...(body.registrationOpensAt !== undefined && {
            registrationOpensAt: body.registrationOpensAt,
          }),
          ...(body.registrationClosesAt !== undefined && {
            registrationClosesAt: body.registrationClosesAt,
          }),
          ...(body.waitlistEnabled !== undefined && { waitlistEnabled: body.waitlistEnabled }),
          ...(body.requiresRulesAcceptance !== undefined && {
            requiresRulesAcceptance: body.requiresRulesAcceptance,
          }),
          ...(body.allowGuestRegistration !== undefined && {
            allowGuestRegistration: body.allowGuestRegistration,
          }),
          ...(body.reportGraceMinutes !== undefined && {
            reportGraceMinutes: body.reportGraceMinutes,
          }),
          ...(body.requiresEvidence !== undefined && { requiresEvidence: body.requiresEvidence }),
          ...(body.minRosterSize !== undefined && { minRosterSize: body.minRosterSize }),
          ...(body.maxRosterSize !== undefined && { maxRosterSize: body.maxRosterSize }),
        })
        .returning();
      return c.json(tournament, 201);
    }
  );

  // Register Participant
  app.post(
    "/:id/register",
    {
      id: "register-participant",
      summary: "Register a participant (staff)",
      description:
        "Enters a player (1v1, `playerId`) or a team (Team, `teamId`) in an Open tournament, already Approved. Returns the participant row: its `id` is the participantId used for check-in and reporting. Tournament staff only; players sign up themselves with `register-me` (`POST /api/esports/public/tournament/:id/register`).",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: TournamentParam, body: RegisterParticipant },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { id } = c.req.param();
      const body: any = await c.req.json();
      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, id))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);
      if (tournament.status !== "Open") {
        return c.json(
          { error: `Tournament is currently ${tournament.status}, inscriptions are closed.` },
          400
        );
      }

      const [{ count }] = await db.instance
        .select({ count: sql<number>`count(*)` })
        .from(tournamentParticipants)
        .where(eq(tournamentParticipants.tournamentId, id));

      if (Number(count) >= tournament.maxParticipants) {
        return c.json({ error: "Tournament has reached max participants." }, 400);
      }

      if (tournament.format === "1v1" && !body.playerId) {
        return c.json({ error: "playerId is required for 1v1 tournaments" }, 400);
      }
      if (tournament.format === "Team" && !body.teamId) {
        return c.json({ error: "teamId is required for Team tournaments" }, 400);
      }

      try {
        // In a SAVEPOINT: a repeated registration (or a player that does not exist) is answered
        // with 400 below, and without a savepoint that SQL error would leave the request's
        // transaction aborted (rule 2 of the kon SDK).
        const [participant] = await withSavepoint(async () =>
          db.instance
            .insert(tournamentParticipants)
            .values({
              tournamentId: id,
              playerId: body.playerId || null,
              teamId: body.teamId || null,
              // The STAFF registers on purpose: it enters approved. Generating the bracket
              // only seeds the approved (an earlier audit), and with
              // "Pending" what the staff (or their agent via MCP) added never
              // reached the bracket. Public registrations keep their plan.
              status: "Approved",
            })
            .returning()
        );
        return c.json(participant, 201);
      } catch (error: unknown) {
        return c.json(
          {
            error: "Failed to register. You may already be registered.",
            details: messageOf(error),
          },
          400
        );
      }
    }
  );

  // Get Tournament by ID
  app.get(
    "/:id",
    {
      id: "get-tournament",
      summary: "Read a tournament",
      description:
        "The tournament with its participants (player/team attached). Contact data and private answers only for tournament staff. A draft is a 404 from outside.",
      access: "optional",
      input: { params: ParamId },
      output: { schema: Row },
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

      /**
       * A draft tournament does not exist for anyone outside the organization.
       *
       * **404 and not 403**: a 403 confirms the tournament exists, and with that
       * the schedule can be guessed by trying ids. From outside, a draft has to
       * be indistinguishable from something that was not created.
       */
      if (
        !(await can(
          (c.get("user") ?? null) as AuthzUser | null,
          "view",
          { status: tournament.status },
          "esports"
        ))
      ) {
        return c.json({ error: "Tournament not found" }, 404);
      }

      const participantsData = await db.instance
        .select({ participant: tournamentParticipants, player: players, team: teams })
        .from(tournamentParticipants)
        .leftJoin(players, eq(tournamentParticipants.playerId, players.id))
        .leftJoin(teams, eq(tournamentParticipants.teamId, teams.id))
        .where(eq(tournamentParticipants.tournamentId, id));

      /**
       * The list of registrants is public; their emails, contact handles,
       * accounts and private answers are not. This route has no mandatory session
       * and returned the ENTIRE row of each participant. See `participant-privacy.ts`.
       */
      const staff = await can((c.get("user") ?? null) as AuthzUser | null, "manage", {}, "esports");
      const fields = (tournament.customFields ?? []) as CustomFieldDefinition[];

      return c.json({
        ...tournament,
        participants: participantsData.map((p) => ({
          ...participantForViewer(p.participant, fields, staff),
          player: staff ? p.player || null : withoutAccountIds(p.player || null),
          team: staff ? p.team || null : withoutAccountIds(p.team || null),
        })),
      });
    }
  );

  // Update Tournament
  app.patch(
    "/:id",
    {
      id: "update-tournament",
      summary: "Edit a tournament",
      description:
        "Updates the writable fields (status, formats, registration window and rules, roster sizes…). Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: ParamId, body: UpdateTournament },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const { id } = c.req.param();
      // Only the schema's fields: before, `...body` allowed writing any column.
      const body = input.body as z.infer<typeof UpdateTournament>;
      const [updated] = await db.instance
        .update(tournaments)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(tournaments.id, id))
        .returning();
      if (!updated) return c.json({ error: "Tournament not found" }, 404);
      return c.json(updated);
    }
  );

  // Delete Tournament
  app.delete(
    "/:id",
    {
      id: "delete-tournament",
      summary: "Delete a tournament",
      description: "Deletes a tournament. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: ParamId },
      output: { schema: Deleted },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { id } = c.req.param();
      const [deleted] = await db.instance
        .delete(tournaments)
        .where(eq(tournaments.id, id))
        .returning({ id: tournaments.id });
      if (!deleted) return c.json({ error: "Tournament not found" }, 404);
      return c.json({ deleted: true, id: deleted.id });
    }
  );

  return app.ops;
}

/**
 * Create Matches router with DI
 */
/**
 * Body of `POST /matches/tournament/:tournamentId/report`.
 *
 * Before it was read with an `as {...}` over `c.req.json()`. A `winner` instead of
 * `winnerId` gave "winnerId is required", but a misspelled `participant1score` was
 * lost without warning and the score stayed at 0. With a schema, an unknown
 * field answers 422 saying which one was right — which is what an agent
 * needs to correct itself.
 */
const ReportResult = z
  .object({
    /** Row of `esports_matches`. The most reliable: with phases, the engine id repeats. */
    matchId: z.string().min(1).optional(),
    /** Engine id: `W2M1` in elimination; the one the pairer returns in Swiss. */
    bracketMatchId: z.string().min(1).optional(),
    /** PARTICIPANT id (`esports_tournament_participants`), not player. */
    winnerId: z.string().min(1),
    dqId: z.string().min(1).optional(),
    eliminate: z.boolean().optional(),
    participant1Score: z.number().int().min(0).optional(),
    participant2Score: z.number().int().min(0).optional(),
  })
  .refine((b) => Boolean(b.matchId || b.bracketMatchId), {
    message: "`matchId` (the set's row) or `bracketMatchId` (the engine id) is required.",
    path: ["matchId"],
  });

/**
 * Link drawn on the front page: http(s) only. A `javascript:` in a crest
 * or in the stream link is XSS served on the most visited page.
 */
const WebLink = z
  .string()
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v.trim()), { message: "Only http(s) links" });

/** What can be written for a scene match. Nothing more. */
const SceneMatch = z
  .object({
    gameId: z.guid().nullable().optional(),
    gameName: z.string().min(1).max(120),
    event: z.string().max(200).nullable().optional(),
    teamOne: z.string().min(1).max(160),
    teamTwo: z.string().min(1).max(160),
    logoOne: WebLink.nullable().optional(),
    logoTwo: WebLink.nullable().optional(),
    /** Any date that `Date` understands; the column stores the instant. */
    scheduledAt: z
      .string()
      .max(40)
      .refine((v) => !Number.isNaN(Date.parse(v)), { message: "Invalid date" })
      .nullable()
      .optional(),
    status: z.enum(["scheduled", "live", "finished", "cancelled"]).optional(),
    scoreOne: z.number().int().min(0).max(999).nullable().optional(),
    scoreTwo: z.number().int().min(0).max(999).nullable().optional(),
    bestOf: z.number().int().min(1).max(99).nullable().optional(),
    streamUrl: WebLink.nullable().optional(),
    source: z.string().max(60).nullable().optional(),
    externalId: z.string().max(120).nullable().optional(),
    externalUrl: WebLink.nullable().optional(),
  })
  // Strict: a key outside the list (`id`, `createdAt`) is a 422, not
  // something silently discarded or, worse, written.
  .strict();
const EditSceneMatch = SceneMatch.partial().strict();

/**
 * Scene matches: those of OTHER teams
 * ============================================================================
 *
 * These are NOT our tournaments. This feeds the esports blog panel
 * —"today G2 plays Fnatic"—, and that is why it lives in its own table
 * with a real time. See `proMatches` in the schema.
 *
 * ── WHO CAN DO WHAT ────────────────────────────────────────────────────────
 *
 * Read, anyone: it is the blog's public calendar. Write, only the
 * organization (`editScene` policy): a calendar anyone can fill in is a bulletin
 * board, and this one appears on the front page.
 */
function proMatchesOperations(ctx: KonContext): AnyOperation[] {
  const app = registry("/pro-matches");
  const { db: rawDb } = ctx;
  const db = { ...rawDb, instance: rawDb.instance as EsportsDb };

  const STATUSES = ["scheduled", "live", "finished", "cancelled"] as const;
  type Status = (typeof STATUSES)[number];
  const isStatus = (v: string): v is Status => (STATUSES as readonly string[]).includes(v);

  /**
   * The public calendar.
   *
   *   ?status=live,scheduled   the ones the panel cares about (default)
   *   ?game=<name>             a specific game
   *   ?days=7                  up to N days ahead
   *   ?order=recent            most recent first (for RESULTS)
   */
  app.get(
    "/",
    {
      id: "list-scene-matches",
      summary: "List scene matches (the blog calendar)",
      description:
        "Matches of OTHER teams for the esports blog calendar (not our tournaments). By default live and scheduled, live first then by time; `order=recent` for results (newest first). Filters: `status` (comma list), `game` (name), `days` ahead, `limit` (1-100, default 12).",
      access: "public",
      input: {
        query: query({
          limit: text("1-100, default 12"),
          status: text("Comma list of scheduled | live | finished | cancelled"),
          game: text("Game name"),
          days: text("Up to N days ahead"),
          order: text("`recent` = newest first"),
        }),
      },
      output: { schema: z.object({ docs: Rows, totalDocs: z.number().int() }) },
    },
    async (c) => {
      const limit = Math.min(Math.max(Number(c.req.query("limit")) || 12, 1), 100);
      const requests = (c.req.query("status") ?? "live,scheduled").split(",").map((e) => e.trim());
      const statuses = requests.filter(isStatus);
      const game = c.req.query("game");
      const days = Number(c.req.query("days"));
      /**
       * The calendar goes from soonest to farthest; results, the other way around.
       * With the usual order, "results" with `limit=8` returned the EIGHT
       * OLDEST in the table: the tab got stuck on the first month of data.
       */
      const recent = c.req.query("order") === "recent";

      const conditions = [];
      if (statuses.length > 0) conditions.push(inArray(proMatches.status, statuses));
      if (game) conditions.push(eq(proMatches.gameName, game));
      if (Number.isFinite(days) && days > 0) {
        conditions.push(lte(proMatches.scheduledAt, new Date(Date.now() + days * 86_400_000)));
      }

      const docs = await db.instance
        .select()
        .from(proMatches)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        /**
         * What is being played first, and then by time. A match with no
         * time goes to the end: it cannot sneak in ahead of those that have one.
         */
        .orderBy(
          ...(recent
            ? [sql`${proMatches.scheduledAt} desc nulls last`]
            : [desc(eq(proMatches.status, "live")), asc(proMatches.scheduledAt)])
        )
        .limit(limit);

      return c.json({ docs, totalDocs: docs.length });
    }
  );

  /**
   * ── WHO WRITES THE CALENDAR ────────────────────────────────────────────────
   *
   * Before, `requireAuth` was enough, and account sign-up is public: anyone
   * with a session could add, change or delete front page matches. A prefix
   * rule in `auth-guard.ts` covered for it; now the kon decides it with its
   * policy (`editScene`, organization only) and removing that rule opens
   * nothing.
   *
   * And the body is validated against a schema: `.values({...body})` allowed
   * writing `id`, `createdAt` or any column that came in.
   */
  // The policy is checked AFTER validating (as before the SDK) and with the
  // usual response: `h.can()` is `editScene` plus the SDK scopes.
  const EDIT_SCENE = {
    policy: { resource: "esports", action: "editScene", inHandler: true },
  } as const;

  app.post(
    "/",
    {
      id: "create-scene-match",
      summary: "Add a scene match",
      description:
        "Adds a match of other teams to the blog calendar (teams, game, time, score, links: http(s) only). Unknown fields are a 422. Organization only (esports:editScene).",
      access: "session",
      permission: EDIT_SCENE,
      input: { body: SceneMatch },
      output: { status: 201, schema: Row },
    },
    async (c, input, h) => {
      if (!(await h.can())) return c.json({ error: "Only the organization." }, 403);
      const bodyValue = input.body as z.infer<typeof SceneMatch>;
      const [rowValue] = await db.instance
        .insert(proMatches)
        .values({
          ...bodyValue,
          scheduledAt: bodyValue.scheduledAt ? new Date(bodyValue.scheduledAt) : null,
          status: isStatus(String(bodyValue.status)) ? bodyValue.status : "scheduled",
        })
        .returning();
      return c.json(rowValue, 201);
    }
  );

  app.patch(
    "/:id",
    {
      id: "update-scene-match",
      summary: "Edit a scene match",
      description:
        "Updates a calendar match (score, status, time…). Organization only (esports:editScene).",
      access: "session",
      permission: EDIT_SCENE,
      input: { params: ParamId, body: EditSceneMatch },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      if (!(await h.can())) return c.json({ error: "Only the organization." }, 403);
      const bodyValue = input.body as z.infer<typeof EditSceneMatch>;
      const { scheduledAt, ...rest } = bodyValue;
      const [rowValue] = await db.instance
        .update(proMatches)
        .set({
          ...rest,
          ...(scheduledAt !== undefined
            ? { scheduledAt: scheduledAt ? new Date(scheduledAt) : null }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(proMatches.id, c.req.param("id")))
        .returning();
      return rowValue ? c.json(rowValue) : c.json({ error: "Does not exist" }, 404);
    }
  );

  app.delete(
    "/:id",
    {
      id: "delete-scene-match",
      summary: "Delete a scene match",
      description: "Removes a match from the blog calendar. Organization only (esports:editScene).",
      access: "session",
      permission: EDIT_SCENE,
      input: { params: ParamId },
      output: { schema: z.object({ deleted: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, _input, h) => {
      if (!(await h.can())) return c.json({ error: "Only the organization." }, 403);
      const [rowValue] = await db.instance
        .delete(proMatches)
        .where(eq(proMatches.id, c.req.param("id")))
        .returning();
      return rowValue ? c.json({ deleted: rowValue.id }) : c.json({ error: "Does not exist" }, 404);
    }
  );

  return app.ops;
}

/** Optional body of generate: whatever is missing comes from the tournament. */
const GenerateBracket = z
  .object({
    format: z.enum(bracketFormatEnum.enumValues).optional(),
    seeding: z.enum(seedMethodEnum.enumValues).optional(),
    shuffleSeed: z.number().int().optional().describe("Seed of the draw (reproducible)"),
  })
  .passthrough();

/** Manual report of an elimination set (`PUT /matches/:id`). */
const ManualReport = z
  .object({
    participant1Score: z.number().int().min(0).optional(),
    participant2Score: z.number().int().min(0).optional(),
    winnerId: z.guid().optional().describe("Participant id of the winner"),
  })
  .passthrough();

function matchesOperations(ctx: KonContext): AnyOperation[] {
  const app = registry("/matches");
  const { db: rawDb } = ctx;
  // Narrowing the contract's `any` to the kon's schema gives
  // inference back to all the queries below.
  const db = { ...rawDb, instance: rawDb.instance as EsportsDb };

  // GET All Matches
  app.get(
    "/",
    {
      id: "list-sets",
      summary: "List sets",
      description:
        "Sets (rows of esports_matches) by round and order, optionally of one tournament. Sets of draft tournaments only for staff.",
      access: "optional",
      input: { query: query({ tournamentId: text("Tournament id") }) },
      output: { schema: Rows },
    },
    async (c) => {
      const tournamentId = c.req.query("tournamentId");
      // A single condition, so there was no filter to lose here — but
      // chaining after `.orderBy()` forced an `as any` that turned off the
      // check right on the filter line. Same order as the route
      // below, without casts.
      // Without being able to see drafts, the matches of a draft tournament do not appear
      // (an earlier audit; see hidden-drafts.ts).
      const seesDrafts = await can(
        (c.get("user") ?? null) as AuthzUser | null,
        "view",
        { status: "Draft" },
        "esports"
      );
      const publicOnes = db.instance
        .select({ id: tournaments.id })
        .from(tournaments)
        .where(ne(tournaments.status, "Draft"));
      const results = await db.instance
        .select()
        .from(matches)
        .where(
          and(
            tournamentId ? eq(matches.tournamentId, tournamentId) : undefined,
            seesDrafts ? undefined : inArray(matches.tournamentId, publicOnes)
          )
        )
        .orderBy(asc(matches.round), asc(matches.matchOrder));
      return c.json(results);
    }
  );

  // GET Matches by Tournament
  app.get(
    "/tournament/:tournamentId",
    {
      id: "tournament-sets",
      summary: "Sets of a tournament",
      description:
        "Every set of the tournament by round and order (ids, participants, winner, status).",
      access: "public",
      input: { params: ParamTournamentId },
      output: { schema: Rows },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { tournamentId } = c.req.param();
      const results = await db.instance
        .select()
        .from(matches)
        .where(eq(matches.tournamentId, tournamentId))
        .orderBy(asc(matches.round), asc(matches.matchOrder));
      return c.json(results);
    }
  );

  // Get Match by ID with Participants
  app.get(
    "/:id",
    {
      id: "get-set",
      summary: "Read a set",
      description:
        "The set with its two participants and the winner (player/team attached; private data only for staff).",
      access: "optional",
      input: { params: ParamId },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { id } = c.req.param();
      const [match] = await db.instance.select().from(matches).where(eq(matches.id, id)).limit(1);
      if (!match) return c.json({ error: "Match not found" }, 404);

      // Public route: same rule as the tournament record. Without this, each set
      // published the email, handle and private answers of its two
      // participants (and of the winner).
      const user = (c.get("user") ?? null) as AuthzUser | null;
      const staff = await can(user, "manage", {}, "esports");
      const [tournamentOfSet] = await db.instance
        .select({ status: tournaments.status, customFields: tournaments.customFields })
        .from(tournaments)
        .where(eq(tournaments.id, match.tournamentId))
        .limit(1);
      // A set from a draft tournament is as invisible as the tournament.
      if (!tournamentOfSet || !(await can(user, "view", { status: tournamentOfSet.status }, "esports"))) {
        return c.json({ error: "Match not found" }, 404);
      }
      const fields = (tournamentOfSet.customFields ?? []) as CustomFieldDefinition[];

      const getParticipant = async (participantId: string | null) => {
        if (!participantId) return null;
        const [p] = await db.instance
          .select({ participant: tournamentParticipants, player: players, team: teams })
          .from(tournamentParticipants)
          .leftJoin(players, eq(tournamentParticipants.playerId, players.id))
          .leftJoin(teams, eq(tournamentParticipants.teamId, teams.id))
          .where(eq(tournamentParticipants.id, participantId))
          .limit(1);
        return p
          ? {
              ...participantForViewer(p.participant, fields, staff),
              player: p.player,
              team: p.team,
            }
          : null;
      };

      // In series: the request transaction is one connection (docs/kons/README.md).
      const participant1 = await getParticipant(match.participant1Id);
      const participant2 = await getParticipant(match.participant2Id);
      const winner = await getParticipant(match.winnerId);

      return c.json({ ...match, participant1, participant2, winner });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Bracket — generation and result reporting
  //
  // The arithmetic lives in `bracket.ts`, which is pure and exhaustively
  // tested (all sizes from 2 to 32, both formats). Here it is only
  // translated between that engine and the tables: generate = dump, report = reread,
  // apply and dump again. That way a routing bug is caught in a unit test
  // of milliseconds and not in a live tournament.
  // ═══════════════════════════════════════════════════════════════════════════

  // The engine ↔ tables translation lives in `bracket.persistence.ts`, because
  // the broadcast scoreboard shares it: `kon-broadcast` closes sets from the
  // overlay and has to advance the SAME bracket, not a copy of the logic.

  // Generate Brackets
  app.post(
    "/tournament/:tournamentId/generate",
    {
      id: "generate-bracket",
      summary: "Generate the bracket",
      description:
        "Seeds the approved participants and builds the bracket (elimination, round robin) or pairs round 1 (swiss). Body optional: `format`, `seeding`, `shuffleSeed` override the tournament's. Sets the tournament InProgress. Regenerating replaces the bracket. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      // Redoing the bracket moves people who already have their pairing.
      sensitive: true,
      input: { params: ParamTournamentId, body: GenerateBracket.optional() },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { tournamentId } = c.req.param();
      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, tournamentId))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);

      const body = (await c.req.json().catch(() => ({}))) as {
        format?: BracketFormat;
        seeding?: SeedMethod;
        shuffleSeed?: number;
      };

      const format = body.format ?? tournament.bracketFormat;
      const seeding = body.seeding ?? tournament.seedMethod;
      // Explicit seed or derived from the tournament: never Math.random(), so that the
      // draw is reproducible and auditable.
      const shuffleSeed =
        body.shuffleSeed ??
        tournament.shuffleSeed ??
        Number.parseInt(tournament.id.replace(/\D/g, "").slice(0, 9) || "1", 10);

      // Only those who are IN: approved and off the waiting list. Before,
      // pending, rejected and waitlisted also got in, and with guest
      // registration open, fake entries ended up seeded into the bracket
      // (an earlier audit). Nor those withdrawn with `drop`.
      const participants = await db.instance
        .select()
        .from(tournamentParticipants)
        .where(
          and(
            eq(tournamentParticipants.tournamentId, tournamentId),
            eq(tournamentParticipants.status, "Approved"),
            isNull(tournamentParticipants.waitlistPosition),
            isNull(tournamentParticipants.droppedAt)
          )
        );

      if (participants.length < 2) {
        return c.json({ error: "Not enough participants to generate brackets" }, 400);
      }

      // ── Swiss: generated ROUND BY ROUND, not all at once ──
      //
      // Round 3 depends on who won in round 2, so "generate the bracket" does not
      // mean anything here: what is done is pairing the first round. Without
      // this branch, `swiss` fell into the elimination generator and silently
      // set up a tournament with the wrong format.
      if (format === "swiss") {
        const seeded = seedParticipants(
          participants.map((p) => ({ id: p.id, name: p.id, rating: p.rating ?? undefined })),
          seeding,
          shuffleSeed
        );
        for (const [index, p] of seeded.entries()) {
          await db.instance
            .update(tournamentParticipants)
            .set({ seed: index + 1 })
            .where(eq(tournamentParticipants.id, p.id));
        }

        const totalRounds = tournament.swissRounds ?? recommendedRounds(participants.length);

        let generated;
        try {
          generated = await generateSwissRound(db.instance, tournamentId, totalRounds);
        } catch (err) {
          return c.json(
            { error: err instanceof Error ? messageOf(err) : "Could not pair" },
            400
          );
        }

        await db.instance
          .update(tournaments)
          .set({
            status: "InProgress",
            bracketFormat: "swiss",
            seedMethod: seeding,
            shuffleSeed,
            swissRounds: totalRounds,
            championId: null,
            updatedAt: new Date(),
          })
          .where(eq(tournaments.id, tournamentId));

        return c.json({
          message: "Swiss round 1 paired",
          format,
          round: generated.round,
          totalRounds,
          pairings: generated.pairings,
          warnings: generated.warnings,
        });
      }

      // ── Round robin: another engine, same table ──
      if (format === "round_robin") {
        // The seeding order IS the schedule (the circle method is
        // deterministic), so it is fixed first and everything is rebuilt from it.
        const seeded = seedParticipants(
          participants.map((p) => ({ id: p.id, name: p.id, rating: p.rating ?? undefined })),
          seeding,
          shuffleSeed
        );
        for (const [index, p] of seeded.entries()) {
          await db.instance
            .update(tournamentParticipants)
            .set({ seed: index + 1 })
            .where(eq(tournamentParticipants.id, p.id));
        }

        const rr = createRoundRobin(seeded.map((p) => p.id));
        const idByMatchId = new Map<string, string>();
        for (const m of rr.matches) idByMatchId.set(m.id, crypto.randomUUID());
        await persistRoundRobin(db.instance, tournamentId, rr, idByMatchId);

        await db.instance
          .update(tournaments)
          .set({
            status: "InProgress",
            bracketFormat: format,
            seedMethod: seeding,
            shuffleSeed,
            championId: null,
            updatedAt: new Date(),
          })
          .where(eq(tournaments.id, tournamentId));

        return c.json({
          message: "Round robin generated",
          format,
          rounds: Math.max(...rr.matches.map((m) => m.round)),
          matches: rr.matches.filter((m) => m.status !== "bye").length,
          byes: rr.matches.filter((m) => m.status === "bye").length,
        });
      }

      let bracket: Bracket;
      try {
        bracket = createBracket(
          participants.map((p) => ({ id: p.id, name: p.id, rating: p.rating ?? undefined })),
          { format, seeding, shuffleSeed }
        );
      } catch (err) {
        const message = err instanceof Error ? messageOf(err) : "Could not generate the bracket";
        return c.json({ error: message }, 400);
      }

      // Persist the resulting seeding: it is what makes the bracket reconstructible.
      for (const [index, p] of bracket.participants.entries()) {
        await db.instance
          .update(tournamentParticipants)
          .set({ seed: index + 1 })
          .where(eq(tournamentParticipants.id, p.id));
      }

      const idByBracketId = new Map<string, string>();
      for (const m of bracket.matches) idByBracketId.set(m.id, crypto.randomUUID());

      await persistBracket(db.instance, tournamentId, bracket, idByBracketId);

      await db.instance
        .update(tournaments)
        .set({
          status: "InProgress",
          bracketFormat: format,
          seedMethod: seeding,
          shuffleSeed,
          championId: null,
          updatedAt: new Date(),
        })
        .where(eq(tournaments.id, tournamentId));

      return c.json({
        message: "Brackets generated",
        format,
        seeding,
        shuffleSeed,
        size: bracket.size,
        matches: bracket.matches.length,
        byes: bracket.matches.filter((m) => m.status === "bye").length,
        playable: playableMatches(bracket).length,
      });
    }
  );

  /**
   * Reports the result of a set and advances the bracket.
   *
   * Replaces the previous manual advance, which only knew how to move the winner to
   * `nextMatchId` and therefore could not sustain a double elimination.
   */
  app.post(
    "/tournament/:tournamentId/report",
    {
      id: "report-set",
      summary: "Report the winner of a set (elimination, round robin or swiss)",
      description:
        "`winnerId` is the tournament PARTICIPANT id, not the player id. Send `matchId` (the row) rather than `bracketMatchId`. Elimination advances the bracket; round robin and swiss store the result and return the standings. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: ParamTournamentId, body: ReportResult },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const { tournamentId } = c.req.param();
      const body = input.body as z.infer<typeof ReportResult>;

      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, tournamentId))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);

      /**
       * ── Swiss: the result goes to the row and the table is recomputed ──────
       *
       * There was no safe route to report a Swiss set. `applyResult` goes
       * through `loadBracket`, which throws with this format, and `PUT /matches/:id` marked
       * the TOURNAMENT as finished when reporting any set without `nextMatchId` —which
       * in Swiss is all of them—. The TO panel had to show them read-only,
       * and an agent had no way to close a round.
       *
       * In Swiss there is no bracket to advance: standings are derived from the
       * rows (`loadSwissPlayers`). Reporting is writing the winner into the row and
       * returning the recomputed table.
       */
      if (tournament.bracketFormat === "swiss") {
        const [rowValue] = await db.instance
          .select()
          .from(matches)
          .where(
            body.matchId
              ? and(eq(matches.id, body.matchId), eq(matches.tournamentId, tournamentId))
              : and(
                  eq(matches.tournamentId, tournamentId),
                  eq(matches.bracketMatchId, body.bracketMatchId!)
                )
          )
          .limit(1);
        if (!rowValue) return c.json({ error: "That set is not from this tournament." }, 404);

        if (!rowValue.participant2Id) {
          return c.json(
            { error: "It is a bye: already resolved in favor of whoever had no opponent." },
            409
          );
        }
        if (body.winnerId !== rowValue.participant1Id && body.winnerId !== rowValue.participant2Id) {
          return c.json(
            {
              error:
                "The winner must be one of the two participants of set " +
                "(participant ids, not player ids).",
              participants: [rowValue.participant1Id, rowValue.participant2Id],
            },
            400
          );
        }

        const scope = rowValue.phaseId ? { phaseId: rowValue.phaseId } : {};

        // Correcting is allowed as long as the next round is not paired:
        // afterwards it would change matchups people already have published.
        /**
         * It checks whether sets of later rounds EXIST, not the record.
         *
         * `loadSwissState().round` comes from the registered results, so
         * with the next round just paired —and no results yet—
         * it still said "round 1" and allowed correcting. It is exactly the moment
         * when correcting is most costly: the matchups are already published.
         */
        const [later] = await db.instance
          .select({ id: matches.id })
          .from(matches)
          .where(
            and(
              eq(matches.tournamentId, tournament.id),
              rowValue.phaseId ? eq(matches.phaseId, rowValue.phaseId) : isNull(matches.phaseId),
              gt(matches.round, rowValue.round)
            )
          )
          .limit(1);
        if (rowValue.winnerId && later) {
          return c.json(
            {
              error:
                `Round ${rowValue.round} already has the next one paired: correcting this ` +
                "result would change published matchups.",
            },
            409
          );
        }

        await db.instance
          .update(matches)
          .set({
            winnerId: body.winnerId,
            participant1Score: body.participant1Score ?? rowValue.participant1Score,
            participant2Score: body.participant2Score ?? rowValue.participant2Score,
            status: "Completed",
            updatedAt: new Date(),
          })
          .where(eq(matches.id, rowValue.id));

        const statusValue = await loadSwissState(
          db.instance,
          tournament.id,
          tournament.swissRounds,
          scope
        );
        const pendingItems = await db.instance
          .select({ id: matches.id })
          .from(matches)
          .where(
            and(
              eq(matches.tournamentId, tournament.id),
              eq(matches.round, rowValue.round),
              rowValue.phaseId ? eq(matches.phaseId, rowValue.phaseId) : isNull(matches.phaseId),
              isNull(matches.winnerId)
            )
          );

        return c.json({
          message: "Result reported",
          round: statusValue.round,
          totalRounds: statusValue.totalRounds,
          complete: statusValue.complete,
          // What whoever runs the tournament needs to continue: how much of the round is left.
          pendingInRound: pendingItems.length,
          next:
            pendingItems.length === 0 && !statusValue.complete
              ? `POST /api/esports/tournament/${tournament.id}/swiss/next-round`
              : null,
          standings: statusValue.standings,
        });
      }

      // ── Round robin: reporting advances nobody, and correcting is allowed ──
      if (tournament.bracketFormat === "round_robin") {
        let rrMatchId = body.bracketMatchId;
        if (!rrMatchId && body.matchId) {
          const [row] = await db.instance
            .select()
            .from(matches)
            .where(eq(matches.id, body.matchId))
            .limit(1);
          if (!row) return c.json({ error: "Match not found" }, 404);
          rrMatchId = row.bracketMatchId ?? undefined;
        }
        if (!rrMatchId) return c.json({ error: "matchId or bracketMatchId is required" }, 400);

        try {
          const applied = await applyRoundRobinResult(db.instance, tournament, rrMatchId, {
            winnerId: body.winnerId,
            scores:
              body.participant1Score !== undefined || body.participant2Score !== undefined
                ? [body.participant1Score ?? 0, body.participant2Score ?? 0]
                : undefined,
          });
          return c.json({
            message: "Result reported",
            complete: applied.complete,
            standings: applied.standings,
          });
        } catch (err) {
          const message = err instanceof Error ? messageOf(err) : "Invalid result";
          return c.json({ error: message }, 400);
        }
      }

      // Either the row uuid or the engine id (`W2M1`) is accepted: the TO panel
      // works with the former, a script or the CLI with the latter.
      let bracketMatchId = body.bracketMatchId;
      if (!bracketMatchId && body.matchId) {
        const [row] = await db.instance
          .select()
          .from(matches)
          .where(eq(matches.id, body.matchId))
          .limit(1);
        if (!row) return c.json({ error: "Match not found" }, 404);
        bracketMatchId = row.bracketMatchId ?? undefined;
      }
      if (!bracketMatchId) return c.json({ error: "matchId or bracketMatchId is required" }, 400);

      // Scores are informational: the winner was already decided by whoever reports.
      const hasScores =
        body.participant1Score !== undefined || body.participant2Score !== undefined;

      let applied;
      try {
        applied = await applyResult(db.instance, tournament, bracketMatchId, {
          winnerId: body.winnerId,
          dqId: body.dqId,
          eliminate: body.eliminate,
          scores: hasScores
            ? {
                participant1: body.participant1Score ?? 0,
                participant2: body.participant2Score ?? 0,
              }
            : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? messageOf(err) : "Invalid result";
        return c.json({ error: message }, 400);
      }

      const { bracket: next, idByBracketId } = applied;

      return c.json({
        message: "Result reported",
        championId: applied.championId,
        complete: applied.complete,
        playable: playableMatches(next).map((m) => ({
          bracketMatchId: m.id,
          id: idByBracketId.get(m.id),
          side: m.side,
          round: m.round,
          participants: m.participants,
        })),
        standings: getStandings(next),
      });
    }
  );

  /**
   * Group standings — what the table draws on screen.
   *
   * Public for the same reason as the bracket: the OBS graphic reads it without a session,
   * and standings expose nothing that is not already on the projector.
   */
  app.get(
    "/tournament/:tournamentId/standings",
    {
      id: "round-robin-standings",
      summary: "Round robin standings",
      description:
        "Standings of a round robin tournament with display names (what the graphic paints). 409 if the tournament is not a round robin.",
      access: "public",
      input: { params: ParamTournamentId },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { tournamentId } = c.req.param();
      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, tournamentId))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);
      if (tournament.bracketFormat !== "round_robin") {
        return c.json({ error: "This tournament is not a round robin" }, 409);
      }

      /**
       * A round robin with fewer than two registrants has no schedule: the
       * engine throws, and that came out as a 500 (Schemathesis). It is the
       * tournament's state, as in `get-bracket`: 409 with the reason.
       */
      let loaded: Awaited<ReturnType<typeof loadRoundRobin>>;
      try {
        loaded = await loadRoundRobin(db.instance, tournament);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? messageOf(err) : "This tournament has no schedule" },
          409
        );
      }
      const { rr } = loaded;

      // The same name map as the bracket: a graphic does not draw UUIDs.
      const parts = await db.instance
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
      for (const p of parts) {
        names[p.id] = { name: p.playerAlias ?? p.teamName ?? "", country: p.playerCountry ?? null };
      }

      return c.json({
        title: tournament.title,
        complete: isRoundRobinComplete(rr),
        names,
        standings: roundRobinStandings(rr),
        // Matchdays for the "Matchday 3 of 7" label of the graphic.
        rounds: Math.max(...rr.matches.map((m) => m.round)),
      });
    }
  );

  /** Full bracket, grouped by side — what a bracket view draws. */
  app.get(
    "/tournament/:tournamentId/bracket",
    {
      id: "get-bracket",
      summary: "Read the bracket",
      description:
        "The whole bracket grouped by side (winners, losers, grand final) with display names, champion and standings. 409 when there is no elimination bracket (swiss, round robin, fewer than two participants).",
      access: "public",
      input: { params: ParamTournamentId },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { tournamentId } = c.req.param();
      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, tournamentId))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);

      /**
       * With no bracket to draw —a Swiss or a round robin, or fewer than two
       * registrants— the engine throws, and that came out as a 500 (Schemathesis).
       * It is the tournament's state, not a breakdown: 409 with the reason,
       * like the standings of a tournament that is not round robin.
       */
      let loaded: Awaited<ReturnType<typeof loadBracket>>;
      try {
        loaded = await loadBracket(db.instance, tournament);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? messageOf(err) : "This tournament has no bracket" },
          409
        );
      }
      const { bracket, idByBracketId } = loaded;

      const withIds = bracket.matches.map((m) => ({
        ...m,
        rowId: idByBracketId.get(m.id) ?? null,
      }));

      // The engine works with participant ids, but a GRAPHIC cannot
      // draw UUIDs. The map is built here —once, on the server— and not
      // in each client, which would have to make N requests to resolve it.
      const parts = await db.instance
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
      for (const p of parts) {
        names[p.id] = {
          name: p.playerAlias ?? p.teamName ?? "",
          country: p.playerCountry ?? null,
        };
      }

      return c.json({
        format: bracket.format,
        size: bracket.size,
        championId: bracket.championId,
        complete: isComplete(bracket),
        names,
        winners: withIds.filter((m) => m.side === "winners"),
        losers: withIds.filter((m) => m.side === "losers"),
        grandFinal: withIds.filter((m) => m.side === "grand_final"),
        standings: getStandings(bracket),
      });
    }
  );

  // Report Match Result
  app.put(
    "/:id",
    {
      id: "report-set-manual",
      summary: "Write a set result by hand (elimination)",
      description:
        "Legacy manual result: writes scores and winner and moves the winner to the next set; a set with no next set closes the tournament. Swiss and round robin sets answer 409 pointing to report-set. Prefer report-set. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: ParamId, body: ManualReport },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { id } = c.req.param();
      const body: any = await c.req.json();
      const [match] = await db.instance.select().from(matches).where(eq(matches.id, id)).limit(1);
      if (!match) return c.json({ error: "Match not found" }, 404);

      /**
       * Swiss and round robin are NOT reported through here.
       *
       * This route chains the winner to the next set and, if the set has no
       * `nextMatchId`, marks the TOURNAMENT as finished. In elimination that is the grand
       * final; in Swiss and round robin it is ALL the sets: reporting the first
       * closed the whole tournament. It is rejected saying which route to use, with the
       * body already assembled.
       */
      const [tournamentOfSet] = await db.instance
        .select({ bracketFormat: tournaments.bracketFormat })
        .from(tournaments)
        .where(eq(tournaments.id, match.tournamentId))
        .limit(1);
      if (
        tournamentOfSet &&
        (tournamentOfSet.bracketFormat === "swiss" || tournamentOfSet.bracketFormat === "round_robin")
      ) {
        const route = `/api/esports/matches/tournament/${match.tournamentId}/report`;
        return c.json(
          {
            error:
              `This set is from a tournament of type ${tournamentOfSet.bracketFormat === "swiss" ? "swiss" : "round robin"}: ` +
              `it is reported with POST ${route}. This route would mark the tournament as finished.`,
            use: {
              method: "POST",
              path: route,
              body: { matchId: match.id, winnerId: "<participantId>" },
            },
          },
          409
        );
      }

      const [updated] = await db.instance
        .update(matches)
        .set({
          participant1Score: body.participant1Score,
          participant2Score: body.participant2Score,
          winnerId: body.winnerId,
          status: "Completed",
          updatedAt: new Date(),
        })
        .where(eq(matches.id, id))
        .returning();

      if (match.nextMatchId && body.winnerId) {
        const [nextMatch] = await db.instance
          .select()
          .from(matches)
          .where(eq(matches.id, match.nextMatchId))
          .limit(1);
        if (nextMatch) {
          const isSlot1 = match.matchOrder % 2 !== 0;
          const updateData: any = {};
          if (isSlot1) updateData.participant1Id = body.winnerId;
          else updateData.participant2Id = body.winnerId;

          const willBeReady =
            (isSlot1 && nextMatch.participant2Id) || (!isSlot1 && nextMatch.participant1Id);
          if (willBeReady) updateData.status = "Ready";
          await db.instance.update(matches).set(updateData).where(eq(matches.id, nextMatch.id));
        }
      } else {
        await db.instance
          .update(tournaments)
          .set({ status: "Completed", updatedAt: new Date() })
          .where(eq(tournaments.id, match.tournamentId));
      }
      return c.json(updated);
    }
  );

  // Delete Match
  app.delete(
    "/:id",
    {
      id: "delete-set",
      summary: "Delete a set",
      description: "Deletes one set row. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: ParamId },
      output: { schema: Deleted },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { id } = c.req.param();
      const [deleted] = await db.instance
        .delete(matches)
        .where(eq(matches.id, id))
        .returning({ id: matches.id });
      if (!deleted) return c.json({ error: "Match not found" }, 404);
      return c.json({ deleted: true, id: deleted.id });
    }
  );

  return app.ops;
}

/**
 * Create Esports router with dependency injection
 */
/**
 * Swiss routes.
 *
 * They are separate because their cycle is different from everything else: there is no "generate
 * the tournament", there is "pair the next round" — and the TO presses it as many
 * times as rounds they have announced.
 */
function swissOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const { db: rawDb } = ctx;
  const db = { ...rawDb, instance: rawDb.instance as EsportsDb };

  /**
   * Standings. **Public**: in Swiss the table is the tournament — it is what
   * everyone looks at between rounds to know whether they are still alive.
   */
  app.get(
    "/tournament/:id/swiss",
    {
      id: "swiss-standings",
      summary: "Swiss standings",
      description:
        "Current round, total rounds, whether it is complete, and the standings with tiebreakers.",
      access: "public",
      input: { params: TournamentParam },
      output: { schema: withData(Obj) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, c.req.param("id")))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);

      const state = await loadSwissState(db.instance, tournament.id, tournament.swissRounds);
      return c.json({ data: state });
    }
  );

  /** Pairs the next round. */
  app.post(
    "/tournament/:id/swiss/next-round",
    {
      id: "next-swiss-round",
      summary: "Pair the next swiss round",
      description:
        "Pairs the next round once every set of the current one has a result. 409 if results are missing, all rounds were played, or the tournament is not swiss. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: TournamentParam },
      output: { schema: withData(Obj) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, c.req.param("id")))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);
      if (tournament.bracketFormat !== "swiss") {
        return c.json({ error: "This tournament is not Swiss." }, 409);
      }

      try {
        const generated = await generateSwissRound(
          db.instance,
          tournament.id,
          tournament.swissRounds ?? 0
        );
        return c.json({ data: generated });
      } catch (err) {
        // 409 and not 500: "results are missing" and "all rounds have been played"
        // are legitimate tournament states, not breakdowns.
        return c.json(
          { error: err instanceof Error ? messageOf(err) : "Could not pair" },
          409
        );
      }
    }
  );

  /**
   * Withdraw.
   *
   * `droppedAt` and NOT delete or eliminate: whoever withdraws **keeps their
   * record**. If it disappeared, everyone who beat them would lose the credit
   * for that win and their tiebreakers would change over something they did not do.
   */
  app.post(
    "/participant/:participantId/drop",
    {
      id: "withdraw-participant",
      summary: "Drop a participant (keeps their record)",
      description:
        "Marks the participant as dropped: no more pairings, but their results stay so opponents keep their tiebreakers. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      // Withdrawing twice leaves the same result (still withdrawn).
      idempotent: true,
      input: { params: ParticipantParam },
      output: { schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const [updated] = await db.instance
        .update(tournamentParticipants)
        .set({ droppedAt: new Date() })
        .where(eq(tournamentParticipants.id, c.req.param("participantId")))
        .returning();

      if (!updated) return c.json({ error: "Participant not found" }, 404);
      return c.json({ data: updated });
    }
  );

  /** The cut: the N who move on to the elimination phase. */
  app.get(
    "/tournament/:id/swiss/cut",
    {
      id: "swiss-cut",
      summary: "Swiss cut (top N)",
      description:
        "The `size` (default 8) participants that make the cut, and whether it is still provisional (rounds left).",
      access: "public",
      input: {
        params: TournamentParam,
        query: query({ size: text("How many make the cut (default 8)") }),
      },
      output: { schema: withData(z.array(z.unknown())) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const size = Math.max(0, Number(c.req.query("size")) || 8);
      const [tournament] = await db.instance
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, c.req.param("id")))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);

      const state = await loadSwissState(db.instance, tournament.id, tournament.swissRounds);
      return c.json({
        data: swissCut(state.standings, size),
        // It says whether the cut is PROVISIONAL: showing a top 8 before the last
        // round as if it were final is how someone goes home believing
        // they did not make it.
        provisional: !state.complete,
        round: state.round,
        totalRounds: state.totalRounds,
      });
    }
  );

  return app.ops;
}

/**
 * All the kon's operations, in the order in which the routers were mounted
 * (the same resolution order as before).
 */
export function esportsOperations(ctx: KonContext): AnyOperation[] {
  return [
    ...playersOperations(ctx),
    ...teamsOperations(ctx),
    ...tournamentsOperations(ctx),
    ...matchesOperations(ctx),
    // Those of OTHER teams: the blog's calendar, not our tournaments
    ...proMatchesOperations(ctx),
    /**
     * Who wins the most, adding up ALL the tournaments. It is a different question from the
     * standings of ONE (`/tournament/:id/standings`), and that is why it is another route.
     */
    ...leaderboardOperations(ctx),
    // Phases and check-in: its own subsystem, with its own lifecycle.
    ...phasesOperations(ctx),
    // Import from other platforms (start.gg, Matcherino, Battlefy).
    ...importOperations(ctx),
    // Public registration and result reports submitted by players.
    ...registrationOperations(ctx),
    // Online operation: notices for the bot, teams, rooms and broadcast.
    ...onlineOperations(ctx),
    // Swiss: round-by-round pairing and standings with tiebreakers.
    ...swissOperations(ctx),
  ];
}

export function createEsportsRouter(ctx: KonContext): Hono {
  const app = operationsRouter(KON_ID, esportsOperations(ctx), ctx);
  // A malformed id is a 404 before reaching the database (see valid-ids.ts),
  // and a draft is one through any route (see hidden-drafts.ts).
  return withValidatedIds(withHiddenDrafts(app, ctx));
}

// Legacy exports for backward compatibility (now all use DI)
export const playersRoutes = { __legacy: true } as any;
export const teamsRoutes = { __legacy: true } as any;
export const tournamentsRoutes = { __legacy: true } as any;
export const matchesRoutes = { __legacy: true } as any;
