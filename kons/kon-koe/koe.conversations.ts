/**
 * Conversations: changing state, assigning, SLAs
 * ============================================================================
 *
 * Every change of state goes through `changeState()`: it locks the row (`FOR UPDATE`), asks the state
 * machine (koe.states.ts), writes the row and its history event in the same transaction, then tells the
 * inbox and the automation rules. Two people pressing "take" at once: the second waits for the lock, finds
 * the conversation already `human` with someone else, and gets a 409.
 *
 * Assignment: `round_robin` (the next available member after the last one given), `load` (the available
 * member with the fewest open conversations), `manual` (stays queued). A member is available when marked
 * so and below their `max_concurrent`.
 */

import { AppError } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import { emit, newId, type Db } from "./koe.common";
import { reportAccess } from "./koe.extensions";
import { conversationChanged, toUser } from "./koe.realtime";
import { koeConversationEvents, koeConversations, koeMembers, koeTeamMembers, koeTeams, type Conversation, type ConversationState } from "./koe.schema";
import { transition, TransitionError, type Trigger } from "./koe.states";

export interface Actor {
  kind: "agent" | "bot" | "ai" | "rule" | "campaign" | "system" | "contact";
  id?: string | null;
}

export interface ChangeInput {
  trigger: Trigger;
  to?: ConversationState;
  assigneeId?: string | null;
  snoozedUntil?: Date | null;
  reason?: string;
  teamId?: string | null;
}

async function locked(db: Db, id: string): Promise<Conversation> {
  const rows = await db.select().from(koeConversations).where(eq(koeConversations.id, id)).for("update");
  const row = rows[0] as Conversation | undefined;
  if (!row) throw AppError.notFound("Conversation not found");
  return row;
}

export async function recordEvent(
  db: Db,
  conversationId: string,
  type: string,
  actor: Actor,
  fields: { from?: string | null; to?: string | null; reason?: string | null; data?: Record<string, unknown> } = {}
): Promise<void> {
  await db.insert(koeConversationEvents).values({
    id: newId(),
    conversationId,
    type,
    fromState: fields.from ?? null,
    toState: fields.to ?? null,
    actorKind: actor.kind,
    actorId: actor.id ?? null,
    reason: fields.reason ?? null,
    data: fields.data ?? {},
  });
}

/** SLA deadlines a team sets, from now. */
async function slaFor(db: Db, teamId: string | null, now: Date): Promise<{ firstResponseDueAt: Date | null; resolutionDueAt: Date | null }> {
  if (!teamId) return { firstResponseDueAt: null, resolutionDueAt: null };
  const [team] = await db.select().from(koeTeams).where(eq(koeTeams.id, teamId)).limit(1);
  return {
    firstResponseDueAt: team?.slaFirstResponseS ? new Date(now.getTime() + team.slaFirstResponseS * 1000) : null,
    resolutionDueAt: team?.slaResolutionS ? new Date(now.getTime() + team.slaResolutionS * 1000) : null,
  };
}

/** The one way to change who answers a conversation. Returns the updated row. */
export async function changeState(ctx: KonContext, db: Db, conversationId: string, input: ChangeInput, actor: Actor): Promise<Conversation> {
  const current = await locked(db, conversationId);
  let result;
  try {
    result = transition({
      from: current.state,
      trigger: input.trigger,
      to: input.to,
      assigneeId: input.assigneeId,
      currentAssigneeId: current.assigneeId,
      snoozedUntil: input.snoozedUntil,
    });
  } catch (err) {
    if (err instanceof TransitionError) {
      if (input.trigger === "assign" && current.state === "human") throw AppError.conflict(`Already being answered${current.assigneeId === input.assigneeId ? " by you" : " by someone else"}`);
      throw AppError.conflict(err.message);
    }
    throw err;
  }

  if (result.to === "human" && result.assigneeId) {
    const [member] = await db.select({ userId: koeMembers.userId }).from(koeMembers).where(eq(koeMembers.userId, result.assigneeId)).limit(1);
    if (!member) throw AppError.validation("That person is not a koe member");
  }

  const now = new Date();
  const teamId = input.teamId !== undefined ? input.teamId : current.teamId;
  const patch: Partial<Conversation> & Record<string, unknown> = {
    state: result.to,
    assigneeId: result.assigneeId,
    snoozedUntil: result.snoozedUntil,
    teamId,
    updatedAt: now,
  };
  if (result.to === "resolved") {
    patch.resolvedAt = now;
    patch.unreadCount = 0;
  }
  if (current.state === "resolved" && result.to !== "resolved") {
    patch.resolvedAt = null;
    patch.slaBreached = false;
    patch.firstRespondedAt = null;
    patch.firstResponseDueAt = null;
    patch.resolutionDueAt = null;
    patch.botFailures = 0;
  }
  // Entering the queue (or a person's hands) starts the team's clocks, once per opening.
  const reopening = current.state === "resolved";
  if ((result.to === "queued" || result.to === "human") && (reopening || (!current.firstResponseDueAt && !current.firstRespondedAt))) {
    Object.assign(patch, await slaFor(db, teamId, now));
  }

  const [updated] = (await db.update(koeConversations).set(patch).where(eq(koeConversations.id, conversationId)).returning()) as Conversation[];
  await reportAccess({ ctx, db, kind: "state", conversationId, contactId: current.contactId, actor: { kind: actor.kind, id: actor.id ?? null }, detail: { from: current.state, to: result.to, trigger: input.trigger } });
  await recordEvent(db, conversationId, "state", actor, {
    from: current.state,
    to: result.to,
    reason: input.reason ?? input.trigger,
    data: { trigger: input.trigger, assigneeId: result.assigneeId, previousAssigneeId: current.assigneeId, teamId },
  });

  emit(ctx, "conversation.state_changed", {
    conversationId,
    from: current.state,
    to: result.to,
    trigger: input.trigger,
    assigneeId: result.assigneeId,
    teamId,
    channelId: current.channelId,
    contactId: current.contactId,
  });
  if (result.assigneeId && result.assigneeId !== current.assigneeId && result.to === "human") {
    emit(ctx, "conversation.assigned", { conversationId, assigneeId: result.assigneeId, teamId, by: actor.id ?? actor.kind });
    toUser(ctx, result.assigneeId, { type: "assigned", conversationId });
  }
  if (input.trigger === "handoff") {
    emit(ctx, "handoff.requested", { conversationId, teamId, reason: input.reason ?? null, channelId: current.channelId });
  }
  if (result.to === "resolved") emit(ctx, "conversation.resolved", { conversationId, teamId, assigneeId: current.assigneeId, channelId: current.channelId });
  conversationChanged(ctx, updated!, `state:${result.to}`);
  return updated!;
}

/** Open conversations a member holds now. */
export async function loadOf(db: Db, userIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(userIds.map((u) => [u, 0]));
  if (userIds.length === 0) return out;
  const rows = (await db
    .select({ userId: koeConversations.assigneeId, n: sql<number>`count(*)::int` })
    .from(koeConversations)
    .where(and(inArray(koeConversations.assigneeId, userIds), inArray(koeConversations.state, ["human", "snoozed"])))
    .groupBy(koeConversations.assigneeId)) as Array<{ userId: string; n: number }>;
  for (const r of rows) out.set(r.userId, Number(r.n));
  return out;
}

/**
 * Picks who should get a queued conversation of this team, or null (manual team, nobody available,
 * everybody full). Does not assign: the caller does, through changeState.
 */
export async function pickAssignee(db: Db, teamId: string): Promise<string | null> {
  const [team] = await db.select().from(koeTeams).where(eq(koeTeams.id, teamId)).limit(1);
  if (!team || team.assignment === "manual") return null;
  const members = (await db
    .select({ userId: koeMembers.userId, max: koeMembers.maxConcurrent })
    .from(koeTeamMembers)
    .innerJoin(koeMembers, eq(koeMembers.userId, koeTeamMembers.userId))
    .where(and(eq(koeTeamMembers.teamId, teamId), eq(koeMembers.available, true)))
    .orderBy(asc(koeMembers.userId))) as Array<{ userId: string; max: number }>;
  if (members.length === 0) return null;
  const load = await loadOf(
    db,
    members.map((m) => m.userId)
  );
  const free = members.filter((m) => (load.get(m.userId) ?? 0) < m.max);
  if (free.length === 0) return null;
  if (team.assignment === "load") {
    return free.reduce((best, m) => ((load.get(m.userId) ?? 0) < (load.get(best.userId) ?? 0) ? m : best)).userId;
  }
  // Round robin: the first free member after the last one given.
  const last = team.lastAssignedUserId;
  const i = last ? members.findIndex((m) => m.userId === last) : -1;
  const ordered = [...members.slice(i + 1), ...members.slice(0, i + 1)];
  const next = ordered.find((m) => free.some((f) => f.userId === m.userId));
  if (!next) return null;
  await db.update(koeTeams).set({ lastAssignedUserId: next.userId }).where(eq(koeTeams.id, teamId));
  return next.userId;
}

/** Queued conversation → a person, when the team assigns automatically and someone is free. */
export async function autoAssign(ctx: KonContext, db: Db, conversation: Conversation): Promise<Conversation> {
  if (conversation.state !== "queued" || !conversation.teamId) return conversation;
  const who = await pickAssignee(db, conversation.teamId);
  if (!who) return conversation;
  return changeState(ctx, db, conversation.id, { trigger: "assign", assigneeId: who, reason: "auto-assign" }, { kind: "system" });
}

/** Moves the conversation to another team (and back to the queue if a person had it). */
export async function transfer(ctx: KonContext, db: Db, conversationId: string, teamId: string | null, actor: Actor): Promise<Conversation> {
  const current = await locked(db, conversationId);
  if (teamId) {
    const [team] = await db.select({ id: koeTeams.id }).from(koeTeams).where(eq(koeTeams.id, teamId)).limit(1);
    if (!team) throw AppError.validation("Team not found");
  }
  let updated: Conversation;
  if (current.state === "human") {
    updated = await changeState(ctx, db, conversationId, { trigger: "release", teamId, reason: "transfer" }, actor);
  } else {
    [updated] = (await db.update(koeConversations).set({ teamId, updatedAt: new Date() }).where(eq(koeConversations.id, conversationId)).returning()) as Conversation[];
    await recordEvent(db, conversationId, "transfer", actor, { data: { from: current.teamId, to: teamId } });
    conversationChanged(ctx, updated!, "transfer");
  }
  return updated.state === "queued" ? autoAssign(ctx, db, updated) : updated;
}

/** Open conversations of a person, other than this one (for "you have N open"). */
export async function openCountOf(db: Db, userId: string, except?: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(koeConversations)
    .where(and(eq(koeConversations.assigneeId, userId), eq(koeConversations.state, "human"), except ? ne(koeConversations.id, except) : sql`true`));
  return Number(row?.n ?? 0);
}
