/**
 * Online operation routes
 * ============================================================================
 *
 * Four subsystems that only make sense together, because in an online
 * tournament they are the same moment: the set is ready → we must say where it
 * is played → we must notify both → and sometimes, it goes on camera.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NOTICE IS WRITTEN IN THE SAME TRANSACTION AS THE FACT
 *
 * Never "do this and then call Discord". The row is inserted into the outbox
 * within the same transaction that assigns the room or moves the queue, and the bot
 * picks it up when it can. A network failure between the two cannot leave
 * two people waiting for a set that was already ready.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash, randomBytes } from "node:crypto";

import type { AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";

import type { EsportsDb } from "./esports.db";
import {
  Row,
  Obj,
  ParamId,
  ParamSet,
  TournamentParam,
  ParamToken,
  withData,
  query,
  text,
} from "./schemas";
import { ANY_ACCOUNT, ORGANIZATION_ONLY, registry, type KonPath } from "./operations";
import { aliasOwnership } from "./player-identity";
import { nextWaitlistPosition, planRegistration, type RegistrationMode } from "./registration";
import {
  matches,
  notifications,
  players,
  playersToTeams,
  stations,
  streams,
  teamInvites,
  teams,
  tournamentParticipants,
  tournaments,
} from "./esports.schema";
import {
  canWatch,
  channelUrl,
  checkInvite,
  checkRoster,
  embedUrl,
  planMatchReady,
  planQueue,
  planStreamCall,
  NOTIFICATION_TYPES,
  type NotificationType,
  type PlannedNotification,
  type RosterMember,
  type StreamPlatform,
  type ViewerAccess,
} from "./online";

interface SessionUser {
  id: string;
  name?: string;
}

type OnlineEnv = { Variables: { user: SessionUser | null } };
type C = Context<OnlineEnv, KonPath>;

// Bodies. `passthrough`: these routes have always ignored what they do not know;
// what is missing or invalid is still reported by the handler with its message.
const NoticesAck = z
  .object({ ids: z.array(z.string()).optional().describe("Ids of the notifications delivered") })
  .passthrough();
const FailedNotice = z
  .object({
    id: z.string().optional().describe("Notification id (required)"),
    error: z.string().optional().describe("Why it could not be delivered"),
  })
  .passthrough();
const OwnTeam = z
  .object({
    name: z.string().optional().describe("Team name (required, unique)"),
    alias: z.string().optional().describe("Your alias in the roster (default: account name)"),
  })
  .passthrough();
const Invitation = z
  .object({
    userId: z.string().optional().describe("Account to invite"),
    handle: z.string().optional().describe("Or a Discord handle: the link is the credential"),
    role: z.string().optional().describe("player (default) | sub"),
  })
  .passthrough();
const AcceptInvitation = z
  .object({ alias: z.string().optional().describe("Your alias in the roster") })
  .passthrough();
const TeamRegistration = z
  .object({
    teamId: z.string().optional().describe("Your team (you must be its captain; required)"),
    acceptRules: z.boolean().optional(),
  })
  .passthrough();
const Station = z
  .object({
    name: z.string().optional().describe("Station name (required)"),
    kind: z.string().optional().describe("physical (default) | lobby"),
    accessDetails: z
      .string()
      .optional()
      .describe("Room code or password: only the two players see it"),
  })
  .passthrough();
const AssignStation = z
  .object({ stationId: z.string().nullable().optional().describe("null frees the set") })
  .passthrough();
const Emission = z
  .object({
    platform: z.string().optional().describe("twitch | youtube | kick (required)"),
    channel: z.string().optional().describe("Channel name (required)"),
    title: z.string().optional(),
    viewerAccess: z.string().optional().describe("public (default) | registered"),
    isPrimary: z.boolean().optional(),
  })
  .passthrough();
const QueuePosition = z
  .object({
    position: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("1-based; null takes it out of the queue"),
    streamId: z.string().optional().describe("Stream that will show it"),
  })
  .passthrough();

/** Cap on the bot's poll. High enough to drain a burst, not unlimited. */
const MAX_POLL = 200;

/** Default expiry of an invitation. A week covers a long weekend. */
const INVITE_TTL_DAYS = 7;

/** What is stored of an invitation: the hash, never the token. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Looks up the invitation by the token's hash.
 *
 * Also by the plain token, for invitations created before the hash
 * was stored: they expire on their own in a week and do not need to be invalidated
 * all at once. They do not collide: a token is 32 base64url characters and a hash is 64
 * hexadecimal ones.
 */
function inviteTokenMatches(token: string) {
  const clean = token.trim();
  if (!clean || clean.length > 128) {
    // An empty token cannot match anything (not even a constant hash).
    return sql`false`;
  }
  // The plain path ONLY for rows that do not store a hash (64 hex): otherwise,
  // the hash itself read from the database would work as a link.
  return or(
    eq(teamInvites.token, hashInviteToken(clean)),
    and(eq(teamInvites.token, clean), sql`length(${teamInvites.token}) <> 64`)
  );
}

export function onlineOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const db = ctx.db.instance as EsportsDb;

  /**
   * Enqueues notices. `onConflictDoNothing` on `dedupeKey` IS the idempotency:
   * pressing "assign room" again does not send a second DM.
   */
  async function enqueue(tx: EsportsDb, tournamentId: string, planned: PlannedNotification[]) {
    if (planned.length === 0) return;
    await tx
      .insert(notifications)
      .values(
        planned.map((n) => ({
          tournamentId,
          participantId: n.participantId,
          type: n.type,
          dedupeKey: n.dedupeKey,
          payload: n.payload,
        }))
      )
      .onConflictDoNothing();
  }

  /** Name and contact of a participant, to put in the notice. */
  async function recipientOf(participantId: string | null) {
    if (!participantId) return null;
    const [row] = await db
      .select({
        participantId: tournamentParticipants.id,
        contactHandle: tournamentParticipants.contactHandle,
        alias: players.alias,
        teamName: teams.name,
      })
      .from(tournamentParticipants)
      .leftJoin(players, eq(tournamentParticipants.playerId, players.id))
      .leftJoin(teams, eq(tournamentParticipants.teamId, teams.id))
      .where(eq(tournamentParticipants.id, participantId))
      .limit(1);

    if (!row) return null;
    return {
      participantId: row.participantId,
      contactHandle: row.contactHandle,
      displayName: row.teamName ?? row.alias ?? "Participant",
    };
  }

  /** Does this account play that set? What authorizes seeing the room code. */
  async function isInMatch(match: typeof matches.$inferSelect, userId: string) {
    const ids = [match.participant1Id, match.participant2Id].filter(Boolean) as string[];
    if (ids.length === 0) return false;
    const [row] = await db
      .select({ id: tournamentParticipants.id })
      .from(tournamentParticipants)
      .where(
        and(
          inArray(tournamentParticipants.id, ids),
          eq(tournamentParticipants.registeredByUserId, userId)
        )
      )
      .limit(1);
    return Boolean(row);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Bot API
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * What is left to send.
   *
   * Polling and not a webhook because a community bot restarts, gets deployed and
   * loses its network: with webhooks, everything that happens while it is down is
   * lost. Here it finds it on return.
   *
   * Optional `since` to resume without rereading the whole burst after a restart.
   */
  app.get(
    "/notifications/pending",
    {
      id: "pending-notices",
      summary: "Pending notifications (bot inbox)",
      description:
        "Notifications not delivered yet, oldest first (set ready, station, stream call…), for the community bot to send. Filters: `tournamentId`, `since`, `limit` (max 200). Contains contact handles: tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: {
        query: query({
          tournamentId: text("Tournament id"),
          limit: text("Max 200, default 50"),
          since: text("ISO date: created up to then"),
        }),
      },
      output: { schema: z.object({ data: z.array(Row), types: z.array(z.string()) }) },
    },
    async (c: C) => {
      const tournamentId = c.req.query("tournamentId");
      const limit = Math.min(Number(c.req.query("limit")) || 50, MAX_POLL);
      const since = c.req.query("since");

      const filters = [isNull(notifications.deliveredAt)];
      if (tournamentId) filters.push(eq(notifications.tournamentId, tournamentId));
      if (since) {
        const date = new Date(since);
        if (!Number.isNaN(date.getTime())) filters.push(lte(sql`${notifications.createdAt}`, date));
      }

      const rows = await db
        .select()
        .from(notifications)
        .where(and(...filters))
        // In order of appearance: a "your set is ready" arriving after the
        // "you advanced a round" leaves the player not knowing what is going on.
        .orderBy(asc(notifications.createdAt))
        .limit(limit);

      return c.json({ data: rows, types: NOTIFICATION_TYPES });
    }
  );

  /**
   * The bot confirms what it already sent.
   *
   * AT-LEAST-ONCE delivery, not exactly once: if the bot sends the DM and crashes
   * before confirming, the notice is repeated. It is the right side to be
   * wrong on — a repeated message is annoying; a lost one leaves two people
   * waiting.
   */
  app.post(
    "/notifications/ack",
    {
      id: "confirm-notices",
      summary: "Mark notifications as delivered",
      description:
        "The bot confirms the notifications it sent (at-least-once delivery). Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      idempotent: true,
      input: { body: NoticesAck.optional() },
      output: { schema: z.object({ acknowledged: z.number().int() }) },
    },
    async (c: C) => {
      const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return c.json({ error: "`ids` is required: the notices already delivered" }, 400);
      }

      const updated = await db
        .update(notifications)
        .set({ deliveredAt: new Date() })
        .where(
          and(
            inArray(notifications.id, body.ids.slice(0, MAX_POLL)),
            isNull(notifications.deliveredAt)
          )
        )
        .returning({ id: notifications.id });

      return c.json({ acknowledged: updated.length });
    }
  );

  /**
   * The bot reports that it could not deliver one.
   *
   * It does NOT mark it delivered: it stays pending. What it does is leave the reason
   * written and raise the counter, so that "this person doesn't get
   * DMs because they have them closed" is something the TO can SEE instead of
   * inferring from it never showing up.
   */
  app.post(
    "/notifications/fail",
    {
      id: "fail-notice",
      summary: "Report an undeliverable notification",
      description:
        "The bot records why a notification could not be delivered; it stays pending and its attempt count goes up. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { body: FailedNotice.optional() },
      output: { schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const body = (await c.req.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!body.id) return c.json({ error: "`id` is required" }, 400);

      const [row] = await db
        .update(notifications)
        .set({
          attempts: sql`${notifications.attempts} + 1`,
          lastError: (body.error ?? "").slice(0, 500) || "no detail",
        })
        .where(eq(notifications.id, body.id))
        .returning();

      if (!row) return c.json({ error: "Not found" }, 404);
      return c.json({ data: row });
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // Teams
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Creates a team. Whoever creates it is the captain.
   *
   * Under `/public/` and not plain `/teams` because THAT route is already the admin
   * CRUD, mounted earlier: two routers with the same path do not raise an
   * error, the first one wins — and this one was silently unreachable. The
   * prefix also says who it is aimed at, which is half the problem.
   */
  app.post(
    "/public/teams",
    {
      id: "create-my-team",
      summary: "Create my team",
      description:
        "Creates a team with you as captain (your player profile joins the roster). Then invite people with invite-to-team.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: OwnTeam.optional() },
      output: { status: 201, schema: withData(Row) },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const body = (await c.req.json().catch(() => ({}))) as { name?: string; alias?: string };
      const name = body.name?.trim();
      if (!name) return c.json({ error: "A team name is required." }, 400);

      const [existing] = await db
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.name, name))
        .limit(1);
      if (existing) return c.json({ error: `There is already a team named "${name}".` }, 409);

      // The captain's record: their own if they already have one, a new one if the alias is
      // free, and NEVER someone else's. Before, an occupied alias returned the
      // other person's record and the new account ended up as captain under someone else's name.
      const captainAlias = (body.alias ?? user.name ?? name).trim().slice(0, 200);
      const ownership = await aliasOwnership(db, captainAlias, user.id);
      if (ownership.status === "taken") {
        return c.json(
          { error: `The alias "${captainAlias}" is already in use. Choose another for the roster.` },
          409
        );
      }

      const created = await db.transaction(async (tx: EsportsDb) => {
        // The captain needs a player record: they are the one who will appear on the
        // roster, not just the one who administers.
        let captainId: string | undefined =
          ownership.status === "mine" ? ownership.playerId : undefined;
        if (!captainId) {
          const [captain] = await tx
            .insert(players)
            .values({ alias: captainAlias })
            .onConflictDoNothing()
            .returning({ id: players.id });
          // If someone took it between the check and the insert, it is not reused:
          // the team is born without a captain record and can be fixed afterwards.
          captainId = captain?.id;
        }

        const [team] = await tx
          .insert(teams)
          .values({ name, captainId: captainId ?? null, createdByUserId: user.id })
          .returning();

        if (captainId) {
          await tx
            .insert(playersToTeams)
            .values({ playerId: captainId, teamId: team.id, role: "captain" })
            .onConflictDoNothing();
        }

        return team;
      });

      return c.json({ data: created }, 201);
    }
  );

  /** Is this account in charge of this team? */
  async function isCaptain(teamId: string, userId: string) {
    const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
    if (!team) return null;
    return team.createdByUserId === userId ? team : false;
  }

  /**
   * Invites someone.
   *
   * Inviting by Discord HANDLE is allowed and not just by account: requiring that
   * the person had already registered is the reverse of the order in which it happens in
   * a community, where first they tell you "I'll sign you up" in chat.
   */
  app.post(
    "/public/teams/:id/invites",
    {
      id: "invite-to-team",
      summary: "Invite someone to my team",
      description:
        "The captain invites an account (`userId`) or a Discord handle (`handle`). Returns the invite with its `token` ONCE: that link is what you send. Expires in 7 days.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId, body: Invitation.optional() },
      output: { status: 201, schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const team = await isCaptain(c.req.param("id"), user.id);
      if (team === null) return c.json({ error: "Team not found" }, 404);
      if (!team) return c.json({ error: "Only the captain can invite." }, 403);

      const body = (await c.req.json().catch(() => ({}))) as {
        userId?: string;
        handle?: string;
        role?: RosterMember["role"];
      };
      if (!body.userId && !body.handle?.trim()) {
        return c.json({ error: "Say who you are inviting: `userId` or `handle`." }, 400);
      }

      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
      // 24 bytes (192 bits) in base64url: it is the credential that travels through a chat,
      // so it cannot be guessable or short.
      const token = randomBytes(24).toString("base64url");
      const [invite] = await db
        .insert(teamInvites)
        .values({
          teamId: team.id,
          invitedUserId: body.userId ?? null,
          invitedHandle: body.handle?.trim().slice(0, 120) ?? null,
          // The HASH is stored, like the guest link (`guest-access.ts`):
          // with the plain token, a copy of the database was enough to get into
          // any team with a pending invitation.
          token: hashInviteToken(token),
          role: body.role === "sub" ? "sub" : "player",
          invitedByUserId: user.id,
          expiresAt,
        })
        .returning();

      // The token comes out HERE and only here: it is what the captain forwards.
      return c.json({ data: { ...invite, token } }, 201);
    }
  );

  /** What this invitation is. No session: it is opened from a Discord link. */
  app.get(
    "/invites/:token",
    {
      id: "get-invitation",
      summary: "Read a team invite",
      description: "Team, role and status of an invite link, and whether it can still be used.",
      access: "public",
      input: { params: ParamToken },
      output: {
        schema: z.object({ data: Obj, usable: z.boolean(), reason: z.string().nullable() }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const [invite] = await db
        .select({
          id: teamInvites.id,
          status: teamInvites.status,
          role: teamInvites.role,
          expiresAt: teamInvites.expiresAt,
          teamName: teams.name,
        })
        .from(teamInvites)
        .innerJoin(teams, eq(teamInvites.teamId, teams.id))
        .where(inviteTokenMatches(c.req.param("token")))
        .limit(1);

      if (!invite) return c.json({ error: "Invitation not found" }, 404);

      const check = checkInvite(
        { status: invite.status as "pending", expiresAt: invite.expiresAt },
        new Date()
      );
      return c.json({ data: invite, usable: check.ok, reason: check.ok ? null : check.reason });
    }
  );

  /** Accepts. This is where a name on a list becomes a team. */
  app.post(
    "/invites/:token/accept",
    {
      id: "accept-invitation",
      summary: "Accept a team invite",
      description:
        "Joins the team with your player profile (or a new one with `alias`). An invite to a specific account only works for that account.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamToken, body: AcceptInvitation.optional() },
      output: { schema: z.object({ accepted: z.literal(true), teamId: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const body = (await c.req.json().catch(() => ({}))) as { alias?: string };

      const [invite] = await db
        .select()
        .from(teamInvites)
        .where(inviteTokenMatches(c.req.param("token")))
        .limit(1);
      if (!invite) return c.json({ error: "Invitation not found" }, 404);

      const check = checkInvite(
        { status: invite.status as "pending", expiresAt: invite.expiresAt },
        new Date()
      );
      if (!check.ok) return c.json({ error: check.reason }, 409);

      // If the invitation was for a specific ACCOUNT, only that account uses it. If
      // it was for a handle, the link is the credential and works for whoever has it
      // — which is the point of sending it privately.
      if (invite.invitedUserId && invite.invitedUserId !== user.id) {
        return c.json({ error: "This invitation is for another account." }, 403);
      }

      const alias = (body.alias ?? user.name ?? "").trim();
      if (!alias) return c.json({ error: "An alias is required for the roster." }, 400);
      if (alias.length > 200) return c.json({ error: "Alias too long." }, 400);

      // Same rule as when creating a team: with someone else's alias, their record does NOT
      // enter the roster. Before, whoever's it was got reused.
      const ownership = await aliasOwnership(db, alias, user.id);
      if (ownership.status === "taken") {
        return c.json({ error: `The alias "${alias}" is already in use. Choose another.` }, 409);
      }

      let alreadyUsed = false;
      await db.transaction(async (tx: EsportsDb) => {
        // The invitation is claimed FIRST and only if it is still pending: an
        // invitation by handle can be opened by anyone who has the link, and
        // without this condition two simultaneous acceptances put two people
        // into one spot.
        const [claimedOne] = await tx
          .update(teamInvites)
          .set({ status: "accepted", respondedAt: new Date(), invitedUserId: user.id })
          .where(and(eq(teamInvites.id, invite.id), eq(teamInvites.status, "pending")))
          .returning({ id: teamInvites.id });
        if (!claimedOne) {
          alreadyUsed = true;
          return;
        }

        let playerId: string | undefined =
          ownership.status === "mine" ? ownership.playerId : undefined;
        if (!playerId) {
          const [player] = await tx
            .insert(players)
            .values({ alias })
            .onConflictDoNothing()
            .returning({ id: players.id });
          playerId = player?.id;
        }

        if (playerId) {
          await tx
            .insert(playersToTeams)
            .values({ playerId, teamId: invite.teamId, role: invite.role })
            .onConflictDoNothing();
          // See `acceptedPlayerId` in the schema: it ties THIS player to whoever accepted
          await tx
            .update(teamInvites)
            .set({ acceptedPlayerId: playerId })
            .where(eq(teamInvites.id, invite.id));
        }
      });
      if (alreadyUsed) return c.json({ error: "This invitation has already been used." }, 409);

      return c.json({ accepted: true, teamId: invite.teamId });
    }
  );

  app.post(
    "/invites/:token/decline",
    {
      id: "reject-invitation",
      summary: "Decline a team invite",
      description:
        "Declines a pending invite. An invite to a specific account only that account can decline.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamToken },
      output: { schema: z.object({ declined: z.literal(true) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      // An invitation to a specific ACCOUNT can only be declined by that account: before,
      // anyone with the link could throw out someone else's.
      const [invite] = await db
        .select({ id: teamInvites.id, invitedUserId: teamInvites.invitedUserId })
        .from(teamInvites)
        .where(and(inviteTokenMatches(c.req.param("token")), eq(teamInvites.status, "pending")))
        .limit(1);
      if (!invite) return c.json({ error: "Invitation not found or already answered" }, 404);
      if (invite.invitedUserId && invite.invitedUserId !== user.id) {
        return c.json({ error: "This invitation is for another account." }, 403);
      }

      const [updated] = await db
        .update(teamInvites)
        .set({ status: "declined", respondedAt: new Date() })
        .where(and(eq(teamInvites.id, invite.id), eq(teamInvites.status, "pending")))
        .returning({ id: teamInvites.id });

      if (!updated) return c.json({ error: "Invitation not found or already answered" }, 404);
      return c.json({ declined: true });
    }
  );

  /** The roster, with the verdict on whether it can register yet. */
  app.get(
    "/public/teams/:id/roster",
    {
      id: "team-roster",
      summary: "Roster of a team",
      description:
        "The members of the team and, with `tournamentId`, whether the roster meets that tournament's size rules.",
      access: "public",
      input: {
        params: ParamId,
        query: query({ tournamentId: text("Tournament to check the roster against") }),
      },
      output: { schema: z.object({ data: z.array(Obj), check: Obj }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const teamId = c.req.param("id");
      const tournamentId = c.req.query("tournamentId");

      const roster = await db
        .select({ playerId: players.id, displayName: players.alias, role: playersToTeams.role })
        .from(playersToTeams)
        .innerJoin(players, eq(playersToTeams.playerId, players.id))
        .where(eq(playersToTeams.teamId, teamId));

      let rules = { minRosterSize: null as number | null, maxRosterSize: null as number | null };
      if (tournamentId) {
        const [t] = await db
          .select({
            minRosterSize: tournaments.minRosterSize,
            maxRosterSize: tournaments.maxRosterSize,
          })
          .from(tournaments)
          .where(eq(tournaments.id, tournamentId))
          .limit(1);
        if (t) rules = t;
      }

      const members = roster.map((r) => ({
        ...r,
        role: (r.role ?? "player") as RosterMember["role"],
      }));
      return c.json({ data: members, check: checkRoster(members, rules) });
    }
  );

  /**
   * Registers a TEAM.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * HERE THE ACCOUNT IS MANDATORY, AND IT IS NOT CONFIGURABLE
   *
   * A 1v1 admits guests with just their email; a team tournament does not. A
   * team needs a captain who answers, invitations that someone ACCEPTS and
   * a roster that is still the same next week — and none of that
   * rests on identities that are created and forgotten the same afternoon.
   *
   * It is enforced by construction: `requireAuth` here, and accepting an
   * invitation also requires it. Inviting by Discord handle remains valid
   * because the handle is only HOW the link arrives; joining the roster
   * still requires an account.
   * ───────────────────────────────────────────────────────────────────────────
   *
   * And the roster is validated BEFORE accepting: letting a team of three into
   * a 5v5 and finding out when generating the bracket means redoing the draw
   * with registration already closed.
   */
  app.post(
    "/public/tournament/:id/register-team",
    {
      id: "register-my-team",
      summary: "Sign up my team for a tournament",
      description:
        "The captain registers the team in a Team tournament: same rules as individual sign-up (window, capacity, waitlist, rules) and the roster must meet the size limits (422 with `issues`).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: TournamentParam, body: TeamRegistration.optional() },
      output: {
        status: 201,
        schema: z.object({ data: Row, roster: Obj, result: z.string() }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const tournamentId = c.req.param("id");
      const body = (await c.req.json().catch(() => ({}))) as {
        teamId?: string;
        acceptRules?: boolean;
      };
      if (!body.teamId) return c.json({ error: "`teamId` is required" }, 400);

      const [tournament] = await db
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, tournamentId))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);
      if (tournament.format !== "Team") {
        return c.json({ error: "This tournament is not a team tournament." }, 409);
      }

      const team = await isCaptain(body.teamId, user.id);
      if (team === null) return c.json({ error: "Team not found" }, 404);
      if (!team) return c.json({ error: "Only the captain can register the team." }, 403);

      const roster = await db
        .select({ playerId: players.id, displayName: players.alias, role: playersToTeams.role })
        .from(playersToTeams)
        .innerJoin(players, eq(playersToTeams.playerId, players.id))
        .where(eq(playersToTeams.teamId, team.id));

      const check = checkRoster(
        roster.map((r) => ({ ...r, role: (r.role ?? "player") as RosterMember["role"] })),
        { minRosterSize: tournament.minRosterSize, maxRosterSize: tournament.maxRosterSize }
      );
      if (!check.ok) return c.json({ error: "The roster does not comply", issues: check.issues }, 422);

      /**
       * The SAME rules as individual registration (`planRegistration`).
       * Before, nothing was checked here other than the format and the captain: a team
       * got in with registration closed, past the deadline, with the bracket made,
       * without accepting the rules or over the cap (phase D; see
       * tests/unit/esports-team-registration.test.ts).
       *
       * Per-tournament lock until the end of the request (`db` is its transaction):
       * without it, several registrations at once counted the same free slot
       * and all got in (an earlier audit; the same as in registration.routes.ts).
       */
      await db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`esports:registration:${tournamentId}`}))`
      );
      const participants = await db
        .select({
          teamId: tournamentParticipants.teamId,
          registeredByUserId: tournamentParticipants.registeredByUserId,
          waitlistPosition: tournamentParticipants.waitlistPosition,
          id: tournamentParticipants.id,
        })
        .from(tournamentParticipants)
        .where(eq(tournamentParticipants.tournamentId, tournamentId));
      const [withBracket] = await db
        .select({ id: matches.id })
        .from(matches)
        .where(eq(matches.tournamentId, tournamentId))
        .limit(1);
      const queued = participants.filter((p) => p.waitlistPosition !== null);
      const plan = planRegistration(
        {
          registrationMode: tournament.registrationMode as RegistrationMode,
          registrationOpensAt: tournament.registrationOpensAt,
          registrationClosesAt: tournament.registrationClosesAt,
          maxParticipants: tournament.maxParticipants,
          waitlistEnabled: tournament.waitlistEnabled,
          requiresRulesAcceptance: tournament.requiresRulesAcceptance,
          isTeamEvent: true,
          allowGuestRegistration: tournament.allowGuestRegistration,
          bracketGenerated: Boolean(withBracket),
        },
        { registered: participants.length - queued.length, waitlisted: queued.length },
        {
          acceptedRules: body.acceptRules === true,
          alreadyRegistered: participants.some(
            (p) => p.teamId === team.id || p.registeredByUserId === user.id
          ),
          isGuest: false,
        },
        new Date()
      );
      if (!plan.ok) return c.json({ error: plan.reason, state: plan.state }, 409);

      const waitlisted = plan.result === "waitlisted";
      const [participant] = await db
        .insert(tournamentParticipants)
        .values({
          tournamentId,
          teamId: team.id,
          status: plan.result === "pending_approval" ? "Pending" : "Approved",
          registeredByUserId: user.id,
          waitlistPosition: waitlisted
            ? nextWaitlistPosition(
                queued.map((p) => ({ participantId: p.id, waitlistPosition: p.waitlistPosition! }))
              )
            : null,
          acceptedRulesAt: body.acceptRules ? new Date() : null,
        })
        .onConflictDoNothing()
        .returning();

      if (!participant) return c.json({ error: "This team is already registered." }, 409);
      return c.json({ data: participant, roster: check, result: plan.result }, 201);
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // Where it is played
  // ═════════════════════════════════════════════════════════════════════════

  app.post(
    "/tournament/:id/stations",
    {
      id: "create-station",
      summary: "Create a station",
      description:
        "A place to play: a physical setup or an online lobby (with its access details). Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: TournamentParam, body: Station.optional() },
      output: { status: 201, schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        name?: string;
        kind?: "physical" | "lobby";
        accessDetails?: string;
      };
      if (!body.name?.trim()) return c.json({ error: "A name is required" }, 400);

      const [created] = await db
        .insert(stations)
        .values({
          tournamentId: c.req.param("id"),
          name: body.name.trim(),
          kind: body.kind === "lobby" ? "lobby" : "physical",
          accessDetails: body.accessDetails?.trim() || null,
        })
        .returning();

      return c.json({ data: created }, 201);
    }
  );

  app.get(
    "/tournament/:id/stations",
    {
      id: "list-stations",
      summary: "List stations",
      description:
        "The stations of the tournament with their access details. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: TournamentParam },
      output: { schema: withData(z.array(Row)) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const rows = await db
        .select()
        .from(stations)
        .where(eq(stations.tournamentId, c.req.param("id")))
        .orderBy(asc(stations.name));
      return c.json({ data: rows });
    }
  );

  /**
   * Assigns a spot to a set, and notifies both.
   *
   * Both things in the same transaction: assigning without notifying is exactly
   * as useless as not assigning — nobody is watching the web.
   */
  app.post(
    "/match/:matchId/station",
    {
      id: "assign-station",
      summary: "Assign a station to a set",
      description:
        "Assigns a station (`stationId`, or null to free it) and notifies both players in the same transaction. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      idempotent: true,
      input: { params: ParamSet, body: AssignStation.optional() },
      output: { schema: z.object({ assigned: z.boolean(), station: Row.nullable() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const body = (await c.req.json().catch(() => ({}))) as { stationId?: string | null };

      const [match] = await db
        .select()
        .from(matches)
        .where(eq(matches.id, c.req.param("matchId")))
        .limit(1);
      if (!match) return c.json({ error: "Match not found" }, 404);

      let station: typeof stations.$inferSelect | null = null;
      if (body.stationId) {
        const [row] = await db
          .select()
          .from(stations)
          .where(eq(stations.id, body.stationId))
          .limit(1);
        if (!row) return c.json({ error: "Station not found" }, 404);
        if (row.tournamentId !== match.tournamentId) {
          return c.json({ error: "That station belongs to another tournament." }, 409);
        }
        station = row;
      }

      // In series: the request transaction is one connection (docs/kons/README.md).
      const a = await recipientOf(match.participant1Id);
      const b = await recipientOf(match.participant2Id);

      await db.transaction(async (tx: EsportsDb) => {
        await tx
          .update(matches)
          .set({ stationId: station?.id ?? null, updatedAt: new Date() })
          .where(eq(matches.id, match.id));

        if (station) {
          await tx.update(stations).set({ status: "in_use" }).where(eq(stations.id, station.id));

          await enqueue(
            tx,
            match.tournamentId,
            planMatchReady({
              matchId: match.id,
              bracketMatchId: match.bracketMatchId,
              roundLabel: `Round ${match.round}`,
              sides: [a, b],
              station: { name: station.name, accessDetails: station.accessDetails },
            })
          );
        }
      });

      return c.json({ assigned: Boolean(station), station });
    }
  );

  /**
   * Where I play. **Only the two in the set and the organization.**
   *
   * It is the route that delivers the room code, and publishing it is inviting anyone
   * to come in and wreck the game — the classic problem of online
   * tournaments.
   */
  app.get(
    "/match/:matchId/where",
    {
      id: "where-do-i-play",
      summary: "Where a set is played",
      description:
        "The station of the set; the access details (room code) only for the two players and the organization.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamSet },
      output: { schema: withData(Obj.nullable()) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const [match] = await db
        .select()
        .from(matches)
        .where(eq(matches.id, c.req.param("matchId")))
        .limit(1);
      if (!match) return c.json({ error: "Match not found" }, 404);
      if (!match.stationId) return c.json({ data: null });

      const [station] = await db
        .select()
        .from(stations)
        .where(eq(stations.id, match.stationId))
        .limit(1);
      if (!station) return c.json({ data: null });

      const playing = await isInMatch(match, user.id);

      return c.json({
        data: {
          name: station.name,
          kind: station.kind,
          // The access detail ONLY for whoever plays. Everyone else sees that a room
          // exists, which is harmless information and useful for production.
          accessDetails: playing ? station.accessDetails : null,
        },
      });
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // Broadcast
  // ═════════════════════════════════════════════════════════════════════════

  app.post(
    "/tournament/:id/streams",
    {
      id: "create-stream",
      summary: "Add a stream to a tournament",
      description:
        "Adds a channel (twitch, youtube or kick), public by default or for registered viewers. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: TournamentParam, body: Emission.optional() },
      output: { status: 201, schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        platform?: StreamPlatform;
        channel?: string;
        title?: string;
        viewerAccess?: ViewerAccess;
        isPrimary?: boolean;
      };

      if (!body.platform || !["twitch", "youtube", "kick"].includes(body.platform)) {
        return c.json({ error: "`platform` must be twitch, youtube or kick" }, 400);
      }
      if (!body.channel?.trim()) return c.json({ error: "The channel is required" }, 400);

      const [created] = await db
        .insert(streams)
        .values({
          tournamentId: c.req.param("id"),
          platform: body.platform,
          channel: body.channel.trim(),
          title: body.title?.trim() || null,
          // PUBLIC by default: the stream is the tournament's showcase. Asking for
          // an account to watch it closes the door precisely on those who are not yet part of the
          // community. `registered` is left for whoever wants it on purpose.
          viewerAccess: body.viewerAccess === "registered" ? "registered" : "public",
          isPrimary: body.isPrimary === true,
        })
        .returning();

      return c.json({ data: created }, 201);
    }
  );

  /**
   * The stream, for the public web.
   *
   * `auth.optionalAuth` and not `requireAuth`: we need to KNOW whether there is a session
   * to decide, but an anonymous visitor has to be able to see that the tournament is broadcast
   * —and that an account is needed— instead of an unexplained 401.
   *
   * What this door does and does not do: it blocks Kitsuden's page and embed.
   * The Twitch channel is still public ON Twitch. It is a door, not a lock,
   * and that is why the channel does not travel if it cannot be viewed.
   */
  app.get(
    "/public/tournament/:id/streams",
    {
      id: "tournament-streams",
      summary: "Streams of a tournament",
      description:
        "The channels of the tournament with their embed URL. A stream for registered viewers says `allowed: false` (and hides the channel) to anonymous visitors.",
      access: "optional",
      input: { params: TournamentParam },
      output: { schema: withData(z.array(Obj)) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const user = c.get("user");
      const rows = await db
        .select()
        .from(streams)
        .where(eq(streams.tournamentId, c.req.param("id")))
        .orderBy(asc(streams.createdAt));

      // The embed domain comes from the request: Twitch requires the
      // `parent` to be EXACTLY the host that loads the iframe, and keeping it in an
      // environment variable breaks it as soon as there is a secondary domain.
      const host = new URL(c.req.url).hostname;

      return c.json({
        data: rows.map((row) => {
          const allowed = canWatch(row.viewerAccess as ViewerAccess, Boolean(user));
          return {
            id: row.id,
            platform: row.platform,
            title: row.title,
            isPrimary: row.isPrimary,
            viewerAccess: row.viewerAccess,
            allowed,
            channel: allowed ? row.channel : null,
            url: allowed ? channelUrl(row.platform as StreamPlatform, row.channel) : null,
            embedUrl: allowed ? embedUrl(row.platform as StreamPlatform, row.channel, host) : null,
          };
        }),
      });
    }
  );

  /** The queue: which sets go on camera and in what order. */
  app.get(
    "/tournament/:id/stream-queue",
    {
      id: "stream-queue",
      summary: "Stream queue",
      description:
        "The sets queued for the stream, in order, with both sides named. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: TournamentParam },
      output: { schema: withData(z.array(Obj)) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c: C) => {
      const rows = await db
        .select({
          matchId: matches.id,
          bracketMatchId: matches.bracketMatchId,
          position: matches.streamQueuePosition,
          streamId: matches.streamId,
          participant1Id: matches.participant1Id,
          participant2Id: matches.participant2Id,
        })
        .from(matches)
        .where(
          and(
            eq(matches.tournamentId, c.req.param("id")),
            sql`${matches.streamQueuePosition} IS NOT NULL`
          )
        )
        .orderBy(asc(matches.streamQueuePosition));

      // In series: the request transaction is one connection (docs/kons/README.md).
      const named = [];
      for (const row of rows) {
        named.push({
          ...row,
          sides: [await recipientOf(row.participant1Id), await recipientOf(row.participant2Id)],
        });
      }

      return c.json({ data: named });
    }
  );

  /**
   * Puts a set in the queue, moves it, or removes it (`position: null`).
   *
   * The whole queue is rewritten with dense positions: it is operated by dragging in
   * a booth in a hurry, and a gap in the numbering reads as a tool
   * error.
   */
  app.post(
    "/match/:matchId/stream-queue",
    {
      id: "move-in-stream-queue",
      summary: "Queue, move or unqueue a set for the stream",
      description:
        "Puts the set at `position` (default 1) of the stream queue, or takes it out with `position: null`; the queue is rewritten densely and the players are told they go on stream. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      idempotent: true,
      input: { params: ParamSet, body: QueuePosition.optional() },
      output: { schema: z.object({ queue: z.array(Obj) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c: C) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        position?: number | null;
        streamId?: string;
      };

      const [match] = await db
        .select()
        .from(matches)
        .where(eq(matches.id, c.req.param("matchId")))
        .limit(1);
      if (!match) return c.json({ error: "Match not found" }, 404);

      const streamId = body.streamId ?? match.streamId ?? null;
      let stream: typeof streams.$inferSelect | null = null;
      if (streamId) {
        const [row] = await db.select().from(streams).where(eq(streams.id, streamId)).limit(1);
        if (!row) return c.json({ error: "Stream not found" }, 404);
        if (row.tournamentId !== match.tournamentId) {
          return c.json({ error: "That channel belongs to another tournament." }, 409);
        }
        stream = row;
      }

      const current = await db
        .select({ matchId: matches.id, position: matches.streamQueuePosition })
        .from(matches)
        .where(
          and(
            eq(matches.tournamentId, match.tournamentId),
            sql`${matches.streamQueuePosition} IS NOT NULL`
          )
        );

      const desired = body.position === undefined ? 1 : body.position;
      const next = planQueue(
        current.map((r) => ({ matchId: r.matchId, position: r.position! })),
        match.id,
        desired
      );

      const a = await recipientOf(match.participant1Id);
      const b = await recipientOf(match.participant2Id);

      await db.transaction(async (tx: EsportsDb) => {
        // Those that left the queue are set to null, and the position is set for those that
        // remain. Rewriting the whole queue is cheap (it is short) and avoids the
        // half-done state that leaves two sets in the same position.
        const stayingIds = new Set(next.map((q) => q.matchId));
        const removed = current.filter((r) => !stayingIds.has(r.matchId)).map((r) => r.matchId);
        if (removed.length > 0) {
          await tx
            .update(matches)
            .set({ streamQueuePosition: null, streamId: null })
            .where(inArray(matches.id, removed));
        }

        for (const entry of next) {
          await tx
            .update(matches)
            .set({
              streamQueuePosition: entry.position,
              ...(entry.matchId === match.id ? { streamId: stream?.id ?? null } : {}),
            })
            .where(eq(matches.id, entry.matchId));
        }

        if (desired !== null && stream) {
          await enqueue(
            tx,
            match.tournamentId,
            planStreamCall({
              matchId: match.id,
              bracketMatchId: match.bracketMatchId,
              roundLabel: `Round ${match.round}`,
              sides: [a, b],
              stream: { platform: stream.platform, channel: stream.channel },
            })
          );
        }
      });

      return c.json({ queue: next });
    }
  );

  return app.ops;
}

/** Re-exported types for whoever builds a bot against this. */
export type { NotificationType };
