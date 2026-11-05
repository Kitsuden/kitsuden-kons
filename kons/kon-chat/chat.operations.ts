/**
 * kon-chat's operations
 * ============================================================================
 *
 * Admins set bots up, give them knowledge and read what happened (conversations, feedback, spending). The team
 * talks to team bots; anyone talks to a public bot through `/public/…`, which the core's gates leave open and the
 * kon limits by itself. Each way of talking comes twice: a plain answer, and the same answer streamed in the AI
 * SDK's protocol (`/stream`).
 */

import { createHash } from "node:crypto";

import { AppError, asSystem, type AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";

import { addDocument, textOfFile } from "./chat.knowledge";
import { chatBots, chatConversations, chatDocuments, chatMessages } from "./chat.schema";
import { MAX_MESSAGE_CHARS, converse, fork, mayUse, messagesOf, rate, speakersConversation, type Bot, type Speaker } from "./chat.service";
import { streamTurn } from "./chat.stream";
import { widgetScript } from "./chat.widget";
import { CONFIGURE, USE, registry } from "./operations";

const Output = z.object({}).passthrough();
const ParamId = z.object({ id: z.string().min(1).max(100).describe("Row id") });
const ParamSlug = z.object({ slug: z.string().min(1).max(60).describe("The bot's slug") });
const ParamSlugId = ParamSlug.extend({ id: z.string().min(1).max(100).describe("Row id") });

const BotFields = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,59}$/).describe("Its address: lowercase letters, digits and dashes"),
  name: z.string().trim().min(1).max(200),
  agentId: z.string().min(1).max(100).describe("The core agent identity that answers: its model, prompt and scopes"),
  audience: z.enum(["team", "public"]).describe("`team`: signed-in admins and editors. `public`: anyone, through the widget, with no tools"),
  toolset: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .describe("Team bots only: the tool group it may use, as `kon:<id>/<group>` (`kon:crm/assistant`). Without it, no tools"),
  greeting: z.string().trim().max(1000).nullable().optional(),
  members: z.array(z.string().min(1).max(100)).max(500).optional().describe("Team bots: only these user ids may talk to it. Empty = the whole team"),
  allowedOrigins: z.array(z.string().url().max(300)).max(20).optional().describe("Public bots: the sites that may embed it. Empty = any"),
  dailyLimit: z.number().int().min(1).max(100_000).optional(),
  userDailyLimit: z.number().int().min(1).max(100_000).optional().describe("Questions per person per day (team bots)"),
  visitorHourlyLimit: z.number().int().min(1).max(1000).optional(),
  priceInPerMillion: z.number().min(0).max(10_000).optional().describe("USD per million input tokens of its agent's model"),
  priceOutPerMillion: z.number().min(0).max(10_000).optional().describe("USD per million output tokens"),
  dailyBudgetUsd: z.number().positive().max(1_000_000).nullable().optional().describe("Stops answering for the day once spent"),
  active: z.boolean().optional(),
});

const Knowledge = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().min(1).max(500_000).describe("Plain text or Markdown"),
});

const Message = z.object({
  message: z.string().max(MAX_MESSAGE_CHARS).optional().describe("The question. Leave it out with `regenerate`"),
  conversationId: z.string().max(100).optional().describe("To continue a conversation of yours"),
  regenerate: z.boolean().optional().describe("Answer the last question of `conversationId` again, replacing its answer"),
});
const Visitor = z.object({
  visitorId: z.string().min(20).max(200).describe("A random key the visitor's browser keeps; only its hash is stored"),
});
const PublicMessage = Message.merge(Visitor);

/** What arrives over the wire: a few megabytes of base64 for a PDF. The extracted text has its own, smaller cap. */
const MAX_ATTACHMENT_CHARS = 2_000_000;

const Fork = z.object({ fromMessageId: z.string().min(1).max(100).describe("The last message to keep") });
const Attachment = z.object({
  conversationId: z.string().max(100).optional().describe("Leave it out to start a conversation with the file"),
  title: z.string().trim().min(1).max(300),
  mime: z.string().max(100).optional().describe("Default text/plain. PDF, HTML and images need kon-ingest; send them base64"),
  content: z.string().min(1).max(MAX_ATTACHMENT_CHARS).describe("Text, or base64 for a binary file"),
});
const Feedback = z.object({ rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().trim().max(2000).optional() });

const ATTACHMENTS_PER_CONVERSATION = 5;
const ATTACHMENT_TEXT_MAX = 200_000;

const visitorKey = (visitorId: string) => createHash("sha256").update(visitorId).digest("hex");

/** A public bot answers only the sites it lists, when it lists any. */
function originAllowed(bot: Bot, origin: string | undefined): boolean {
  const allowed = bot.allowedOrigins ?? [];
  if (allowed.length === 0) return true;
  if (!origin) return false;
  return allowed.some((o) => new URL(o).origin === origin);
}

const money = (n: number | undefined | null) => (n === undefined ? undefined : n === null ? null : n.toFixed(4));

export function chatOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the host's Drizzle instance
  const db = (): any => ctx.db.instance;

  const botBy = async (column: "id" | "slug", value: string): Promise<Bot | undefined> => {
    const [bot] = await db()
      .select()
      .from(chatBots)
      .where(eq(column === "id" ? chatBots.id : chatBots.slug, value));
    return bot;
  };

  /** A team bot this person may talk to, or 404: a bot someone may not use is a bot that does not exist for them. */
  const teamBot = async (c: Context, slug: string): Promise<{ bot: Bot; speaker: Speaker }> => {
    const user = c.get("user") as { id?: string } | undefined;
    const bot = await botBy("slug", slug);
    if (!bot || !bot.active || bot.audience !== "team" || !mayUse(bot, user?.id)) throw AppError.notFound("Bot not found");
    return { bot, speaker: { userId: user!.id } };
  };

  const publicBot = async (c: Context, slug: string, visitorId: string): Promise<{ bot: Bot; speaker: Speaker }> => {
    const bot = await asSystem(() => botBy("slug", slug));
    if (!bot || !bot.active || bot.audience !== "public") throw AppError.notFound("Bot not found");
    if (!originAllowed(bot, c.req.header("origin") ?? undefined)) throw AppError.forbidden("This assistant is not available on this site");
    return { bot, speaker: { visitorKey: visitorKey(visitorId) } };
  };

  const toRow = (body: Partial<z.infer<typeof BotFields>>) => {
    const { priceInPerMillion, priceOutPerMillion, dailyBudgetUsd, ...rest } = body;
    return {
      ...rest,
      ...(priceInPerMillion !== undefined ? { priceInPerMillion: money(priceInPerMillion)! } : {}),
      ...(priceOutPerMillion !== undefined ? { priceOutPerMillion: money(priceOutPerMillion)! } : {}),
      ...(dailyBudgetUsd !== undefined ? { dailyBudgetUsd: dailyBudgetUsd === null ? null : dailyBudgetUsd.toFixed(2) } : {}),
    };
  };

  /** A visitor sees what they need: no internal ids, no cost. */
  const forVisitor = (r: Awaited<ReturnType<typeof converse>>) => ({
    conversationId: r.conversationId,
    messageId: r.messageId,
    reply: r.reply,
    sources: r.sources.map((s) => s.title),
  });

  // ── Bots ──────────────────────────────────────────────────────────────────

  app.get(
    "/bots",
    {
      id: "list-chatbots",
      summary: "List the chatbots",
      description: "Every bot with its agent, audience, members, tool group, limits, prices and budget. Admin only.",
      access: "session",
      permission: CONFIGURE,
      output: { schema: Output },
    },
    async (c) => c.json({ data: await db().select().from(chatBots).orderBy(desc(chatBots.createdAt)) })
  );

  app.post(
    "/bots",
    {
      id: "create-chatbot",
      summary: "Create a chatbot",
      description:
        "A channel to one of the core's agents. A `public` bot answers anyone on a website and never uses tools; a `team` bot may use one tool group (`toolset`), within what its agent may already do, and may be limited to some `members`. Prices per million tokens make spending and `dailyBudgetUsd` meaningful. 409 if the slug is taken. Admin only.",
      access: "session",
      permission: CONFIGURE,
      sensitive: true,
      input: { body: BotFields },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const body = input.body as z.infer<typeof BotFields>;
      if (body.audience === "public" && body.toolset) throw AppError.validation("A public bot cannot use tools: leave `toolset` out");
      if (body.audience === "public" && body.members?.length) throw AppError.validation("A public bot has no members: it is for anyone");
      if (await botBy("slug", body.slug)) throw AppError.conflict("That slug is taken");
      const user = c.get("user") as { id?: string } | undefined;
      const [row] = await db()
        .insert(chatBots)
        .values({ id: createId(), ...toRow(body), toolset: body.toolset ?? null, createdBy: user?.id ?? null })
        .returning();
      return c.json({ data: row }, 201);
    }
  );

  app.patch(
    "/bots/:id",
    {
      id: "update-chatbot",
      summary: "Change a chatbot",
      description: "Any of its settings. A public bot still cannot have tools or members (422). 404 if it does not exist. Admin only.",
      access: "session",
      permission: CONFIGURE,
      sensitive: true,
      input: { params: ParamId, body: BotFields.partial() },
      output: { schema: Output },
    },
    async (c, input) => {
      const bot = await botBy("id", input.params.id);
      if (!bot) throw AppError.notFound("Bot not found");
      const next = { ...bot, ...input.body };
      if (next.audience === "public" && next.toolset) throw AppError.validation("A public bot cannot use tools: clear `toolset` first");
      if (next.audience === "public" && (next.members ?? []).length) throw AppError.validation("A public bot has no members: clear `members` first");
      if (input.body.slug && input.body.slug !== bot.slug && (await botBy("slug", input.body.slug))) throw AppError.conflict("That slug is taken");
      const [row] = await db()
        .update(chatBots)
        .set({ ...toRow(input.body), updatedAt: new Date() })
        .where(eq(chatBots.id, bot.id))
        .returning();
      return c.json({ data: row });
    }
  );

  app.delete(
    "/bots/:id",
    {
      id: "delete-chatbot",
      summary: "Delete a chatbot",
      description: "With its knowledge and its conversations. 404 if it does not exist. Admin only.",
      access: "session",
      permission: CONFIGURE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input) => {
      const removed = await db().delete(chatBots).where(eq(chatBots.id, input.params.id)).returning({ id: chatBots.id });
      if (removed.length === 0) throw AppError.notFound("Bot not found");
      return c.json({ data: { id: input.params.id, deleted: true } });
    }
  );

  // ── Knowledge ─────────────────────────────────────────────────────────────

  app.get(
    "/bots/:id/knowledge",
    {
      id: "list-chatbot-knowledge",
      summary: "List what a chatbot knows",
      description: "Its documents (not conversations' attachments) with how many chunks each has and whether they have embeddings. Admin only.",
      access: "session",
      permission: CONFIGURE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input) =>
      c.json({
        data: await db()
          .select({ id: chatDocuments.id, title: chatDocuments.title, chunkCount: chatDocuments.chunkCount, embedded: chatDocuments.embedded, createdAt: chatDocuments.createdAt })
          .from(chatDocuments)
          .where(and(eq(chatDocuments.botId, input.params.id), isNull(chatDocuments.conversationId)))
          .orderBy(desc(chatDocuments.createdAt)),
      })
  );

  app.post(
    "/bots/:id/knowledge",
    {
      id: "add-chatbot-knowledge",
      summary: "Teach a chatbot a document",
      description:
        "Text or Markdown, cut into chunks it searches before answering; with an embeddings provider in the core, by meaning, otherwise by words. Whoever may talk to the bot may read what it was taught, so a public bot gets only public material. 400 past 5,000 chunks per bot where there is no pgvector. Admin only.",
      access: "session",
      permission: CONFIGURE,
      sensitive: true,
      input: { params: ParamId, body: Knowledge },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const bot = await botBy("id", input.params.id);
      if (!bot) throw AppError.notFound("Bot not found");
      const user = c.get("user") as { id?: string } | undefined;
      try {
        const doc = await addDocument(db(), ctx.ai?.embed.bind(ctx.ai), { botId: bot.id, ...input.body, createdBy: user?.id ?? null });
        return c.json({ data: doc }, 201);
      } catch (err) {
        if ((err as { code?: string }).code === "too-much") throw AppError.badRequest((err as Error).message);
        throw err;
      }
    }
  );

  app.delete(
    "/knowledge/:id",
    {
      id: "delete-chatbot-knowledge",
      summary: "Make a chatbot forget a document",
      description: "With all its chunks. 404 if it does not exist. Admin only.",
      access: "session",
      permission: CONFIGURE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input) => {
      const removed = await db().delete(chatDocuments).where(eq(chatDocuments.id, input.params.id)).returning({ id: chatDocuments.id });
      if (removed.length === 0) throw AppError.notFound("Document not found");
      return c.json({ data: { id: input.params.id, deleted: true } });
    }
  );

  // ── Oversight ─────────────────────────────────────────────────────────────

  app.get(
    "/bots/:id/conversations",
    {
      id: "list-chatbot-conversations",
      summary: "List a chatbot's conversations",
      description: "Newest first, with their message counts: to see what people ask and how it answers. Admin only.",
      access: "session",
      permission: CONFIGURE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input) =>
      c.json({ data: await db().select().from(chatConversations).where(eq(chatConversations.botId, input.params.id)).orderBy(desc(chatConversations.lastAt)).limit(200) })
  );

  app.get(
    "/bots/:id/usage",
    {
      id: "get-chatbot-usage",
      summary: "See what a chatbot answered and spent",
      description:
        "Per day for the last `days` (default 30, at most 365): questions, tokens in and out, cost in USD at the bot's prices, and ratings up and down. Plus today's totals against its limits and budget. Admin only.",
      access: "session",
      permission: CONFIGURE,
      input: { params: ParamId, query: z.object({ days: z.string().optional() }) },
      output: { schema: Output },
    },
    async (c, input) => {
      const bot = await botBy("id", input.params.id);
      if (!bot) throw AppError.notFound("Bot not found");
      const days = Math.min(Math.max(Number(input.query.days) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86_400_000);
      const day = sql<string>`to_char(date_trunc('day', ${chatMessages.createdAt}), 'YYYY-MM-DD')`;
      const rows = await db()
        .select({
          day,
          questions: sql<number>`count(*) FILTER (WHERE ${chatMessages.role} = 'user')::int`,
          tokensIn: sql<number>`coalesce(sum(${chatMessages.tokensIn}), 0)::int`,
          tokensOut: sql<number>`coalesce(sum(${chatMessages.tokensOut}), 0)::int`,
          costUsd: sql<string>`coalesce(sum(${chatMessages.costUsd}), 0)`,
          up: sql<number>`count(*) FILTER (WHERE ${chatMessages.feedback} = 1)::int`,
          down: sql<number>`count(*) FILTER (WHERE ${chatMessages.feedback} = -1)::int`,
        })
        .from(chatMessages)
        .where(and(eq(chatMessages.botId, bot.id), gte(chatMessages.createdAt, since)))
        .groupBy(sql`1`)
        .orderBy(sql`1 DESC`);
      const last24 = new Date(Date.now() - 86_400_000);
      const [today] = await db()
        .select({ questions: sql<number>`count(*) FILTER (WHERE ${chatMessages.role} = 'user')::int`, costUsd: sql<string>`coalesce(sum(${chatMessages.costUsd}), 0)` })
        .from(chatMessages)
        .where(and(eq(chatMessages.botId, bot.id), gte(chatMessages.createdAt, last24)));
      return c.json({
        data: {
          days: rows.map((r: Record<string, unknown>) => ({ ...r, costUsd: Number(r.costUsd) })),
          last24h: { questions: today?.questions ?? 0, costUsd: Number(today?.costUsd ?? 0), dailyLimit: bot.dailyLimit, dailyBudgetUsd: bot.dailyBudgetUsd == null ? null : Number(bot.dailyBudgetUsd) },
        },
      });
    }
  );

  app.get(
    "/bots/:id/feedback",
    {
      id: "list-chatbot-feedback",
      summary: "Read the answers people rated",
      description: "Newest first, each answer with its rating, comment and the question before it; `rating=down` for only the bad ones. Admin only.",
      access: "session",
      permission: CONFIGURE,
      input: { params: ParamId, query: z.object({ rating: z.enum(["up", "down"]).optional() }) },
      output: { schema: Output },
    },
    async (c, input) => {
      const rated = await db()
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.botId, input.params.id),
            isNotNull(chatMessages.feedback),
            input.query.rating ? eq(chatMessages.feedback, input.query.rating === "up" ? 1 : -1) : undefined
          )
        )
        .orderBy(desc(chatMessages.feedbackAt))
        .limit(200);
      const data = [];
      for (const m of rated) {
        const [question] = await db()
          .select({ content: chatMessages.content })
          .from(chatMessages)
          .where(and(eq(chatMessages.conversationId, m.conversationId), eq(chatMessages.role, "user"), sql`${chatMessages.createdAt} < ${m.createdAt}`))
          .orderBy(desc(chatMessages.createdAt))
          .limit(1);
        data.push({ messageId: m.id, conversationId: m.conversationId, question: question?.content ?? null, answer: m.content, rating: m.feedback, comment: m.feedbackComment, at: m.feedbackAt });
      }
      return c.json({ data });
    }
  );

  app.get(
    "/conversations/:id",
    {
      id: "get-chat-conversation",
      summary: "Read a chat conversation",
      description: "Its messages, oldest first, as parts (text, tools called, approvals waited for, sources), with ratings and cost. Yours, or any if you are an admin. 404 otherwise.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input) => {
      const [conversation] = await db().select().from(chatConversations).where(eq(chatConversations.id, input.params.id));
      if (!conversation) throw AppError.notFound("Conversation not found");
      return c.json({ data: { ...conversation, messages: await messagesOf(db(), conversation.id) } });
    }
  );

  // ── Talking to a team bot ─────────────────────────────────────────────────

  app.post(
    "/bots/:slug/chat",
    {
      id: "send-chat-message",
      summary: "Ask a team chatbot",
      description:
        "Answers with `reply`, its `parts` (text, the tools it called, `approval` parts for tools held for a person, sources), `pendingApprovals` (proposal ids) and `costUsd`. Pass `conversationId` to continue one of yours, and `regenerate: true` to answer its last question again. 404 for an unknown, inactive or public bot, or one you are not a member of; 429 past a daily limit or budget; 409 without an agent engine. Admins and editors.",
      access: "session",
      permission: USE,
      mcp: { exclude: "Agents have the tools directly; a bot is for people." },
      input: { params: ParamSlug, body: Message },
      output: { schema: Output },
    },
    async (c, input) => {
      const { bot, speaker } = await teamBot(c, input.params.slug);
      const root = ctx.db.instance;
      return c.json({ data: await asSystem(() => converse(ctx, root, bot, speaker, input.body)) });
    }
  );

  app.post(
    "/bots/:slug/chat/stream",
    {
      id: "stream-chat-message",
      summary: "Ask a team chatbot, streamed",
      description:
        "The same as `send-chat-message`, as server-sent events in the AI SDK's UI message stream protocol (`useChat` reads it directly): text as it is written, tool calls and results, `tool-approval-request` for a tool held for a person, `source-document`s, and a `data-chat` part with `conversationId` and `messageId`. Limits and missing conversations arrive as an `error` part. Admins and editors.",
      access: "session",
      permission: USE,
      mcp: { exclude: "A stream for chat interfaces, not a tool." },
      input: { params: ParamSlug, body: Message },
      output: { type: "text/event-stream" },
    },
    async (c, input) => {
      const { bot, speaker } = await teamBot(c, input.params.slug);
      const root = ctx.db.instance;
      return streamTurn(ctx, (messageId, onEvent) => converse(ctx, root, bot, speaker, { ...input.body, messageId }, onEvent), false);
    }
  );

  app.post(
    "/bots/:slug/attachments",
    {
      id: "attach-to-chat",
      summary: "Attach a file to a team chat",
      description:
        "Its text becomes something only that conversation searches (\"what does this contract say?\"); without `conversationId` it starts one. Text and Markdown as they are; PDF, HTML and images base64, through kon-ingest (422 without it). At most 5 per conversation and 200,000 characters of text each. Admins and editors.",
      access: "session",
      permission: USE,
      mcp: { exclude: "Files for a chat interface." },
      input: { params: ParamSlug, body: Attachment },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const { bot, speaker } = await teamBot(c, input.params.slug);
      return c.json({ data: await attach(bot, speaker, input.body) }, 201);
    }
  );

  app.post(
    "/conversations/:id/fork",
    {
      id: "fork-chat-conversation",
      summary: "Branch a team chat",
      description:
        "A new conversation with the messages up to `fromMessageId`, to ask something else from there without losing the original. Editing a question is a fork before it, then the new question. Returns the new `conversationId`. 404 if it is not yours. Admins and editors.",
      access: "session",
      permission: USE,
      mcp: { exclude: "For chat interfaces." },
      input: { params: ParamId, body: Fork },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const user = c.get("user") as { id?: string } | undefined;
      const conversation = await asSystem(async () => (await db().select().from(chatConversations).where(eq(chatConversations.id, input.params.id)))[0]);
      const bot = conversation ? await asSystem(() => botBy("id", conversation.botId)) : undefined;
      if (!conversation || !bot || !mayUse(bot, user?.id)) throw AppError.notFound("Conversation not found");
      const root = ctx.db.instance;
      const id = await asSystem(() => fork(root, bot, { userId: user!.id }, conversation.id, input.body.fromMessageId));
      return c.json({ data: { conversationId: id } }, 201);
    }
  );

  app.post(
    "/messages/:id/feedback",
    {
      id: "rate-chat-answer",
      summary: "Rate a team chatbot's answer",
      description: "`rating`: 1 or -1, with an optional `comment`; a new rating replaces yours. 404 if the answer is not in one of your conversations. Admins and editors.",
      access: "session",
      permission: USE,
      mcp: { exclude: "For chat interfaces." },
      input: { params: ParamId, body: Feedback },
      output: { schema: Output },
    },
    async (c, input) => {
      const user = c.get("user") as { id?: string } | undefined;
      const message = await asSystem(async () => (await db().select().from(chatMessages).where(eq(chatMessages.id, input.params.id)))[0]);
      const bot = message ? await asSystem(() => botBy("id", message.botId)) : undefined;
      if (!message || !bot || !user?.id) throw AppError.notFound("Answer not found");
      const root = ctx.db.instance;
      return c.json({ data: await asSystem(() => rate(root, bot, { userId: user.id }, message.id, input.body.rating, input.body.comment)) });
    }
  );

  // ── Talking to a public bot ───────────────────────────────────────────────

  app.get(
    "/public/bots/:slug",
    {
      id: "get-public-chatbot",
      summary: "Read a public chatbot's name and greeting",
      description: "What the widget shows before the first question. 404 for an unknown, inactive or team bot.",
      access: "public",
      mcp: { exclude: "For the website widget." },
      input: { params: ParamSlug },
      output: { schema: Output },
    },
    async (c, input) => {
      const bot = await asSystem(() => botBy("slug", input.params.slug));
      if (!bot || !bot.active || bot.audience !== "public") throw AppError.notFound("Bot not found");
      return c.json({ data: { slug: bot.slug, name: bot.name, greeting: bot.greeting } });
    }
  );

  app.post(
    "/public/bots/:slug/chat",
    {
      id: "send-public-chat-message",
      summary: "Ask a public chatbot",
      description:
        "For a visitor, with no account: answers from the bot's knowledge and the visitor's own attachments, never with tools. `visitorId` is a random key the browser keeps (only its hash is stored); `conversationId` continues one of that visitor's conversations, `regenerate: true` answers its last question again. 404 for an unknown, inactive or team bot; 403 from a site the bot does not list; 429 past the visitor's hourly or the bot's daily limit or budget. Rate limited per connection.",
      access: "public",
      mcp: { exclude: "For the website widget." },
      input: { params: ParamSlug, body: PublicMessage },
      output: { schema: Output },
    },
    async (c, input) => {
      const { visitorId, ...message } = input.body as z.infer<typeof PublicMessage>;
      const { bot, speaker } = await publicBot(c, input.params.slug, visitorId);
      const root = ctx.db.instance;
      return c.json({ data: forVisitor(await asSystem(() => converse(ctx, root, bot, speaker, message))) });
    }
  );

  app.post(
    "/public/bots/:slug/chat/stream",
    {
      id: "stream-public-chat-message",
      summary: "Ask a public chatbot, streamed",
      description:
        "The same as `send-public-chat-message`, as server-sent events in the AI SDK's UI message stream protocol: text as it is written, `source-document`s by title, and a `data-chat` part with `conversationId` and `messageId`. Limits arrive as an `error` part. Rate limited per connection.",
      access: "public",
      mcp: { exclude: "For the website widget." },
      input: { params: ParamSlug, body: PublicMessage },
      output: { type: "text/event-stream" },
    },
    async (c, input) => {
      const { visitorId, ...message } = input.body as z.infer<typeof PublicMessage>;
      const { bot, speaker } = await publicBot(c, input.params.slug, visitorId);
      const root = ctx.db.instance;
      return streamTurn(ctx, (messageId, onEvent) => converse(ctx, root, bot, speaker, { ...message, messageId }, onEvent), true);
    }
  );

  app.post(
    "/public/bots/:slug/attachments",
    {
      id: "attach-to-public-chat",
      summary: "Attach a file to a public chat",
      description:
        "The same as `attach-to-chat`, for a visitor's own conversation: only that conversation searches it. Rate limited per connection.",
      access: "public",
      mcp: { exclude: "For the website widget." },
      input: { params: ParamSlug, body: Attachment.merge(Visitor) },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const { visitorId, ...body } = input.body as z.infer<typeof Attachment> & z.infer<typeof Visitor>;
      const { bot, speaker } = await publicBot(c, input.params.slug, visitorId);
      return c.json({ data: await attach(bot, speaker, body) }, 201);
    }
  );

  app.post(
    "/public/bots/:slug/conversations/:id/fork",
    {
      id: "fork-public-chat-conversation",
      summary: "Branch a public chat",
      description: "The same as `fork-chat-conversation`, for a visitor's own conversation. Rate limited per connection.",
      access: "public",
      mcp: { exclude: "For the website widget." },
      input: { params: ParamSlugId, body: Fork.merge(Visitor) },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const { visitorId, fromMessageId } = input.body as z.infer<typeof Fork> & z.infer<typeof Visitor>;
      const { bot, speaker } = await publicBot(c, input.params.slug, visitorId);
      const root = ctx.db.instance;
      return c.json({ data: { conversationId: await asSystem(() => fork(root, bot, speaker, input.params.id, fromMessageId)) } }, 201);
    }
  );

  app.post(
    "/public/bots/:slug/messages/:id/feedback",
    {
      id: "rate-public-chat-answer",
      summary: "Rate a public chatbot's answer",
      description: "The same as `rate-chat-answer`, for an answer in the visitor's own conversation. Rate limited per connection.",
      access: "public",
      mcp: { exclude: "For the website widget." },
      input: { params: ParamSlugId, body: Feedback.merge(Visitor) },
      output: { schema: Output },
    },
    async (c, input) => {
      const { visitorId, rating, comment } = input.body as z.infer<typeof Feedback> & z.infer<typeof Visitor>;
      const { bot, speaker } = await publicBot(c, input.params.slug, visitorId);
      const root = ctx.db.instance;
      return c.json({ data: await asSystem(() => rate(root, bot, speaker, input.params.id, rating, comment)) });
    }
  );

  app.get(
    "/public/widget.js",
    {
      id: "get-chat-widget",
      summary: "Embeddable chat widget (JavaScript)",
      description: "A self-contained script: `<script src=\".../api/chat/public/widget.js\" data-bot=\"<slug>\"></script>` adds a chat button to the page. It streams answers and lets the visitor rate them. Public.",
      access: "public",
      output: { type: "application/javascript" },
      mcp: { exclude: "JavaScript asset for web pages, not data" },
    },
    (c) => {
      c.header("Content-Type", "application/javascript; charset=utf-8");
      c.header("Cache-Control", "public, max-age=300");
      return c.body(widgetScript());
    }
  );

  /** A file's text as something only its conversation searches. */
  async function attach(bot: Bot, speaker: Speaker, body: z.infer<typeof Attachment>) {
    const root = ctx.db.instance;
    let text: string;
    try {
      text = await textOfFile(body.mime ?? "text/plain", body.content);
    } catch (err) {
      if ((err as { code?: string }).code === "cannot-read") throw AppError.validation((err as Error).message);
      throw err;
    }
    if (!text.trim()) throw AppError.validation("The file has no text to read");
    if (text.length > ATTACHMENT_TEXT_MAX) throw AppError.validation(`At most ${ATTACHMENT_TEXT_MAX} characters of text per file`);
    return asSystem(async () => {
      let conversationId = body.conversationId;
      if (conversationId) {
        await speakersConversation(root, bot, speaker, conversationId);
        const [n] = await root
          .select({ n: sql<number>`count(*)::int` })
          .from(chatDocuments)
          .where(eq(chatDocuments.conversationId, conversationId));
        if (Number(n?.n ?? 0) >= ATTACHMENTS_PER_CONVERSATION) throw AppError.validation(`At most ${ATTACHMENTS_PER_CONVERSATION} files per conversation`);
      } else {
        conversationId = createId();
        await root.insert(chatConversations).values({ id: conversationId, botId: bot.id, userId: speaker.userId ?? null, visitorKey: speaker.visitorKey ?? null });
      }
      const doc = await addDocument(root, ctx.ai?.embed.bind(ctx.ai), { botId: bot.id, conversationId, title: body.title, content: text, createdBy: speaker.userId ?? null });
      return { conversationId, documentId: doc.id, chunkCount: doc.chunkCount, embedded: doc.embedded };
    });
  }

  return app.ops;
}
