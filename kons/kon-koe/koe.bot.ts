/**
 * The bot of a conversation: a flow, or an AI bot of kon-chat through a queue; and the copilot for people
 * ============================================================================
 *
 * kon-chat is the bot, koe is the channel. koe owns the conversation and every message in it; kon-chat owns
 * the bot (its agent identity, what it knows, its limits and spending). Neither imports the other: they talk
 * through the Postgres queue, so each works without the other and a slow model never holds a webhook.
 *
 *   inbound message, state `bot`   → koe-bot "turn" (koe.inbound.ts)
 *   processBotTurn                 → the channel's flow first (koe.flows.ts); if it has none, and the
 *                                    channel names a kon-chat bot that is there, `chat-channel-turns`
 *                                    with the history and the store context; with no bot at all, a person
 *   kon-chat (chat.channel.ts)     → koe-bot-replies { ref, reply, sources, handoff, summary, error }
 *   processBotReply                → send() as `ai`, or a person (handoff), or a note
 *
 * ── WHAT NEVER HAPPENS ────────────────────────────────────────────────────
 *
 *   - The AI writes over a person. A reply that arrives after someone took the conversation becomes an
 *     internal note with the draft; send() refuses it anyway, and the delivery checks again.
 *   - The customer sees where an answer came from: sources go to an AI note ("Answered from: …").
 *   - A reply goes out twice: each one is handled once per inbound message (an event `bot_reply` records it,
 *     and send() has the idempotency key `bot:<messageId>`).
 *   - The store context fails a turn. It is best effort, read-only and short: the contact as koe knows it,
 *     their open payment promises, and, only when those kons are installed, their recent kon-ecommerce orders
 *     and their kon-crm record with open deals. It reaches the model marked as reference data.
 *
 * ── HANDOFF ───────────────────────────────────────────────────────────────
 *
 * kon-chat tells the model to answer `HANDOFF: <summary>` when the customer asks for a person or it cannot
 * help. koe stores the summary (`metadata.handoffSummary`, and a note for whoever takes it) and queues the
 * conversation. An error counts as a bot failure; at the channel's `maxBotFailures` (default 3) a person takes
 * over. A bot that cannot answer at all (no such bot, no agent engine, a limit or budget reached) hands off at
 * once: the next message would fail the same way.
 *
 * ── COPILOT ───────────────────────────────────────────────────────────────
 *
 * For people in the inbox: a suggested reply (not sent), a summary, a translation. They run the core agent an
 * admin chose (`PUT /config/copilot`), with no tools, over what the caller may see.
 */

import { AppError, asSystem, attemptSql, PermanentError, queue, withSavepoint, type QueueJob } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { channelById } from "./koe.channels";
import { CHAT_CHANNEL_QUEUE, dbOf, newId, QUEUES, type Db } from "./koe.common";
import { autoAssign, changeState, recordEvent, type Actor } from "./koe.conversations";
import { runFlowTurn } from "./koe.flows";
import { requireMember, CONFIGURE, USE } from "./koe.policy";
import { channelOf, publish } from "./koe.realtime";
import {
  koeConfig,
  koeContacts,
  koeConversationEvents,
  koeConversations,
  koeMedia,
  koeMessages,
  koeNotes,
  koePromises,
  type Channel,
  type Contact,
  type Conversation,
  type Message,
} from "./koe.schema";
import { send } from "./koe.send";
import { Output, ParamId, type OperationsModule } from "./operations";

/** Messages of the thread the bot and the copilot read: enough to follow it, not a day of it. */
const HISTORY_MESSAGES = 20;
/** The store context: a few hundred tokens, never a dump. */
const MAX_STORE_CONTEXT = 1500;
const MAX_REPLY = 4096;
const DEFAULT_MAX_FAILURES = 3;
/** Errors after which the next message would fail the same way: a person takes over at once. */
const FATAL_ERRORS = new Set(["unavailable", "no-engine", "limit"]);

const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? [])) as Record<string, unknown>[];
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** An AppError by shape: the host and a kon may load two copies of the engine, and `instanceof` misses. */
const appError = (err: unknown): err is { status: number; code: string; message: string } =>
  typeof (err as { status?: unknown })?.status === "number" && typeof (err as { code?: unknown })?.code === "string";

async function one<T>(q: Promise<unknown>): Promise<T | undefined> {
  return ((await q) as T[])[0];
}

// ════════════════════════════════════════════════════════════════════════════
// What the model reads
// ════════════════════════════════════════════════════════════════════════════

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** A message as text: media described, a voice note by its transcript when there is one. */
function describe(m: Pick<Message, "kind" | "body">, transcript: string | null | undefined): string {
  const body = (m.body ?? "").trim();
  switch (m.kind) {
    case "voice":
    case "audio":
      return transcript ? `[voice note] ${transcript.trim()}` : "[voice note]";
    case "image":
    case "video":
    case "document":
    case "sticker":
    case "location":
    case "contacts":
      return body ? `[${m.kind}] ${body}` : `[${m.kind}]`;
    default:
      return body || `[${m.kind}]`;
  }
}

/**
 * The last messages of a conversation as turns, oldest first: the contact's as `user`, the business's (people,
 * bots, rules, campaigns) as `assistant`. Reactions and messages that never went out are left out.
 */
export async function transcriptOf(db: Db, conversationId: string, upTo?: Date): Promise<Turn[]> {
  const rows = (await db
    .select({ id: koeMessages.id, direction: koeMessages.direction, kind: koeMessages.kind, body: koeMessages.body, mediaId: koeMessages.mediaId, status: koeMessages.status })
    .from(koeMessages)
    .where(and(eq(koeMessages.conversationId, conversationId), ne(koeMessages.kind, "reaction"), upTo ? lte(koeMessages.createdAt, upTo) : undefined))
    .orderBy(desc(koeMessages.createdAt))
    .limit(HISTORY_MESSAGES)) as Array<Pick<Message, "id" | "direction" | "kind" | "body" | "mediaId" | "status">>;
  rows.reverse();
  const mediaIds = rows.map((r) => r.mediaId).filter((id): id is string => !!id);
  const transcripts = new Map<string, string | null>();
  if (mediaIds.length) {
    for (const m of (await db.select({ id: koeMedia.id, transcript: koeMedia.transcript }).from(koeMedia).where(inArray(koeMedia.id, mediaIds))) as Array<{ id: string; transcript: string | null }>) {
      transcripts.set(m.id, m.transcript);
    }
  }
  return rows
    .filter((r) => r.direction === "in" || r.status !== "failed")
    .map((r) => ({ role: r.direction === "in" ? ("user" as const) : ("assistant" as const), content: describe(r, r.mediaId ? transcripts.get(r.mediaId) : null) }));
}

/** The contact's unanswered messages are the question; what came before them, the history. */
export function splitTurn(turns: Turn[]): { message: string; history: Turn[] } {
  let i = turns.length;
  while (i > 0 && turns[i - 1]!.role === "user") i--;
  return { message: turns.slice(i).map((t) => t.content).join("\n"), history: turns.slice(0, i) };
}

const money = (cents: number, currency: string | null | undefined) => `${(Number(cents) / 100).toFixed(2)} ${currency ?? ""}`.trim();
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));
const digits = (v: string | null | undefined) => (v ?? "").replace(/[^0-9]/g, "");

async function has(ctx: KonContext, table: string): Promise<boolean> {
  try {
    return await ctx.db.tableExists(table);
  } catch {
    return false;
  }
}

/**
 * "Contexto de tienda": what the business knows about this customer, as short plain text. Best effort and
 * read-only: anything that fails or is not installed is left out, never fails the turn. It runs with the
 * caller's row security (the system for a bot turn, the person for the copilot), so it never shows more than
 * the caller could read.
 */
export async function storeContextOf(ctx: KonContext, db: Db, conversation: Pick<Conversation, "contactId">): Promise<string> {
  const lines: string[] = [];
  const contact = await attemptSql(async () => one<Contact>(db.select().from(koeContacts).where(eq(koeContacts.id, conversation.contactId)).limit(1)), undefined);
  if (!contact) return "";

  const who = [contact.displayName ? `Name: ${contact.displayName}` : "", contact.phone ? `Phone: ${contact.phone}` : "", contact.email ? `Email: ${contact.email}` : "", contact.locale ? `Locale: ${contact.locale}` : ""].filter(Boolean);
  if (who.length) lines.push(`Customer. ${who.join(". ")}.`);
  const attributes = Object.entries(contact.attributes ?? {})
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .slice(0, 10)
    .map(([k, v]) => `${clip(k, 40)}: ${clip(String(v), 80)}`);
  if (attributes.length) lines.push(`Attributes: ${attributes.join("; ")}.`);

  const promises = await attemptSql(
    async () =>
      (await db
        .select({ amountCents: koePromises.amountCents, currency: koePromises.currency, dueDate: koePromises.dueDate, reference: koePromises.reference })
        .from(koePromises)
        .where(and(eq(koePromises.contactId, contact.id), eq(koePromises.status, "pending")))
        .orderBy(asc(koePromises.dueDate))
        .limit(5)) as Array<{ amountCents: number; currency: string; dueDate: string; reference: string | null }>,
    []
  );
  for (const p of promises) lines.push(`Open payment promise: ${money(p.amountCents, p.currency)} due ${day(p.dueDate)}${p.reference ? ` (ref ${clip(p.reference, 40)})` : ""}.`);

  // kon-ecommerce: orders by the buyer's email, or by the phone on the shipping address.
  const phone = digits(contact.phone);
  if ((contact.email || phone.length >= 6) && (await has(ctx, "shop_orders"))) {
    const orders = await attemptSql(
      async () =>
        rowsOf(
          await db.execute(sql`
            SELECT o.number, o.status::text AS status, o.total_cents AS "totalCents", o.currency,
                   coalesce(o.placed_at, o.created_at) AS at, to_jsonb(o) ->> 'tracking_number' AS tracking
              FROM shop_orders o
             WHERE (${contact.email ?? ""} <> '' AND lower(o.customer_email) = lower(${contact.email ?? ""}))
                OR (${phone} <> '' AND regexp_replace(coalesce(o.shipping_address ->> 'phone', ''), '[^0-9]', '', 'g') = ${phone})
             ORDER BY o.created_at DESC
             LIMIT 3`)
        ),
      []
    );
    for (const o of orders) {
      lines.push(`Order #${clip(String(o.number), 30)}: ${o.status}, ${money(Number(o.totalCents), String(o.currency ?? ""))}, placed ${day(o.at)}${o.tracking ? `, tracking ${clip(String(o.tracking), 60)}` : ""}.`);
    }
  }

  // kon-crm: the linked record (or the one with the same email) and its open deals.
  if (await has(ctx, "crm_contacts")) {
    const [crm] = await attemptSql(
      async () =>
        rowsOf(
          await db.execute(sql`
            SELECT c.id, c.status::text AS status, c.job_title AS "jobTitle"
              FROM crm_contacts c
             WHERE c.id = ${contact.crmContactId ?? ""} OR (${contact.email ?? ""} <> '' AND lower(c.email) = lower(${contact.email ?? ""}))
             ORDER BY (c.id = ${contact.crmContactId ?? ""}) DESC
             LIMIT 1`)
        ),
      []
    );
    if (crm) {
      lines.push(`CRM contact: status ${crm.status ?? "unknown"}${crm.jobTitle ? `, ${clip(String(crm.jobTitle), 60)}` : ""}.`);
      if (await has(ctx, "crm_deals")) {
        const deals = await attemptSql(
          async () =>
            rowsOf(
              await db.execute(sql`
                SELECT d.title, d.value, d.currency, s.name AS stage
                  FROM crm_deals d LEFT JOIN crm_pipeline_stages s ON s.id = d.stage_id
                 WHERE d.contact_id = ${String(crm.id)} AND d.status::text = 'open'
                 ORDER BY d.created_at DESC NULLS LAST
                 LIMIT 3`)
            ),
          []
        );
        for (const d of deals) lines.push(`Open deal: ${clip(String(d.title), 80)}${d.stage ? ` (${clip(String(d.stage), 40)})` : ""}, value ${d.value} ${d.currency ?? ""}`.trim() + ".");
      }
    }
  }

  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 1 > MAX_STORE_CONTEXT) break;
    out += (out ? "\n" : "") + line;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// The bot's turn
// ════════════════════════════════════════════════════════════════════════════

/** kon-chat is installed and has this bot, active and for channels. */
async function chatBotReady(ctx: KonContext, db: Db, slug: string): Promise<boolean> {
  if (!(await has(ctx, "chat_bots"))) return false;
  const rows = await attemptSql(async () => rowsOf(await db.execute(sql`SELECT 1 FROM chat_bots WHERE slug = ${slug} AND audience = 'channel' AND active LIMIT 1`)), []);
  return rows.length > 0;
}

/** Bot → the queue, then a person if the team assigns automatically. null when it is no longer the bot's. */
async function handOff(ctx: KonContext, db: Db, conversationId: string, reason: string, actor: Actor): Promise<Conversation | null> {
  let conversation: Conversation;
  try {
    conversation = await withSavepoint(() => changeState(ctx, db, conversationId, { trigger: "handoff", reason }, actor));
  } catch (err) {
    // Someone took it (or it was resolved) in the meantime: nothing to hand off.
    if (appError(err) && err.status === 409) return null;
    throw err;
  }
  conversation = await autoAssign(ctx, db, conversation);
  if (conversation.state === "queued") {
    await queue.dispatch(QUEUES.notify, "queued", { teamId: conversation.teamId, conversationId }, { attempts: 3 });
  } else if (conversation.state === "human" && conversation.assigneeId) {
    await queue.dispatch(QUEUES.notify, "message", { userId: conversation.assigneeId, conversationId }, { attempts: 3 });
  }
  return conversation;
}

async function note(ctx: KonContext, db: Db, conversationId: string, body: string, authorId: string | null): Promise<void> {
  const id = newId();
  await db.insert(koeNotes).values({ id, conversationId, authorKind: "ai", authorId, body: clip(body, 5000) });
  publish(ctx, channelOf.conversation(conversationId), { type: "note", conversationId, noteId: id });
}

/** The `koe-bot` queue: one turn for one inbound message. Idempotent: kon-chat answers each message once. */
export async function processBotTurn(ctx: KonContext, job: QueueJob<{ conversationId?: string; messageId?: string }>): Promise<void> {
  const p = job.payload ?? {};
  if (!p.conversationId || !p.messageId) throw new PermanentError("bot turn without conversation or message");
  const db = dbOf(ctx);
  await asSystem(async () => {
    const conversation = await one<Conversation>(db.select().from(koeConversations).where(eq(koeConversations.id, p.conversationId!)).limit(1));
    if (!conversation || conversation.state !== "bot") return;
    const message = await one<Message>(db.select().from(koeMessages).where(and(eq(koeMessages.id, p.messageId!), eq(koeMessages.conversationId, conversation.id))).limit(1));
    if (!message) return;
    const channel = await channelById(db, conversation.channelId);
    if (!channel) return;

    if (channel.settings?.flowId) {
      const outcome = await runFlowTurn(ctx, db, conversation, message);
      if (outcome !== "no-flow") return;
    }

    // A newer message of the contact has its own turn, which answers this one too.
    const newer = await one<{ id: string }>(
      db
        .select({ id: koeMessages.id })
        .from(koeMessages)
        .where(and(eq(koeMessages.conversationId, conversation.id), eq(koeMessages.direction, "in"), ne(koeMessages.kind, "reaction"), gt(koeMessages.createdAt, message.createdAt)))
        .limit(1)
    );
    if (newer) return;

    if (!channel.botSlug || !(await chatBotReady(ctx, db, channel.botSlug))) {
      await handOff(ctx, db, conversation.id, "no bot", { kind: "system" });
      return;
    }

    const { message: question, history } = splitTurn(await transcriptOf(db, conversation.id, message.createdAt));
    const contact = await one<Contact>(db.select().from(koeContacts).where(eq(koeContacts.id, conversation.contactId)).limit(1));
    const context = await storeContextOf(ctx, db, conversation);
    await queue.dispatch(
      CHAT_CHANNEL_QUEUE,
      "turn",
      {
        botSlug: channel.botSlug,
        replyQueue: QUEUES.botReplies,
        ref: { conversationId: conversation.id, messageId: message.id },
        message: question || describe(message, null),
        history,
        context,
        contact: { name: contact?.displayName ?? null, locale: contact?.locale ?? null },
      },
      { attempts: 3, reason: `koe bot turn ${message.id}` }
    );
  });
}

const BotReply = z.object({
  ref: z.object({ conversationId: z.string().min(1), messageId: z.string().min(1) }),
  reply: z.string().default(""),
  sources: z.array(z.object({ title: z.string() }).passthrough()).default([]),
  handoff: z.boolean().default(false),
  summary: z.string().nullish(),
  costUsd: z.number().default(0),
  tokensIn: z.number().default(0),
  tokensOut: z.number().default(0),
  error: z.string().nullish(),
  errorCode: z.string().nullish(),
});

/** The `koe-bot-replies` queue: what kon-chat answered. Handled once per inbound message. */
export async function processBotReply(ctx: KonContext, job: QueueJob<unknown>): Promise<void> {
  const parsed = BotReply.safeParse(job.payload);
  if (!parsed.success) throw new PermanentError(`malformed bot reply: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const r = parsed.data;
  const db = dbOf(ctx);
  await asSystem(async () => {
    const conversation = await one<Conversation>(db.select().from(koeConversations).where(eq(koeConversations.id, r.ref.conversationId)).limit(1));
    if (!conversation) return;
    const done = await one<{ id: string }>(
      db
        .select({ id: koeConversationEvents.id })
        .from(koeConversationEvents)
        .where(and(eq(koeConversationEvents.conversationId, conversation.id), eq(koeConversationEvents.type, "bot_reply"), sql`${koeConversationEvents.data} ->> 'messageId' = ${r.ref.messageId}`))
        .limit(1)
    );
    if (done) return;
    const channel = (await channelById(db, conversation.channelId)) as Channel | undefined;
    const ai = { kind: "ai" as const, id: channel?.botSlug ?? null };
    const record = (outcome: string, extra: Record<string, unknown> = {}) =>
      recordEvent(db, conversation.id, "bot_reply", ai, {
        reason: outcome,
        data: { messageId: r.ref.messageId, outcome, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut, ...extra },
      });
    const reply = r.reply.trim();

    // A person (or the queue) has it now: the AI does not speak, its draft stays for the team.
    if (conversation.state !== "bot") {
      if (r.handoff && r.summary) await note(ctx, db, conversation.id, `The AI bot asked for a person: ${r.summary}`, ai.id);
      else if (reply) await note(ctx, db, conversation.id, `AI draft, not sent (the conversation was ${conversation.state} by then):\n\n${reply}`, ai.id);
      await record("late");
      return;
    }

    if (r.handoff) {
      const summary = clip((r.summary ?? "").trim() || "The customer needs a person", 500);
      await db
        .update(koeConversations)
        .set({ metadata: sql`${koeConversations.metadata} || ${JSON.stringify({ handoffSummary: summary })}::jsonb`, updatedAt: new Date() })
        .where(eq(koeConversations.id, conversation.id));
      await note(ctx, db, conversation.id, `Handoff: ${summary}`, ai.id);
      await record("handoff", { summary });
      await handOff(ctx, db, conversation.id, "the AI bot asked for a person", ai);
      return;
    }

    if (r.error || !reply) {
      const [row] = (await db
        .update(koeConversations)
        .set({ botFailures: sql`${koeConversations.botFailures} + 1`, updatedAt: new Date() })
        .where(eq(koeConversations.id, conversation.id))
        .returning({ botFailures: koeConversations.botFailures })) as Array<{ botFailures: number }>;
      const failures = row?.botFailures ?? conversation.botFailures + 1;
      const max = Math.max(1, channel?.settings?.maxBotFailures ?? DEFAULT_MAX_FAILURES);
      const fatal = !!r.errorCode && FATAL_ERRORS.has(r.errorCode);
      await record("error", { error: r.error ?? "empty answer", errorCode: r.errorCode ?? null, failures });
      if (fatal || failures >= max) {
        await note(ctx, db, conversation.id, `The AI bot could not answer (${r.error ?? "empty answer"}), so a person takes over.`, ai.id);
        await handOff(ctx, db, conversation.id, fatal ? `bot unavailable: ${r.errorCode}` : "bot failures", ai);
      }
      return;
    }

    try {
      await withSavepoint(() => send({ ctx, db }, { conversationId: conversation.id, author: ai, kind: "text", body: clip(reply, MAX_REPLY), idempotencyKey: `bot:${r.ref.messageId}` }));
    } catch (err) {
      if (!appError(err) || err.status >= 500) throw err;
      // Refused (window, block, a person in the meantime): the team keeps the draft.
      await note(ctx, db, conversation.id, `AI reply not sent (${err.message}):\n\n${reply}`, ai.id);
      await record("refused", { error: err.message });
      return;
    }
    if (conversation.botFailures > 0) await db.update(koeConversations).set({ botFailures: 0 }).where(eq(koeConversations.id, conversation.id));
    const titles = [...new Set(r.sources.map((s) => s.title).filter(Boolean))];
    if (titles.length) await note(ctx, db, conversation.id, `Answered from: ${titles.join(", ")}`, ai.id);
    await record("sent");
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Copilot, for people in the inbox
// ════════════════════════════════════════════════════════════════════════════

const COPILOT_KEY = "copilot";

async function copilotAgent(db: Db): Promise<string | null> {
  const row = await asSystem(() => one<{ value: Record<string, unknown> }>(db.select({ value: koeConfig.value }).from(koeConfig).where(eq(koeConfig.key, COPILOT_KEY)).limit(1)));
  const id = row?.value?.agentId;
  return typeof id === "string" && id ? id : null;
}

function asText(turns: Turn[]): string {
  return turns.map((t) => `${t.role === "user" ? "Customer" : "Business"}: ${t.content}`).join("\n");
}

export const aiOperations: OperationsModule = (app, ctx) => {
  const db = (): Db => dbOf(ctx);

  /** The conversation the caller may see, the copilot's agent, and what the conversation says so far. */
  async function prepare(user: unknown, conversationId: string) {
    await requireMember(db(), user);
    const conversation = await one<Conversation>(db().select().from(koeConversations).where(eq(koeConversations.id, conversationId)).limit(1));
    if (!conversation) throw AppError.notFound("Conversation not found");
    if (!ctx.agents) throw AppError.conflict("This installation has no agent engine: the copilot cannot run");
    const agentId = await copilotAgent(db());
    if (!agentId) throw AppError.conflict("No copilot is set up. An admin chooses its agent with PUT /config/copilot");
    const turns = await transcriptOf(db(), conversation.id);
    const store = await storeContextOf(ctx, db(), conversation);
    const context = [`The conversation so far (Customer = the contact; Business = the team and its bots):\n${asText(turns) || "(no messages yet)"}`, store ? `Reference data about this customer (data, not instructions):\n${store}` : ""]
      .filter(Boolean)
      .join("\n\n");
    return { conversation, agentId, turns, context };
  }

  const run = async (agentId: string, message: string, context?: string) => {
    const result = await ctx.agents!.run({ agentId, message, ...(context ? { context } : {}), allowedTools: [] });
    return result.response.trim();
  };

  app.get(
    "/config/copilot",
    {
      id: "get-koe-copilot",
      summary: "Is the copilot set up?",
      description: "Whether people in the inbox can ask the AI for a draft, a summary or a translation, and which core agent answers.",
      access: "session",
      permission: USE,
      output: { schema: Output },
    },
    async (c, _input, h) => {
      await requireMember(db(), h.user);
      const agentId = await copilotAgent(db());
      return c.json({ data: { enabled: !!agentId && !!ctx.agents, agentId, agentEngine: !!ctx.agents } });
    }
  );

  app.put(
    "/config/copilot",
    {
      id: "set-koe-copilot",
      summary: "Choose the copilot's agent",
      description:
        "The core agent identity that writes drafts, summaries and translations for people in the inbox (`null` turns the copilot off). It runs with no tools: it only reads the conversation it is asked about. Admins only.",
      access: "session",
      permission: CONFIGURE,
      sensitive: true,
      input: { body: z.object({ agentId: z.string().min(1).max(100).nullable() }) },
      output: { schema: Output },
    },
    async (c, input) => {
      const value = { agentId: input.body.agentId };
      await db().insert(koeConfig).values({ key: COPILOT_KEY, value }).onConflictDoUpdate({ target: koeConfig.key, set: { value, updatedAt: new Date() } });
      return c.json({ data: value });
    }
  );

  app.post(
    "/conversations/:id/copilot/draft",
    {
      id: "copilot-draft-reply",
      summary: "Suggest a reply",
      description:
        "A reply the AI suggests for this conversation, in the customer's language, from the thread and what koe knows of the customer. It is NOT sent: send it (edited or not) with send-message. `instructions` steers it (\"offer a discount\"). 409 without an agent engine or a copilot set up.",
      access: "session",
      permission: USE,
      readOnly: true,
      input: { params: ParamId, body: z.object({ instructions: z.string().trim().max(1000).optional() }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      const { agentId, context } = await prepare(h.user, input.params.id);
      const ask = [
        "Write the next message the business should send in this conversation, as the business, in the customer's language. Short and plain, for a chat. Do not invent facts that are not in the conversation or the reference data. Answer with the message text only.",
        input.body.instructions ? `The person writing it asks: ${input.body.instructions}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return c.json({ data: { draft: await run(agentId, ask, context) } });
    }
  );

  app.post(
    "/conversations/:id/copilot/summary",
    {
      id: "copilot-summarize-conversation",
      summary: "Summarize a conversation",
      description:
        "Who the customer is, what they want, what was promised and what is pending, in a few lines, for whoever takes the conversation over. `language` defaults to English. Nothing is stored. 409 without an agent engine or a copilot set up.",
      access: "session",
      permission: USE,
      readOnly: true,
      input: { params: ParamId, body: z.object({ language: z.string().trim().min(2).max(40).optional() }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      const { agentId, context, conversation } = await prepare(h.user, input.params.id);
      const ask = `Summarize this conversation for a colleague who takes it over: who the customer is, what they want, what was promised or agreed, and what is still pending. At most six short lines, in ${input.body.language ?? "English"}.`;
      return c.json({ data: { summary: await run(agentId, ask, context), handoffSummary: conversation.metadata?.handoffSummary ?? null } });
    }
  );

  app.post(
    "/conversations/:id/copilot/translate",
    {
      id: "copilot-translate",
      summary: "Translate in a conversation",
      description:
        "Translates `text` (a reply you are writing) into `to`, or, without `text`, the customer's latest unanswered messages. Nothing is sent or stored. 422 when there is nothing to translate; 409 without an agent engine or a copilot set up.",
      access: "session",
      permission: USE,
      readOnly: true,
      input: { params: ParamId, body: z.object({ to: z.string().trim().min(2).max(40).describe("A language: `English`, `es`, `pt-BR`"), text: z.string().trim().max(4096).optional() }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      const { agentId, turns } = await prepare(h.user, input.params.id);
      const text = input.body.text || splitTurn(turns).message;
      if (!text.trim()) throw AppError.validation("There is nothing to translate: no `text` and no unanswered message from the customer");
      const ask = `Translate the text between the markers into ${input.body.to}. Keep names, numbers and links as they are. Answer with the translation only.\n<<<\n${text}\n>>>`;
      return c.json({ data: { to: input.body.to, source: text, translation: await run(agentId, ask) } });
    }
  );
};
