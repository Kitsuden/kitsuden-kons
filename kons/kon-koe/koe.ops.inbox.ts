/**
 * The inbox: conversations, messages, notes, contacts, notices — for people and for agents (MCP)
 * ============================================================================
 *
 * Every operation runs in the request's RLS transaction: a koe agent only finds the conversations of their
 * teams, the ones assigned to them and unassigned ones without a team; supervisors and admins see all.
 * Changing who answers goes through changeState() (koe.conversations.ts); sending through send()
 * (koe.send.ts). Nothing here talks to Meta directly.
 */

import { AppError } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, desc, eq, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { adapterOf } from "./channels";
import { authOf, publicChannel } from "./koe.channels";
import { dbOf, emit, newId, QUEUES, type Db } from "./koe.common";
import { changeState, transfer } from "./koe.conversations";
import { channelOf, publish } from "./koe.realtime";
import { requireLead, requireMember, USE } from "./koe.policy";
import {
  koeChannels,
  koeConsents,
  koeContacts,
  koeConversationEvents,
  koeConversations,
  koeIdentities,
  koeMedia,
  koeMembers,
  koeMessages,
  koeNotes,
  koeNotices,
  koePushSubscriptions,
  koeTeamMembers,
  koeTeams,
  koeTemplates,
  type Channel,
  type Contact,
  type Conversation,
  type Media,
  type Message,
} from "./koe.schema";
import { send } from "./koe.send";
import { isPushEndpoint, vapidKeys } from "./koe.notify";
import { reportAccess } from "./koe.extensions";
import { checkWindow, windowOf } from "./koe.window";
import { Output, ParamId, type OperationsModule } from "./operations";
import { queue } from "@kitsuden/engine";

const STATES = ["bot", "queued", "human", "snoozed", "resolved"] as const;

const InteractiveSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("buttons"),
    body: z.string().min(1).max(1024),
    header: z.string().max(60).optional(),
    footer: z.string().max(60).optional(),
    buttons: z.array(z.object({ id: z.string().min(1).max(256), title: z.string().min(1).max(20) })).min(1).max(3),
  }),
  z.object({
    type: z.literal("list"),
    body: z.string().min(1).max(4096),
    header: z.string().max(60).optional(),
    footer: z.string().max(60).optional(),
    button: z.string().min(1).max(20),
    sections: z
      .array(z.object({ title: z.string().max(24).optional(), rows: z.array(z.object({ id: z.string().min(1).max(200), title: z.string().min(1).max(24), description: z.string().max(72).optional() })).min(1).max(10) }))
      .min(1)
      .max(10),
  }),
  z.object({ type: z.literal("url"), body: z.string().min(1).max(1024), text: z.string().min(1).max(20), url: z.string().url().max(2000) }),
]);

export const SendBody = z.object({
  kind: z.enum(["text", "image", "audio", "voice", "video", "document", "sticker", "template", "interactive", "location", "contacts", "reaction"]).default("text"),
  body: z.string().max(4096).optional().describe("Text, or the caption of a media"),
  mediaId: z.string().min(1).max(100).optional().describe("A koe media id (upload it first with upload-media)"),
  template: z
    .object({
      templateId: z.string().min(1).max(100),
      values: z.record(z.string(), z.string().max(1024)).optional().describe('Slot → value: "1", "2"… or named; "button_<i>" for URL buttons, "code" for copy-code'),
      headerMediaId: z.string().max(100).optional(),
    })
    .optional(),
  interactive: InteractiveSchema.optional(),
  location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), name: z.string().max(200).optional(), address: z.string().max(500).optional() }).optional(),
  reaction: z.object({ messageId: z.string().min(1).max(100), emoji: z.string().max(16) }).optional(),
  replyToMessageId: z.string().max(100).optional(),
  idempotencyKey: z.string().min(8).max(200).optional().describe("Sending twice with the same key sends once"),
  take: z.boolean().optional().describe("Default true: replying to an unassigned conversation takes it"),
});

const ListQuery = z.object({
  state: z.enum([...STATES, "open", "all"]).default("open").describe("`open` = everything but resolved"),
  assignee: z.string().max(100).optional().describe("`me`, `none`, or a user id"),
  teamId: z.string().max(100).optional(),
  channelId: z.string().max(100).optional(),
  label: z.string().max(60).optional(),
  q: z.string().max(200).optional().describe("Name, phone or email of the contact"),
  before: z.string().datetime().optional().describe("Cursor: last_message_at of the last row you have"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** A conversation for the list or the header of a thread. */
function view(conv: Conversation, contact: Partial<Contact> | null, channel: Channel | null) {
  const w = channel ? windowOf(channel.kind, conv.lastInboundAt, conv.freeEntryUntil) : null;
  return {
    ...conv,
    contact: contact ? { id: contact.id, displayName: contact.displayName, phone: contact.phone, email: contact.email, blocked: contact.blocked } : null,
    channel: channel ? { id: channel.id, kind: channel.kind, name: channel.name, display: channel.display } : null,
    window: w ? { open: w.open, expiresAt: w.expiresAt, humanAgentUntil: w.humanAgentUntil } : null,
  };
}

async function signedMedia(ctx: KonContext, m: Media | null) {
  if (!m) return null;
  const url = m.storageKey ? await ctx.storage.getSignedDownloadUrl(m.storageKey, 3600).catch(() => null) : null;
  const playable = m.playableKey ? await ctx.storage.getSignedDownloadUrl(m.playableKey, 3600).catch(() => null) : null;
  return { id: m.id, kind: m.kind, mime: m.mime, filename: m.filename, sizeBytes: m.sizeBytes, durationMs: m.durationMs, status: m.status, animated: m.animated, waveform: m.waveform, transcript: m.transcript, url, playableUrl: playable };
}

async function conversationOr404(db: Db, id: string): Promise<Conversation> {
  const [c] = (await db.select().from(koeConversations).where(eq(koeConversations.id, id)).limit(1)) as Conversation[];
  if (!c) throw AppError.notFound("Conversation not found");
  return c;
}

export const inboxOperations: OperationsModule = (app, ctx) => {
  const db = (): Db => dbOf(ctx);

  // ── Me ──────────────────────────────────────────────────────────────────

  app.get(
    "/me",
    {
      id: "koe-me",
      summary: "Who I am in koe",
      description: "Your koe role (agent, supervisor, admin), your teams, availability, and the web push key. 403 if you are not on the koe team.",
      access: "session",
      permission: USE,
      output: { schema: Output },
    },
    async (c, _i, h) => {
      const me = await requireMember(db(), h.user);
      const [row] = (await db().select().from(koeMembers).where(eq(koeMembers.userId, me.userId)).limit(1)) as Array<typeof koeMembers.$inferSelect>;
      const teams = (await db()
        .select({ id: koeTeams.id, slug: koeTeams.slug, name: koeTeams.name, purpose: koeTeams.purpose })
        .from(koeTeamMembers)
        .innerJoin(koeTeams, eq(koeTeams.id, koeTeamMembers.teamId))
        .where(eq(koeTeamMembers.userId, me.userId))) as unknown[];
      const keys = await vapidKeys(ctx, db()).catch(() => null);
      return c.json({ data: { userId: me.userId, role: me.role, lead: me.lead, member: row ?? null, teams, pushKey: keys?.publicKey ?? null } });
    }
  );

  app.post(
    "/me/heartbeat",
    {
      id: "koe-heartbeat",
      summary: "I am in the inbox",
      description: "Marks you as seen (no web push while you are) and optionally sets your availability for automatic assignment.",
      access: "session",
      permission: USE,
      input: { body: z.object({ available: z.boolean().optional() }) },
      output: { schema: Output },
      mcp: { exclude: "browser presence of a person" },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const set: Record<string, unknown> = { lastSeenAt: new Date() };
      if (input.body.available !== undefined) set.available = input.body.available;
      await db().update(koeMembers).set(set).where(eq(koeMembers.userId, me.userId));
      return c.json({ data: { ok: true } });
    }
  );

  // ── Conversations ───────────────────────────────────────────────────────

  app.get(
    "/conversations",
    {
      id: "list-conversations",
      summary: "List conversations",
      description:
        "The inbox, newest activity first: filter by state (`open` by default), assignee (`me`, `none`, a user id), team, channel, label or contact (`q`). Paginate with `before` = the last row's lastMessageAt. You only get conversations you may see.",
      access: "session",
      permission: USE,
      input: { query: ListQuery },
      output: { schema: Output },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const q = input.query as z.infer<typeof ListQuery>;
      const where: SQL[] = [];
      if (q.state === "open") where.push(ne(koeConversations.state, "resolved"));
      else if (q.state !== "all") where.push(eq(koeConversations.state, q.state));
      if (q.assignee === "me") where.push(eq(koeConversations.assigneeId, me.userId));
      else if (q.assignee === "none") where.push(isNull(koeConversations.assigneeId));
      else if (q.assignee) where.push(eq(koeConversations.assigneeId, q.assignee));
      if (q.teamId) where.push(eq(koeConversations.teamId, q.teamId));
      if (q.channelId) where.push(eq(koeConversations.channelId, q.channelId));
      if (q.label) where.push(sql`${koeConversations.labels} ? ${q.label}`);
      if (q.before) where.push(lt(koeConversations.lastMessageAt, new Date(q.before)));
      if (q.q) {
        const like = `%${q.q.replace(/[%_]/g, "")}%`;
        where.push(or(ilike(koeContacts.displayName, like), ilike(koeContacts.phone, like), ilike(koeContacts.email, like))!);
      }
      const rows = (await db()
        .select({ conv: koeConversations, contact: koeContacts, channel: koeChannels })
        .from(koeConversations)
        .innerJoin(koeContacts, eq(koeContacts.id, koeConversations.contactId))
        .innerJoin(koeChannels, eq(koeChannels.id, koeConversations.channelId))
        .where(where.length ? and(...where) : undefined)
        .orderBy(sql`${koeConversations.lastMessageAt} DESC NULLS LAST`, desc(koeConversations.id))
        .limit(q.limit)) as Array<{ conv: Conversation; contact: Contact; channel: Channel }>;
      const data = rows.map((r) => view(r.conv, r.contact, r.channel));
      return c.json({ data, next: rows.length === q.limit ? rows[rows.length - 1]!.conv.lastMessageAt : null });
    }
  );

  app.get(
    "/conversations/counts",
    {
      id: "count-conversations",
      summary: "Inbox counters",
      description: "How many open conversations are mine, unassigned, queued, with the bot, snoozed, and unread for me.",
      access: "session",
      permission: USE,
      output: { schema: Output },
    },
    async (c, _i, h) => {
      const me = await requireMember(db(), h.user);
      const [r] = (await db()
        .select({
          mine: sql<number>`count(*) FILTER (WHERE ${koeConversations.assigneeId} = ${me.userId} AND ${koeConversations.state} = 'human')::int`,
          unread: sql<number>`coalesce(sum(${koeConversations.unreadCount}) FILTER (WHERE ${koeConversations.assigneeId} = ${me.userId}), 0)::int`,
          queued: sql<number>`count(*) FILTER (WHERE ${koeConversations.state} = 'queued')::int`,
          unassigned: sql<number>`count(*) FILTER (WHERE ${koeConversations.assigneeId} IS NULL AND ${koeConversations.state} <> 'resolved')::int`,
          bot: sql<number>`count(*) FILTER (WHERE ${koeConversations.state} = 'bot')::int`,
          snoozed: sql<number>`count(*) FILTER (WHERE ${koeConversations.state} = 'snoozed')::int`,
          slaBreached: sql<number>`count(*) FILTER (WHERE ${koeConversations.slaBreached} AND ${koeConversations.state} <> 'resolved')::int`,
        })
        .from(koeConversations)
        .where(ne(koeConversations.state, "resolved"))) as Array<Record<string, number>>;
      return c.json({ data: r ?? {} });
    }
  );

  app.get(
    "/conversations/:id",
    {
      id: "get-conversation",
      summary: "One conversation",
      description: "The conversation with its contact, channel, window (open, until when, human-agent tag) and labels. 404 if it does not exist or you may not see it.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const conv = await conversationOr404(db(), input.params.id);
      await reportAccess({ ctx, db: db(), kind: "view", conversationId: conv.id, contactId: conv.contactId, actor: { kind: (h.user as { role?: string } | null)?.role === "agent" ? "ai" : "agent", id: String((h.user as { id?: string } | null)?.id ?? "") || null } });
      const [contact] = (await db().select().from(koeContacts).where(eq(koeContacts.id, conv.contactId)).limit(1)) as Contact[];
      const [channel] = (await db().select().from(koeChannels).where(eq(koeChannels.id, conv.channelId)).limit(1)) as Channel[];
      return c.json({ data: view(conv, contact ?? null, channel ?? null) });
    }
  );

  app.get(
    "/conversations/:id/messages",
    {
      id: "list-messages",
      summary: "Messages of a conversation",
      description: "Oldest first, with media as short-lived signed URLs. Page backwards with `before` (a createdAt).",
      access: "session",
      permission: USE,
      input: { params: ParamId, query: z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const opened = await conversationOr404(db(), input.params.id);
      await reportAccess({ ctx, db: db(), kind: "messages", conversationId: opened.id, contactId: opened.contactId, actor: { kind: (h.user as { role?: string } | null)?.role === "agent" ? "ai" : "agent", id: String((h.user as { id?: string } | null)?.id ?? "") || null } });
      const where = [eq(koeMessages.conversationId, input.params.id), ...(input.query.before ? [lt(koeMessages.createdAt, new Date(input.query.before))] : [])];
      const rows = (await db().select().from(koeMessages).where(and(...where)).orderBy(desc(koeMessages.createdAt)).limit(input.query.limit)) as Message[];
      rows.reverse();
      const mediaIds = rows.map((r) => r.mediaId).filter((x): x is string => !!x);
      const media = mediaIds.length ? ((await db().select().from(koeMedia).where(inArray(koeMedia.id, mediaIds))) as Media[]) : [];
      const byId = new Map(media.map((m) => [m.id, m]));
      const data = [];
      for (const m of rows) {
        const { idempotencyKey: _k, ...rest } = m;
        data.push({ ...rest, media: await signedMedia(ctx, m.mediaId ? byId.get(m.mediaId) ?? null : null) });
      }
      return c.json({ data });
    }
  );

  app.post(
    "/conversations/:id/messages",
    {
      id: "send-message",
      summary: "Send a message",
      description:
        "Answer in a conversation: text, media (upload first), a template (WhatsApp, the only thing allowed outside the 24 h window), interactive buttons or lists, location, a reaction. Replying to an unassigned conversation takes it. 409 with `details.koe` = WINDOW_CLOSED, TAG_NOT_ALLOWED, OPTED_OUT, BLOCKED, NOT_YOURS, TEMPLATE_NOT_APPROVED, UNSUPPORTED or TOO_LARGE says why it cannot go out. An agent key sends as the AI (`author ai`), which never writes in a conversation a person has.",
      access: "session",
      permission: USE,
      input: { params: ParamId, body: SendBody },
      output: { schema: Output, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const body = input.body as z.infer<typeof SendBody>;
      const isAgentKey = (h.user as { role?: string } | null)?.role === "agent";
      const message = await send(
        { ctx, db: db(), userRole: (h.user as { role?: string } | null)?.role ?? null },
        { conversationId: input.params.id, author: isAgentKey ? { kind: "ai", id: me.userId } : { kind: "agent", id: me.userId }, ...body }
      );
      return c.json({ data: message }, 201);
    }
  );

  const stateOp = (
    route: string,
    id: string,
    summary: string,
    description: string,
    body: z.ZodTypeAny,
    run: (convId: string, b: Record<string, unknown>, me: { userId: string; lead: boolean }) => Promise<Conversation>
  ) =>
    app.post(
      route,
      { id, summary, description, access: "session", permission: USE, input: { params: ParamId, body }, output: { schema: Output }, errors: ["KITSUDEN_E_CONFLICT"] },
      async (c, input, h) => {
        const me = await requireMember(db(), h.user);
        return c.json({ data: await run(input.params.id, (input.body ?? {}) as Record<string, unknown>, me) });
      }
    );

  const actorOf = (me: { userId: string }) => ({ kind: "agent" as const, id: me.userId });
  const Empty = z.object({ reason: z.string().max(300).optional() });

  stateOp("/conversations/:id/take", "take-conversation", "Take a conversation", "You answer it from now on; the bot goes quiet. 409 if someone else already has it.", Empty, (id, b, me) =>
    changeState(ctx, db(), id, { trigger: "assign", assigneeId: me.userId, reason: (b.reason as string) ?? "taken" }, actorOf(me))
  );
  stateOp(
    "/conversations/:id/assign",
    "assign-conversation",
    "Give a conversation to someone",
    "Assign (or reassign) to a koe member. Supervisors and admins assign anyone; an agent can only pass on their own.",
    z.object({ userId: z.string().min(1).max(100), reason: z.string().max(300).optional() }),
    async (id, b, me) => {
      const conv = await conversationOr404(db(), id);
      if (!me.lead && conv.assigneeId !== me.userId) throw AppError.forbidden("Only a supervisor can assign a conversation that is not yours");
      const trigger = conv.state === "human" ? "reassign" : "assign";
      return changeState(ctx, db(), id, { trigger, assigneeId: String(b.userId), reason: (b.reason as string) ?? trigger }, actorOf(me));
    }
  );
  stateOp("/conversations/:id/release", "release-conversation", "Let a conversation go back to the queue", "For when you cannot follow it: it goes back to the team's queue.", Empty, async (id, b, me) => {
    const conv = await conversationOr404(db(), id);
    if (!me.lead && conv.assigneeId !== me.userId) throw AppError.forbidden("It is not yours");
    return changeState(ctx, db(), id, { trigger: "release", reason: (b.reason as string) ?? "released" }, actorOf(me));
  });
  stateOp("/conversations/:id/return-to-bot", "return-conversation-to-bot", "Hand a conversation back to the bot", "The bot answers again. Only for a channel with a bot.", Empty, async (id, b, me) => {
    const conv = await conversationOr404(db(), id);
    const [channel] = (await db().select().from(koeChannels).where(eq(koeChannels.id, conv.channelId)).limit(1)) as Channel[];
    if (!channel?.botSlug && !channel?.settings?.flowId) throw AppError.validation("This channel has no bot");
    return changeState(ctx, db(), id, { trigger: conv.state === "queued" ? "back_to_bot" : "return_to_bot", reason: (b.reason as string) ?? "returned" }, actorOf(me));
  });
  stateOp("/conversations/:id/handoff", "handoff-conversation", "Ask for a person", "From the bot to the queue. Agents (AI) call it when they should not answer; a summary helps whoever takes it.", z.object({ reason: z.string().max(300).optional(), summary: z.string().max(2000).optional() }), async (id, b, me) => {
    if (b.summary) await db().update(koeConversations).set({ metadata: sql`${koeConversations.metadata} || ${JSON.stringify({ handoffSummary: b.summary })}::jsonb` }).where(eq(koeConversations.id, id));
    return changeState(ctx, db(), id, { trigger: "handoff", reason: (b.reason as string) ?? "handoff" }, actorOf(me));
  });
  stateOp("/conversations/:id/snooze", "snooze-conversation", "Snooze a conversation", "Out of sight until `until`, or until the contact writes.", z.object({ until: z.string().datetime() }), (id, b, me) =>
    changeState(ctx, db(), id, { trigger: "snooze", snoozedUntil: new Date(String(b.until)) }, actorOf(me))
  );
  stateOp("/conversations/:id/resolve", "resolve-conversation", "Resolve a conversation", "Closes it. A new message from the contact opens it again.", Empty, (id, b, me) =>
    changeState(ctx, db(), id, { trigger: "resolve", reason: (b.reason as string) ?? "resolved" }, actorOf(me))
  );
  stateOp("/conversations/:id/transfer", "transfer-conversation", "Move a conversation to another team", "It goes to that team's queue (and is assigned automatically if the team does).", z.object({ teamId: z.string().min(1).max(100).nullable() }), (id, b, me) =>
    transfer(ctx, db(), id, (b.teamId as string | null) ?? null, actorOf(me))
  );

  app.patch(
    "/conversations/:id",
    {
      id: "update-conversation",
      summary: "Label or prioritise a conversation",
      description: "Labels, priority, and the CRM deal it belongs to.",
      access: "session",
      permission: USE,
      input: {
        params: ParamId,
        body: z.object({
          labels: z.array(z.string().min(1).max(60)).max(30).optional(),
          priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
          crmDealId: z.string().max(100).nullable().optional(),
        }),
      },
      output: { schema: Output },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      await conversationOr404(db(), input.params.id);
      const [row] = (await db().update(koeConversations).set({ ...input.body, updatedAt: new Date() }).where(eq(koeConversations.id, input.params.id)).returning()) as Conversation[];
      if (input.body.labels) emit(ctx, "conversation.labeled", { conversationId: row!.id, labels: input.body.labels, by: me.userId });
      publish(ctx, channelOf.conversation(row!.id), { type: "conversation", change: "updated", id: row!.id });
      return c.json({ data: row });
    }
  );

  app.post(
    "/conversations/:id/read",
    {
      id: "read-conversation",
      summary: "Mark as read",
      description: "Clears the unread count and, on channels with read receipts, tells the contact their last message was read.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const conv = await conversationOr404(db(), input.params.id);
      await db().update(koeConversations).set({ unreadCount: 0 }).where(eq(koeConversations.id, conv.id));
      const [last] = (await db()
        .select({ externalId: koeMessages.externalId })
        .from(koeMessages)
        .where(and(eq(koeMessages.conversationId, conv.id), eq(koeMessages.direction, "in")))
        .orderBy(desc(koeMessages.createdAt))
        .limit(1)) as Array<{ externalId: string | null }>;
      if (last?.externalId) await queue.dispatch(QUEUES.outbound, "read", { conversationId: conv.id, externalId: last.externalId }, { attempts: 2 });
      return c.json({ data: { ok: true } });
    }
  );

  app.post(
    "/conversations/:id/typing",
    {
      id: "typing-in-conversation",
      summary: "I am typing",
      description: "Tells the other people in the inbox (collision warning) and, where the channel supports it, the contact.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
      mcp: { exclude: "browser presence of a person" },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const conv = await conversationOr404(db(), input.params.id);
      publish(ctx, channelOf.conversation(conv.id), { type: "typing", conversationId: conv.id, userId: me.userId });
      return c.json({ data: { ok: true } });
    }
  );

  app.get(
    "/conversations/:id/window",
    {
      id: "conversation-window",
      summary: "Can I write freely now?",
      description: "Whether the service window is open, until when, whether only a person may still answer (human-agent tag), and the approved templates you can use when it is closed.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const conv = await conversationOr404(db(), input.params.id);
      const [channel] = (await db().select().from(koeChannels).where(eq(koeChannels.id, conv.channelId)).limit(1)) as Channel[];
      const w = windowOf(channel!.kind, conv.lastInboundAt, conv.freeEntryUntil);
      const free = checkWindow(channel!.kind, "free", "agent", conv.lastInboundAt, conv.freeEntryUntil);
      const bot = checkWindow(channel!.kind, "free", "bot", conv.lastInboundAt, conv.freeEntryUntil);
      const templates = channel!.kind === "whatsapp" ? await db().select().from(koeTemplates).where(and(eq(koeTemplates.channelId, channel!.id), eq(koeTemplates.status, "approved"))).orderBy(asc(koeTemplates.name)) : [];
      return c.json({ data: { ...w, personMayWrite: free.ok, botMayWrite: bot.ok, tag: free.ok ? free.tag ?? null : null, templates } });
    }
  );

  // ── Notes and history ───────────────────────────────────────────────────

  app.get(
    "/conversations/:id/notes",
    { id: "list-notes", summary: "Internal notes", description: "Notes the team (and AI) left on a conversation. The contact never sees them.", access: "session", permission: USE, input: { params: ParamId }, output: { schema: Output } },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      await conversationOr404(db(), input.params.id);
      return c.json({ data: await db().select().from(koeNotes).where(eq(koeNotes.conversationId, input.params.id)).orderBy(asc(koeNotes.createdAt)) });
    }
  );

  app.post(
    "/conversations/:id/notes",
    {
      id: "add-note",
      summary: "Add an internal note",
      description: "A note for the team, not the contact. `mentions` (user ids) notifies those people.",
      access: "session",
      permission: USE,
      input: { params: ParamId, body: z.object({ body: z.string().trim().min(1).max(5000), mentions: z.array(z.string().min(1).max(100)).max(20).optional() }) },
      output: { schema: Output, status: 201 },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      await conversationOr404(db(), input.params.id);
      const isAgentKey = (h.user as { role?: string } | null)?.role === "agent";
      const [note] = (await db()
        .insert(koeNotes)
        .values({ id: newId(), conversationId: input.params.id, authorKind: isAgentKey ? "ai" : "agent", authorId: me.userId, body: input.body.body, mentions: input.body.mentions ?? [] })
        .returning()) as Array<typeof koeNotes.$inferSelect>;
      for (const userId of input.body.mentions ?? []) {
        await queue.dispatch(QUEUES.notify, "mention", { userId, conversationId: input.params.id, by: me.userId, body: input.body.body.slice(0, 200) }, { attempts: 3 });
      }
      await reportAccess({ ctx, db: db(), kind: "note", conversationId: input.params.id, contactId: null, actor: { kind: isAgentKey ? "ai" : "agent", id: me.userId }, detail: { noteId: note!.id } });
      publish(ctx, channelOf.conversation(input.params.id), { type: "note", conversationId: input.params.id, noteId: note!.id });
      return c.json({ data: note }, 201);
    }
  );

  app.get(
    "/conversations/:id/events",
    { id: "conversation-history", summary: "What happened to a conversation", description: "Every change of state, assignment and transfer, with who and why.", access: "session", permission: USE, input: { params: ParamId }, output: { schema: Output } },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      await conversationOr404(db(), input.params.id);
      return c.json({ data: await db().select().from(koeConversationEvents).where(eq(koeConversationEvents.conversationId, input.params.id)).orderBy(asc(koeConversationEvents.createdAt)) });
    }
  );

  // ── Contacts ────────────────────────────────────────────────────────────

  app.get(
    "/contacts",
    {
      id: "list-contacts",
      summary: "Find contacts",
      description: "Contacts of the conversations you may see, by name, phone or email.",
      access: "session",
      permission: USE,
      input: { query: z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const like = input.query.q ? `%${input.query.q.replace(/[%_]/g, "")}%` : null;
      const rows = await db()
        .select()
        .from(koeContacts)
        .where(like ? or(ilike(koeContacts.displayName, like), ilike(koeContacts.phone, like), ilike(koeContacts.email, like)) : undefined)
        .orderBy(desc(koeContacts.updatedAt))
        .limit(input.query.limit);
      return c.json({ data: rows });
    }
  );

  app.get(
    "/contacts/:id",
    { id: "get-contact", summary: "One contact", description: "The contact with their identities per channel, consents and conversations.", access: "session", permission: USE, input: { params: ParamId }, output: { schema: Output } },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const [contact] = (await db().select().from(koeContacts).where(eq(koeContacts.id, input.params.id)).limit(1)) as Contact[];
      if (!contact) throw AppError.notFound("Contact not found");
      await reportAccess({ ctx, db: db(), kind: "contact-view", conversationId: null, contactId: contact.id, actor: { kind: (h.user as { role?: string } | null)?.role === "agent" ? "ai" : "agent", id: String((h.user as { id?: string } | null)?.id ?? "") || null } });
      const identities = await db().select().from(koeIdentities).where(eq(koeIdentities.contactId, contact.id));
      const consents = await db().select().from(koeConsents).where(eq(koeConsents.contactId, contact.id));
      const conversations = await db().select().from(koeConversations).where(eq(koeConversations.contactId, contact.id)).orderBy(desc(koeConversations.updatedAt)).limit(50);
      return c.json({ data: { ...contact, identities, consents, conversations } });
    }
  );

  app.patch(
    "/contacts/:id",
    {
      id: "update-contact",
      summary: "Edit a contact",
      description: "Name, phone, email, locale, attributes (merged), the CRM contact it is, or block it (a blocked contact's messages are dropped and nothing is sent to it).",
      access: "session",
      permission: USE,
      input: {
        params: ParamId,
        body: z.object({
          displayName: z.string().trim().max(200).nullable().optional(),
          phone: z.string().max(40).nullable().optional(),
          email: z.string().email().max(300).nullable().optional(),
          locale: z.string().max(20).nullable().optional(),
          attributes: z.record(z.string(), z.unknown()).optional(),
          crmContactId: z.string().max(100).nullable().optional(),
          blocked: z.boolean().optional(),
        }),
      },
      output: { schema: Output },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const [contact] = (await db().select().from(koeContacts).where(eq(koeContacts.id, input.params.id)).limit(1)) as Contact[];
      if (!contact) throw AppError.notFound("Contact not found");
      if (input.body.blocked !== undefined && !me.lead) throw AppError.forbidden("Only a supervisor can block a contact");
      const { attributes, ...rest } = input.body;
      const [row] = (await db()
        .update(koeContacts)
        .set({ ...rest, ...(attributes ? { attributes: { ...(contact.attributes ?? {}), ...attributes } } : {}), updatedAt: new Date() })
        .where(eq(koeContacts.id, contact.id))
        .returning()) as Contact[];
      await reportAccess({ ctx, db: db(), kind: "contact-update", conversationId: null, contactId: row!.id, actor: { kind: "agent", id: me.userId }, detail: { fields: Object.keys(input.body) } });
      emit(ctx, "contact.updated", { contactId: row!.id, by: me.userId });
      return c.json({ data: row });
    }
  );

  app.post(
    "/contacts/:id/merge",
    {
      id: "merge-contacts",
      summary: "Merge two contacts",
      description: "The same person on two channels: `otherId`'s identities, conversations, consents and promises move to this contact, and the other is deleted. Supervisors and admins.",
      access: "session",
      permission: USE,
      sensitive: true,
      input: { params: ParamId, body: z.object({ otherId: z.string().min(1).max(100) }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const keep = input.params.id;
      const other = input.body.otherId;
      if (keep === other) throw AppError.validation("Those are the same contact");
      const both = (await db().select().from(koeContacts).where(inArray(koeContacts.id, [keep, other]))) as Contact[];
      if (both.length !== 2) throw AppError.notFound("Contact not found");
      await db().update(koeIdentities).set({ contactId: keep }).where(eq(koeIdentities.contactId, other));
      await db().update(koeConversations).set({ contactId: keep }).where(eq(koeConversations.contactId, other));
      // A consent of the same channel on both: the one kept wins.
      await db().execute(sql`UPDATE koe_consents SET contact_id = ${keep} WHERE contact_id = ${other} AND channel_id NOT IN (SELECT channel_id FROM koe_consents WHERE contact_id = ${keep})`);
      await db().execute(sql`UPDATE koe_promises SET contact_id = ${keep} WHERE contact_id = ${other}`);
      const o = both.find((b) => b.id === other)!;
      const k = both.find((b) => b.id === keep)!;
      await db()
        .update(koeContacts)
        .set({ displayName: k.displayName ?? o.displayName, phone: k.phone ?? o.phone, email: k.email ?? o.email, attributes: { ...(o.attributes ?? {}), ...(k.attributes ?? {}) }, updatedAt: new Date() })
        .where(eq(koeContacts.id, keep));
      await db().delete(koeContacts).where(eq(koeContacts.id, other));
      return c.json({ data: { id: keep, merged: other } });
    }
  );

  app.put(
    "/contacts/:id/consent",
    {
      id: "set-contact-consent",
      summary: "Record consent",
      description: "Whether the contact agreed (`opted_in`) or refused (`opted_out`) business-initiated messages on a channel, and where it came from. Campaigns only reach `opted_in` contacts.",
      access: "session",
      permission: USE,
      input: { params: ParamId, body: z.object({ channelId: z.string().min(1).max(100), status: z.enum(["opted_in", "opted_out"]), source: z.string().trim().min(1).max(200) }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const [row] = (await db()
        .insert(koeConsents)
        .values({ id: newId(), contactId: input.params.id, ...input.body })
        .onConflictDoUpdate({ target: [koeConsents.contactId, koeConsents.channelId], set: { status: input.body.status, source: input.body.source, updatedAt: new Date() } })
        .returning()) as unknown[];
      emit(ctx, `contact.${input.body.status}`, { contactId: input.params.id, channelId: input.body.channelId });
      return c.json({ data: row });
    }
  );

  app.post(
    "/contacts/:id/start",
    {
      id: "start-conversation",
      summary: "Write first to a contact",
      description:
        "For sales and collections: opens (or reuses) the contact's conversation on a channel and sends an approved WhatsApp template. You take the conversation. 409 if the contact opted out. On WhatsApp the contact needs a phone.",
      access: "session",
      permission: USE,
      input: {
        params: ParamId,
        body: z.object({
          channelId: z.string().min(1).max(100),
          templateId: z.string().min(1).max(100),
          values: z.record(z.string(), z.string().max(1024)).optional(),
          headerMediaId: z.string().max(100).optional(),
          idempotencyKey: z.string().min(8).max(200).optional(),
        }),
      },
      output: { schema: Output, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const conversation = await openConversationWith(ctx, db(), input.params.id, input.body.channelId, me.userId);
      const message = await send(
        { ctx, db: db(), userRole: (h.user as { role?: string } | null)?.role ?? null },
        {
          conversationId: conversation.id,
          author: { kind: "agent", id: me.userId },
          kind: "template",
          template: { templateId: input.body.templateId, values: input.body.values, headerMediaId: input.body.headerMediaId },
          idempotencyKey: input.body.idempotencyKey,
        }
      );
      return c.json({ data: { conversationId: conversation.id, message } }, 201);
    }
  );

  // ── Notices and web push ────────────────────────────────────────────────

  app.get(
    "/notices",
    {
      id: "list-notices",
      summary: "My notices",
      description: "Assignments, mentions, waiting conversations, closing windows, channel problems. Newest first.",
      access: "session",
      permission: USE,
      input: { query: z.object({ unread: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const where = [eq(koeNotices.userId, me.userId), ...(input.query.unread ? [isNull(koeNotices.readAt)] : [])];
      return c.json({ data: await db().select().from(koeNotices).where(and(...where)).orderBy(desc(koeNotices.createdAt)).limit(input.query.limit) });
    }
  );

  app.get(
    "/notices/latest",
    {
      id: "latest-notice",
      summary: "What a push should show",
      description: "The newest unread notice: the service worker asks it when an (empty) web push arrives.",
      access: "session",
      permission: USE,
      output: { schema: Output },
      mcp: { exclude: "used by the browser's service worker" },
    },
    async (c, _i, h) => {
      const me = await requireMember(db(), h.user);
      const [n] = (await db().select().from(koeNotices).where(and(eq(koeNotices.userId, me.userId), isNull(koeNotices.readAt))).orderBy(desc(koeNotices.createdAt)).limit(1)) as unknown[];
      return c.json({ data: n ?? null });
    }
  );

  app.post(
    "/notices/read",
    {
      id: "read-notices",
      summary: "Mark notices as read",
      description: "The ids given, or all of yours when `ids` is left out.",
      access: "session",
      permission: USE,
      input: { body: z.object({ ids: z.array(z.string().min(1).max(100)).max(200).optional() }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      await db()
        .update(koeNotices)
        .set({ readAt: new Date() })
        .where(and(eq(koeNotices.userId, me.userId), isNull(koeNotices.readAt), ...(input.body.ids ? [inArray(koeNotices.id, input.body.ids)] : [])));
      return c.json({ data: { ok: true } });
    }
  );

  app.post(
    "/push/subscriptions",
    {
      id: "subscribe-push",
      summary: "Get web push on this browser",
      description: "Stores the browser's PushSubscription. Only browser push services are accepted.",
      access: "session",
      permission: USE,
      input: {
        body: z.object({
          endpoint: z.string().url().max(2000),
          keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).partial().optional(),
          userAgent: z.string().max(300).optional(),
        }),
      },
      output: { schema: Output, status: 201 },
      mcp: { exclude: "a browser's push subscription" },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      if (!isPushEndpoint(input.body.endpoint)) throw AppError.validation("That is not a browser push service");
      await db()
        .insert(koePushSubscriptions)
        .values({ id: newId(), userId: me.userId, endpoint: input.body.endpoint, p256dh: input.body.keys?.p256dh ?? null, authSecret: input.body.keys?.auth ?? null, userAgent: input.body.userAgent ?? null })
        .onConflictDoUpdate({ target: koePushSubscriptions.endpoint, set: { userId: me.userId, lastUsedAt: new Date() } });
      return c.json({ data: { ok: true } }, 201);
    }
  );

  app.post(
    "/push/unsubscribe",
    {
      id: "unsubscribe-push",
      summary: "Stop web push on this browser",
      description: "Removes the browser's subscription.",
      access: "session",
      permission: USE,
      input: { body: z.object({ endpoint: z.string().url().max(2000) }) },
      output: { schema: Output },
      mcp: { exclude: "a browser's push subscription" },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      await db().delete(koePushSubscriptions).where(and(eq(koePushSubscriptions.endpoint, input.body.endpoint), eq(koePushSubscriptions.userId, me.userId)));
      return c.json({ data: { ok: true } });
    }
  );
};

/** The contact's open conversation on a channel, creating the identity and conversation if needed; the person takes it. */
export async function openConversationWith(ctx: KonContext, db: Db, contactId: string, channelId: string, userId: string): Promise<Conversation> {
  const [contact] = (await db.select().from(koeContacts).where(eq(koeContacts.id, contactId)).limit(1)) as Contact[];
  if (!contact) throw AppError.notFound("Contact not found");
  const [channel] = (await db.select().from(koeChannels).where(eq(koeChannels.id, channelId)).limit(1)) as Channel[];
  if (!channel) throw AppError.notFound("Channel not found");
  let [identity] = (await db.select().from(koeIdentities).where(and(eq(koeIdentities.contactId, contactId), eq(koeIdentities.channelId, channelId))).limit(1)) as Array<typeof koeIdentities.$inferSelect>;
  if (!identity) {
    if (channel.kind !== "whatsapp") throw AppError.validation(`On ${channel.kind} the contact must write first`);
    const phone = contact.phone?.replace(/[^\d]/g, "");
    if (!phone) throw AppError.validation("The contact has no phone number");
    [identity] = (await db.insert(koeIdentities).values({ id: newId(), contactId, channelId, externalId: phone }).onConflictDoNothing().returning()) as Array<typeof koeIdentities.$inferSelect>;
    if (!identity) throw AppError.conflict("That phone number belongs to another contact on this channel");
  }
  let [conv] = (await db.select().from(koeConversations).where(and(eq(koeConversations.identityId, identity.id), ne(koeConversations.state, "resolved"))).limit(1)) as Conversation[];
  if (!conv) {
    const [last] = (await db.select().from(koeConversations).where(eq(koeConversations.identityId, identity.id)).orderBy(desc(koeConversations.updatedAt)).limit(1)) as Conversation[];
    if (last) return changeState(ctx, db, last.id, { trigger: "assign", assigneeId: userId, reason: "outbound" }, { kind: "agent", id: userId });
    [conv] = (await db
      .insert(koeConversations)
      .values({ id: newId(), channelId, identityId: identity.id, contactId, state: "human", assigneeId: userId, teamId: channel.defaultTeamId ?? null })
      .returning()) as Conversation[];
    emit(ctx, "conversation.created", { conversationId: conv!.id, channelId, channelKind: channel.kind, contactId, state: "human", teamId: conv!.teamId, outbound: true });
    return conv!;
  }
  if (conv.state === "human" && conv.assigneeId === userId) return conv;
  return changeState(ctx, db, conv.id, { trigger: conv.state === "human" ? "reassign" : "assign", assigneeId: userId, reason: "outbound" }, { kind: "agent", id: userId });
}

/** The `read` job of the outbound queue: mark the contact's last message read on the channel. */
export async function markReadOnChannel(ctx: KonContext, db: Db, conversationId: string, externalId: string): Promise<void> {
  const [conv] = (await db.select().from(koeConversations).where(eq(koeConversations.id, conversationId)).limit(1)) as Conversation[];
  if (!conv) return;
  const [channel] = (await db.select().from(koeChannels).where(eq(koeChannels.id, conv.channelId)).limit(1)) as Channel[];
  const adapter = channel ? adapterOf(channel.kind) : null;
  if (!channel || !adapter?.markRead || channel.kind === "webchat") return;
  const [identity] = (await db.select({ externalId: koeIdentities.externalId }).from(koeIdentities).where(eq(koeIdentities.id, conv.identityId)).limit(1)) as Array<{ externalId: string }>;
  await adapter.markRead(await authOf(ctx, channel, "mark-read"), identity?.externalId ?? "", externalId);
}

export { publicChannel };
