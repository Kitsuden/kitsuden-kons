/**
 * Quick replies: canned answers the composer offers after "/"
 * ============================================================================
 *
 * A quick reply is a shortcut (`/precios`), a title, a text with variables (`{{contact.name}}`,
 * `{{agent.name}}`, resolved by resolveValue() from koe.templates.ts) and attachments (koe media ids, kept
 * once and re-sent by id). Three scopes:
 *
 *   personal   its owner's only; any member writes their own;
 *   team       the members of one team; supervisors and admins write them;
 *   global     every member; supervisors and admins write them.
 *
 * Row-level security in the migration enforces the same rule; the checks here only turn it into clear
 * answers (403 for a scope you may not write, 404 for a reply you may not see). Supervisors can see other
 * people's personal replies through row security; the API still treats them as private.
 *
 * Sending one goes through send() like everything else: the text first, then each attachment in order. The
 * idempotency key of each part is derived from the client's key, so a retried request sends nothing twice.
 */

import { createHash } from "node:crypto";

import { AppError } from "@kitsuden/engine";
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { dbOf, newId, type Db } from "./koe.common";
import { requireMember, USE, type Member } from "./koe.policy";
import { koeChannels, koeContacts, koeConversations, koeMedia, koeMembers, koeQuickReplies, koeTeamMembers, type Contact, type Conversation, type Media, type Message } from "./koe.schema";
import { send } from "./koe.send";
import { resolveValue } from "./koe.templates";
import { Output, ParamId, type OperationsModule } from "./operations";

type QuickReply = typeof koeQuickReplies.$inferSelect;

const SHORTCUT = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const Shortcut = z
  .string()
  .trim()
  .transform((s) => s.replace(/^\//, "").toLowerCase())
  .pipe(z.string().regex(SHORTCUT, "1–40 characters: a–z, 0–9, _ and -, starting with a letter or digit"));
const Attachments = z.array(z.object({ mediaId: z.string().min(1).max(100) })).max(10);

const Create = z.object({
  shortcut: Shortcut.describe('What follows "/" in the composer'),
  title: z.string().trim().min(1).max(100),
  body: z.string().max(4096).optional().describe("Text; may use {{contact.name}}, {{contact.phone}}, {{contact.email}}, {{contact.attributes.<key>}}, {{agent.name}}, {{channel.name}}"),
  attachments: Attachments.default([]).describe("Media sent after the text, in order (upload them first with upload-media)"),
  scope: z.enum(["personal", "team", "global"]).default("personal").describe("team and global: supervisors and admins only"),
  teamId: z.string().min(1).max(100).optional().describe("Required for scope team"),
});

const Patch = z.object({
  shortcut: Shortcut.optional(),
  title: z.string().trim().min(1).max(100).optional(),
  body: z.string().max(4096).nullable().optional(),
  attachments: Attachments.optional(),
  scope: z.enum(["personal", "team", "global"]).optional(),
  teamId: z.string().min(1).max(100).nullable().optional(),
});

const ListQuery = z.object({
  shortcut: z.string().max(41).optional().describe('Prefix of the shortcut, what the user typed after "/"'),
  q: z.string().max(100).optional().describe("Words in the shortcut, title or text"),
  scope: z.enum(["personal", "team", "global"]).optional(),
  conversationId: z.string().max(100).optional().describe("Adds `preview`: the text resolved for this conversation's contact"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const SendQuick = z.object({
  clientKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/)
    .optional()
    .describe("A key the client makes once per press: a retried request with the same key sends nothing twice"),
  values: z.record(z.string().regex(/^[A-Za-z0-9_.]{1,60}$/), z.string().max(1000)).optional().describe("Extra variables, e.g. { \"order.id\": \"A-17\" } for {{order.id}}"),
  take: z.boolean().optional(),
});

async function one<T>(q: Promise<T[]>): Promise<T | undefined> {
  return (await q)[0];
}

async function myTeams(db: Db, userId: string): Promise<string[]> {
  const rows = (await db.select({ teamId: koeTeamMembers.teamId }).from(koeTeamMembers).where(eq(koeTeamMembers.userId, userId))) as Array<{ teamId: string }>;
  return rows.map((r) => r.teamId);
}

/** What the caller may see: global, their teams' (all teams for leads), their own personal ones. */
function visible(me: Member, teams: string[]): SQL {
  const parts: SQL[] = [eq(koeQuickReplies.scope, "global"), and(eq(koeQuickReplies.scope, "personal"), eq(koeQuickReplies.ownerId, me.userId))!];
  if (me.lead) parts.push(eq(koeQuickReplies.scope, "team"));
  else if (teams.length) parts.push(and(eq(koeQuickReplies.scope, "team"), inArray(koeQuickReplies.teamId, teams))!);
  return or(...parts)!;
}

/** Writing a reply of this scope: your own personal ones, or anything for leads. */
function mayWrite(me: Member, scope: QuickReply["scope"], ownerId: string | null): boolean {
  if (scope === "personal") return ownerId === me.userId;
  return me.lead;
}

async function visibleReply(db: Db, me: Member, id: string): Promise<QuickReply> {
  const teams = me.lead ? [] : await myTeams(db, me.userId);
  const row = await one<QuickReply>(db.select().from(koeQuickReplies).where(and(eq(koeQuickReplies.id, id), visible(me, teams))).limit(1));
  if (!row) throw AppError.notFound("Quick reply not found");
  return row;
}

/** Every attachment exists, is visible to the caller and is ready. */
async function checkAttachments(db: Db, list: Array<{ mediaId: string }>): Promise<void> {
  if (!list.length) return;
  const ids = [...new Set(list.map((a) => a.mediaId))];
  const rows = (await db.select({ id: koeMedia.id, status: koeMedia.status }).from(koeMedia).where(inArray(koeMedia.id, ids))) as Array<{ id: string; status: string }>;
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw AppError.validation(`Media not found: ${missing.join(", ")}`);
  const notReady = rows.filter((r) => r.status !== "ready").map((r) => r.id);
  if (notReady.length) throw AppError.validation(`Media not ready: ${notReady.join(", ")}`);
}

/** The variables an agent's text can use besides the contact's. */
async function variablesFor(db: Db, me: Member, conversation: Pick<Conversation, "id" | "channelId">, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const member = await one<{ displayName: string }>(db.select({ displayName: koeMembers.displayName }).from(koeMembers).where(eq(koeMembers.userId, me.userId)).limit(1));
  const channel = await one<{ name: string; display: string | null }>(db.select({ name: koeChannels.name, display: koeChannels.display }).from(koeChannels).where(eq(koeChannels.id, conversation.channelId)).limit(1));
  const agentName = member?.displayName ?? "";
  return {
    ...extra,
    "agent.name": agentName,
    "agent.firstName": agentName.split(/\s+/)[0] ?? "",
    "channel.name": channel?.display ?? channel?.name ?? "",
    "conversation.id": conversation.id,
  };
}

async function conversationWithContact(db: Db, id: string): Promise<{ conversation: Conversation; contact: Contact | null }> {
  const conversation = await one<Conversation>(db.select().from(koeConversations).where(eq(koeConversations.id, id)).limit(1));
  if (!conversation) throw AppError.notFound("Conversation not found");
  const contact = (await one<Contact>(db.select().from(koeContacts).where(eq(koeContacts.id, conversation.contactId)).limit(1))) ?? null;
  return { conversation, contact };
}

/** A unique-index clash (same shortcut in the same scope) is a 409, decided before the statement. */
async function shortcutTaken(db: Db, r: Pick<QuickReply, "shortcut" | "scope" | "ownerId" | "teamId">, exceptId?: string): Promise<boolean> {
  const where: SQL[] = [
    eq(koeQuickReplies.shortcut, r.shortcut),
    eq(koeQuickReplies.scope, r.scope),
    sql`coalesce(${koeQuickReplies.ownerId}, '') = ${r.ownerId ?? ""}`,
    sql`coalesce(${koeQuickReplies.teamId}, '') = ${r.teamId ?? ""}`,
  ];
  if (exceptId) where.push(sql`${koeQuickReplies.id} <> ${exceptId}`);
  return !!(await one(db.select({ id: koeQuickReplies.id }).from(koeQuickReplies).where(and(...where)).limit(1)));
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export const quickReplyOperations: OperationsModule = (app, ctx) => {
  const db = (): Db => dbOf(ctx);

  app.get(
    "/quick-replies",
    {
      id: "list-quick-replies",
      summary: "Quick replies",
      description:
        'The canned answers you may use: global ones, your teams\' and your own. `shortcut` filters by prefix (what the composer\'s "/" menu calls), `q` by words. With `conversationId` each one has `preview`, its text resolved for that contact.',
      access: "session",
      permission: USE,
      input: { query: ListQuery },
      output: { schema: Output },
      // 404 when `conversationId` names no conversation.
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const q = input.query as z.infer<typeof ListQuery>;
      const teams = me.lead ? [] : await myTeams(db(), me.userId);
      const where: SQL[] = [visible(me, teams)];
      if (q.scope) where.push(eq(koeQuickReplies.scope, q.scope));
      const prefix = q.shortcut?.replace(/^\//, "").toLowerCase();
      if (prefix) where.push(sql`${koeQuickReplies.shortcut} LIKE ${`${likeEscape(prefix)}%`}`);
      if (q.q?.trim()) {
        const term = `%${likeEscape(q.q.trim())}%`;
        where.push(or(ilike(koeQuickReplies.shortcut, term), ilike(koeQuickReplies.title, term), ilike(koeQuickReplies.body, term))!);
      }
      const rows = (await db().select().from(koeQuickReplies).where(and(...where)).orderBy(asc(koeQuickReplies.shortcut), asc(koeQuickReplies.scope)).limit(q.limit)) as QuickReply[];

      // Attachment summaries in one query: the menu shows "📷 + 📄", not signed URLs.
      const ids = [...new Set(rows.flatMap((r) => r.attachments.map((a) => a.mediaId)))];
      const media = ids.length ? ((await db().select().from(koeMedia).where(inArray(koeMedia.id, ids))) as Media[]) : [];
      const byId = new Map(media.map((m) => [m.id, m]));

      let resolve: ((body: string) => string) | null = null;
      if (q.conversationId) {
        const { conversation, contact } = await conversationWithContact(db(), q.conversationId);
        const vars = await variablesFor(db(), me, conversation);
        resolve = (body) => resolveValue(body, contact, vars);
      }
      const data = rows.map((r) => ({
        ...r,
        attachments: r.attachments.map((a) => {
          const m = byId.get(a.mediaId);
          return { mediaId: a.mediaId, kind: m?.kind ?? null, mime: m?.mime ?? null, filename: m?.filename ?? null, status: m?.status ?? "missing" };
        }),
        ...(resolve ? { preview: r.body ? resolve(r.body) : null } : {}),
      }));
      return c.json({ data });
    }
  );

  app.post(
    "/quick-replies",
    {
      id: "create-quick-reply",
      summary: "Create a quick reply",
      description:
        "A shortcut, a title, a text with variables and/or attachments (ready media ids). `personal` (default) is yours; `team` (with teamId) and `global` are for supervisors and admins. 409 if the shortcut is taken in that scope.",
      access: "session",
      permission: USE,
      input: { body: Create },
      output: { schema: Output, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const b = input.body as z.infer<typeof Create>;
      if (b.scope !== "personal" && !me.lead) throw AppError.forbidden("Only a supervisor or an admin can create team or global quick replies");
      if (b.scope === "team" && !b.teamId) throw AppError.validation("A team quick reply needs teamId");
      if (!b.body?.trim() && !b.attachments.length) throw AppError.validation("A quick reply needs a text or an attachment");
      await checkAttachments(db(), b.attachments);
      const row = {
        shortcut: b.shortcut,
        scope: b.scope,
        ownerId: b.scope === "personal" ? me.userId : null,
        teamId: b.scope === "team" ? b.teamId! : null,
      };
      if (await shortcutTaken(db(), row)) throw AppError.conflict(`The shortcut /${b.shortcut} is already used in that scope`);
      const [created] = (await db()
        .insert(koeQuickReplies)
        .values({ id: newId(), ...row, title: b.title, body: b.body?.trim() ? b.body : null, attachments: b.attachments })
        .returning()) as QuickReply[];
      return c.json({ data: created }, 201);
    }
  );

  app.patch(
    "/quick-replies/:id",
    {
      id: "update-quick-reply",
      summary: "Change a quick reply",
      description: "Your own personal ones; team and global ones for supervisors and admins (also to move one to another scope).",
      access: "session",
      permission: USE,
      input: { params: ParamId, body: Patch },
      output: { schema: Output },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const b = input.body as z.infer<typeof Patch>;
      const current = await visibleReply(db(), me, input.params.id);
      if (!mayWrite(me, current.scope, current.ownerId)) throw AppError.forbidden("Only a supervisor or an admin can change a team or global quick reply");
      const scope = b.scope ?? current.scope;
      if (scope !== current.scope && scope !== "personal" && !me.lead) throw AppError.forbidden("Only a supervisor or an admin can share a quick reply");
      const teamId = scope === "team" ? (b.teamId === undefined ? current.teamId : b.teamId) : null;
      if (scope === "team" && !teamId) throw AppError.validation("A team quick reply needs teamId");
      const ownerId = scope === "personal" ? (current.scope === "personal" ? current.ownerId : me.userId) : null;
      const body = b.body === undefined ? current.body : b.body?.trim() ? b.body : null;
      const attachments = b.attachments ?? current.attachments;
      if (!body && !attachments.length) throw AppError.validation("A quick reply needs a text or an attachment");
      if (b.attachments) await checkAttachments(db(), b.attachments);
      const next = { shortcut: b.shortcut ?? current.shortcut, scope, ownerId, teamId };
      if (await shortcutTaken(db(), next, current.id)) throw AppError.conflict(`The shortcut /${next.shortcut} is already used in that scope`);
      const [row] = (await db()
        .update(koeQuickReplies)
        .set({ ...next, title: b.title ?? current.title, body, attachments })
        .where(eq(koeQuickReplies.id, current.id))
        .returning()) as QuickReply[];
      return c.json({ data: row });
    }
  );

  app.delete(
    "/quick-replies/:id",
    {
      id: "delete-quick-reply",
      summary: "Delete a quick reply",
      description: "Your own personal ones; team and global ones for supervisors and admins. Its media stay (messages may show them).",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const current = await visibleReply(db(), me, input.params.id);
      if (!mayWrite(me, current.scope, current.ownerId)) throw AppError.forbidden("Only a supervisor or an admin can delete a team or global quick reply");
      await db().delete(koeQuickReplies).where(eq(koeQuickReplies.id, current.id));
      return c.json({ data: { removed: current.id } });
    }
  );

  app.post(
    "/conversations/:id/quick-replies/:qrId/send",
    {
      id: "send-quick-reply",
      summary: "Send a quick reply",
      description:
        "Sends the quick reply's text, with its variables resolved for this contact and you, then each attachment in order, through send-message's rules (window, consent, who is answering). Pass `clientKey` so a retried request sends nothing twice. 409 with `details.koe` like send-message when it cannot go out.",
      access: "session",
      permission: USE,
      input: { params: z.object({ id: z.string().min(1).max(100), qrId: z.string().min(1).max(100) }), body: SendQuick },
      output: { schema: Output, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const b = (input.body ?? {}) as z.infer<typeof SendQuick>;
      const qr = await visibleReply(db(), me, input.params.qrId);
      const { conversation, contact } = await conversationWithContact(db(), input.params.id);
      const vars = await variablesFor(db(), me, conversation, b.values ?? {});
      const text = qr.body ? resolveValue(qr.body, contact, vars).trim() : "";

      const media = qr.attachments.length ? ((await db().select().from(koeMedia).where(inArray(koeMedia.id, qr.attachments.map((a) => a.mediaId)))) as Media[]) : [];
      const byId = new Map(media.map((m) => [m.id, m]));
      const missing = qr.attachments.filter((a) => !byId.has(a.mediaId));
      if (missing.length) throw AppError.validation(`This quick reply's media is gone: ${missing.map((a) => a.mediaId).join(", ")}`);
      if (!text && !qr.attachments.length) throw AppError.validation("This quick reply resolves to nothing to send");

      // Each part's key: the conversation, the reply and the client's press. Hashed to stay short.
      const press = b.clientKey ?? newId();
      const keyOf = (part: string) => `qr_${createHash("sha256").update(`${conversation.id}:${qr.id}:${press}`).digest("hex").slice(0, 40)}_${part}`;
      const isAgentKey = (h.user as { role?: string } | null)?.role === "agent";
      const author = isAgentKey ? { kind: "ai" as const, id: me.userId } : { kind: "agent" as const, id: me.userId };
      const sc = { ctx, db: db(), userRole: (h.user as { role?: string } | null)?.role ?? null };

      const sent: Message[] = [];
      if (text) sent.push(await send(sc, { conversationId: conversation.id, author, kind: "text", body: text, idempotencyKey: keyOf("text"), take: b.take }));
      for (const [i, a] of qr.attachments.entries()) {
        const m = byId.get(a.mediaId)!;
        sent.push(await send(sc, { conversationId: conversation.id, author, kind: m.kind, mediaId: m.id, idempotencyKey: keyOf(`a${i}`), take: b.take }));
      }
      return c.json({ data: { quickReplyId: qr.id, messages: sent.map(({ idempotencyKey: _k, ...m }) => m) } }, 201);
    }
  );
};
