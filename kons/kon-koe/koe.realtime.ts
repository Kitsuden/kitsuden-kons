/**
 * Live inbox: koe's realtime channels and who may hear them
 * ============================================================================
 *
 * Channels (on the core's WebSocket, `/api/realtime`, as `kon:koe:<rest>`):
 *
 *   inbox                 any koe member: "conversation X changed" (ids and state only, never content)
 *   conversation:<id>     whoever may see that conversation: new messages, statuses, typing, collisions
 *   user:<userId>         that person: assignments, mentions, notices
 *   visitor:<capability>  one web chat visitor (anonymous): `ctx.realtime.capability` over the visitor hash, keyed
 *                         by the installation's secret. Staff read the hash (it is the contact's identity) but
 *                         cannot turn it into the channel; only the visitor, who proves their key, is told it.
 *
 * What travels is small on purpose: the client re-reads through the REST operations, which apply row-level
 * security. The authorizer is asked on subscribe and again every minute (core: lib/realtime-kon-channels.ts),
 * so a conversation reassigned to someone else stops reaching the previous agent within a minute.
 */

import { asSystem } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq } from "drizzle-orm";

import { dbOf, type Db } from "./koe.common";
import { koeConversations, koeMembers, koeTeamMembers } from "./koe.schema";

export const channelOf = {
  inbox: () => "kon:koe:inbox",
  conversation: (id: string) => `kon:koe:conversation:${id}`,
  user: (id: string) => `kon:koe:user:${id}`,
  /** Takes the capability, never the stored hash: see visitorChannel(). */
  visitor: (capability: string) => `kon:koe:visitor:${capability}`,
};

/**
 * The realtime channel of the web chat visitor whose key hashes to `hash`, or null on a host without
 * capabilities (or without a secrets key): then nobody broadcasts to the visitor and the widget polls.
 */
export function visitorChannel(ctx: KonContext, hash: string): string | null {
  const capability = (ctx.realtime as { capability?: (material: string) => string } | undefined)?.capability;
  if (typeof capability !== "function") return null;
  try {
    return channelOf.visitor(capability.call(ctx.realtime, `visitor:${hash}`));
  } catch {
    return null;
  }
}

const rest = {
  conversation: /^conversation:([A-Za-z0-9_-]{1,100})$/,
  user: /^user:([A-Za-z0-9_-]{1,100})$/,
  visitor: /^visitor:([a-f0-9]{64})$/,
};

/** A person's role in koe, or null. Kitsuden admins are koe admins. */
export async function koeRoleOf(db: Db, user: { id: string | null; role: string | null }): Promise<string | null> {
  if (!user.id) return null;
  if (user.role === "admin") return "admin";
  const [m] = (await asSystem(() => db.select({ role: koeMembers.role }).from(koeMembers).where(eq(koeMembers.userId, user.id!)).limit(1))) as unknown[];
  return (m as { role?: string } | undefined)?.role ?? null;
}

/** The same rule as `koe_sees()` in the migration, for code that runs outside a request. */
export async function maySeeConversation(db: Db, user: { id: string | null; role: string | null }, conversationId: string): Promise<boolean> {
  const role = await koeRoleOf(db, user);
  if (!role) return false;
  if (role === "admin" || role === "supervisor") return true;
  const [c] = (await asSystem(() =>
    db.select({ teamId: koeConversations.teamId, assigneeId: koeConversations.assigneeId }).from(koeConversations).where(eq(koeConversations.id, conversationId)).limit(1)
  )) as unknown[];
  if (!c) return false;
  const conv = c as { teamId: string | null; assigneeId: string | null };
  if (conv.assigneeId && conv.assigneeId === user.id) return true;
  if (!conv.teamId) return !conv.assigneeId;
  const [t] = (await asSystem(() =>
    db.select({ u: koeTeamMembers.userId }).from(koeTeamMembers).where(and(eq(koeTeamMembers.teamId, conv.teamId!), eq(koeTeamMembers.userId, user.id!))).limit(1)
  )) as unknown[];
  return !!t;
}

/** `ctx.realtime.channels` arrived with Kitsuden's kon realtime channels; an older host does not have it. */
type ChannelsCapable = {
  channels?: (authorize: (rest: string, user: { id: string | null; role: string | null }) => boolean | Promise<boolean>) => void;
};

export function registerRealtime(ctx: KonContext): void {
  const realtime = ctx.realtime as unknown as ChannelsCapable;
  if (!realtime.channels) {
    ctx.logger.warn("koe: this host has no kon realtime channels; the inbox will refresh by polling");
    return;
  }
  realtime.channels(async (channel, user) => {
    const db = dbOf(ctx);
    if (channel === "inbox") return (await koeRoleOf(db, user)) !== null;
    const v = rest.visitor.exec(channel);
    if (v) return true; // the name is a capability only the visitor is told (visitorChannel)
    const u = rest.user.exec(channel);
    if (u) return !!user.id && u[1] === user.id;
    const c = rest.conversation.exec(channel);
    if (c) return maySeeConversation(db, user, c[1]!);
    return false;
  });
}

/** Fire-and-forget: the realtime host may be absent (tests, a host without WebSocket). */
export function publish(ctx: KonContext, channel: string, message: Record<string, unknown>): void {
  try {
    ctx.realtime.broadcast(channel, message);
  } catch {
    /* nobody listening */
  }
}

export function toUser(ctx: KonContext, userId: string, message: Record<string, unknown>): void {
  publish(ctx, channelOf.user(userId), message);
}

/** What changed in a conversation, for the inbox list and the open thread. */
export function conversationChanged(
  ctx: KonContext,
  conversation: { id: string; state: string; teamId: string | null; assigneeId: string | null },
  change: string,
  extra: Record<string, unknown> = {}
): void {
  const summary = { type: "conversation", change, id: conversation.id, state: conversation.state, teamId: conversation.teamId, assigneeId: conversation.assigneeId };
  publish(ctx, channelOf.inbox(), summary);
  publish(ctx, channelOf.conversation(conversation.id), { ...summary, ...extra });
}
