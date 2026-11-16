/**
 * One turn of a conversation
 * ============================================================================
 *
 * The question finds what the bot knows and what was attached to this conversation (chat.knowledge.ts), goes to
 * the bot's agent through the core with the conversation so far, and both sides are kept as parts: text, the
 * tools it called, the approvals it is waiting for and the sources it used. What the agent may DO depends on who
 * is asking:
 *
 *   - a public bot runs with no tools at all: a visitor talks to its knowledge, never to the data behind it;
 *   - a team bot runs with the tool group it was given (`kon:crm/assistant`), and only within what its agent
 *     identity may already use. Without a group, it has no tools either: tools are opted into, not out of.
 *
 * A tool the core holds for a person's approval is not an error: the answer says so and carries the proposal.
 *
 * Every turn is counted three ways before it runs: the bot's messages today, its spending today against its
 * budget, and the asker's own messages (per day for a person, per hour for a visitor). The cost is the tokens
 * at the prices the admin set for the bot, since only the admin knows what its agent's model costs.
 *
 * The core keeps memory and brain notes off for these runs and does not cache them: one agent serves many
 * people here, and one must never read what another said.
 */

import { AppError, ErrorCode } from "@kitsuden/engine";
import type { KonAgentEvent, KonContext } from "@kitsuden/shared";
import { createId } from "@paralleldrive/cuid2";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";

import { contextOf, search } from "./chat.knowledge";
import { chatBots, chatConversations, chatMessages, type MessagePart } from "./chat.schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the host's Drizzle instance
type Db = any;
export type Bot = typeof chatBots.$inferSelect;
type Conversation = typeof chatConversations.$inferSelect;

/** Earlier turns the model sees: enough to follow a conversation, not a whole day of it. */
const HISTORY_TURNS = 10;
export const MAX_MESSAGE_CHARS = 2000;

export interface Speaker {
  /** A signed-in person (team bots). */
  userId?: string;
  /** The hash of a visitor's browser key (public bots). */
  visitorKey?: string;
}

export interface TurnResult {
  conversationId: string;
  messageId: string;
  reply: string;
  parts: MessagePart[];
  sources: Array<{ documentId: string; title: string }>;
  toolCalls: string[];
  pendingApprovals: Array<{ toolCallId: string; name: string; proposalId: string }>;
  costUsd: number;
}

const limited = (message: string) => new AppError(ErrorCode.RATE_LIMITED, message);

/** Who may talk to a team bot: the team, or only the people it names. */
export function mayUse(bot: Bot, userId: string | undefined): boolean {
  if (!userId) return false;
  return (bot.members ?? []).length === 0 || bot.members.includes(userId);
}

export function costOf(bot: Bot, tokensIn: number, tokensOut: number): number {
  return (tokensIn * Number(bot.priceInPerMillion) + tokensOut * Number(bot.priceOutPerMillion)) / 1_000_000;
}

async function checkLimits(db: Db, bot: Bot, speaker: Speaker): Promise<void> {
  const day = new Date(Date.now() - 86_400_000);
  const [today] = await db
    .select({ asked: sql<number>`count(*) FILTER (WHERE ${chatMessages.role} = 'user')::int`, spent: sql<string>`coalesce(sum(${chatMessages.costUsd}), 0)` })
    .from(chatMessages)
    .where(and(eq(chatMessages.botId, bot.id), gte(chatMessages.createdAt, day)));
  if (Number(today?.asked ?? 0) >= bot.dailyLimit) throw limited("This assistant has answered all it can today. Try again tomorrow.");
  if (bot.dailyBudgetUsd != null && Number(today?.spent ?? 0) >= Number(bot.dailyBudgetUsd)) {
    throw limited("This assistant has used today's budget. Try again tomorrow.");
  }
  const mine = async (since: Date, column: "userId" | "visitorKey", value: string) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(chatMessages)
      .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
      .where(and(eq(chatConversations.botId, bot.id), eq(chatConversations[column], value), eq(chatMessages.role, "user"), gte(chatMessages.createdAt, since)));
    return Number(row?.n ?? 0);
  };
  if (speaker.userId && (await mine(day, "userId", speaker.userId)) >= bot.userDailyLimit) {
    throw limited("You have asked this assistant all you can today. Try again tomorrow.");
  }
  if (speaker.visitorKey && (await mine(new Date(Date.now() - 3_600_000), "visitorKey", speaker.visitorKey)) >= bot.visitorHourlyLimit) {
    throw limited("Too many questions in an hour. Try again later.");
  }
}

/** A conversation of this bot that belongs to this speaker, or 404. */
export async function speakersConversation(db: Db, bot: Bot, speaker: Speaker, conversationId: string): Promise<Conversation> {
  const [found] = await db.select().from(chatConversations).where(and(eq(chatConversations.id, conversationId), eq(chatConversations.botId, bot.id)));
  const theirs = found && ((speaker.userId && found.userId === speaker.userId) || (speaker.visitorKey && found.visitorKey === speaker.visitorKey));
  if (!theirs) throw AppError.notFound("Conversation not found");
  return found;
}

async function newConversation(db: Db, bot: Bot, speaker: Speaker, forkedFrom?: string): Promise<string> {
  const id = createId();
  await db.insert(chatConversations).values({ id, botId: bot.id, userId: speaker.userId ?? null, visitorKey: speaker.visitorKey ?? null, forkedFrom: forkedFrom ?? null });
  return id;
}

export interface TurnInput {
  message?: string;
  conversationId?: string;
  /** Answer the last question again, replacing its last answer. */
  regenerate?: boolean;
  /** The id the answer will have, when the caller announces it before it exists (streaming). */
  messageId?: string;
}

export async function converse(
  ctx: KonContext,
  db: Db,
  bot: Bot,
  speaker: Speaker,
  input: TurnInput,
  onEvent?: (event: KonAgentEvent) => void
): Promise<TurnResult> {
  if (!ctx.agents) throw AppError.conflict("This installation has no agent engine: the assistant cannot answer");
  let message = (input.message ?? "").trim();
  let conversationId: string;

  if (input.regenerate) {
    if (!input.conversationId) throw AppError.validation("`conversationId` says which conversation to answer again");
    conversationId = (await speakersConversation(db, bot, speaker, input.conversationId)).id;
    const [lastQuestion] = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.role, "user")))
      .orderBy(desc(chatMessages.createdAt))
      .limit(1);
    if (!lastQuestion) throw AppError.conflict("There is no question to answer again");
    message = lastQuestion.content;
    await checkLimits(db, bot, speaker);
    // The answers to that question go; the question stays and is not counted twice.
    const dropped = await db
      .delete(chatMessages)
      .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.role, "assistant"), gte(chatMessages.createdAt, lastQuestion.createdAt)))
      .returning({ id: chatMessages.id });
    if (dropped.length) {
      await db.update(chatConversations).set({ messageCount: sql`greatest(${chatConversations.messageCount} - ${dropped.length}, 0)` }).where(eq(chatConversations.id, conversationId));
    }
  } else {
    if (!message) throw AppError.validation("Write a question");
    if (message.length > MAX_MESSAGE_CHARS) throw AppError.validation(`At most ${MAX_MESSAGE_CHARS} characters`);
    await checkLimits(db, bot, speaker);
    conversationId = input.conversationId ? (await speakersConversation(db, bot, speaker, input.conversationId)).id : await newConversation(db, bot, speaker);
  }

  // HISTORY_TURNS question-and-answer pairs. When answering again, the newest message is the
  // question being answered: that is the message itself, not history, so one more is read and
  // dropped. (It used to read one more always, so a normal turn sent 21 messages.)
  const recent: Array<{ role: "user" | "assistant"; content: string }> = (
    await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(HISTORY_TURNS * 2 + (input.regenerate ? 1 : 0))
  ).reverse();
  const earlier = input.regenerate ? recent.slice(0, -1) : recent;
  // The window starts with a question, never with an answer whose question fell out of it.
  while (earlier.length > 0 && earlier[0].role === "assistant") earlier.shift();

  const embed = ctx.ai?.embed.bind(ctx.ai);
  const found = await search(db, embed, bot.id, message, { conversationId });
  const sources = [...new Map(found.map((f) => [f.documentId, { documentId: f.documentId, title: f.title, attachment: f.attachment }])).values()];

  // The parts, in the order they happen; text pieces that arrive together are one part.
  const parts: MessagePart[] = [];
  const pendingApprovals: TurnResult["pendingApprovals"] = [];
  const hear = (event: KonAgentEvent) => {
    if (event.type === "text-delta") {
      const last = parts[parts.length - 1];
      if (last?.type === "text") last.text += event.delta;
      else parts.push({ type: "text", text: event.delta });
    } else if (event.type === "tool-call") {
      parts.push({ type: "tool", id: event.id, name: event.name, input: event.input });
    } else if (event.type === "tool-result") {
      const call = parts.find((p): p is Extract<MessagePart, { type: "tool" }> => p.type === "tool" && p.id === event.id);
      if (call) call.ok = event.ok;
      if (event.pendingApproval) {
        parts.push({ type: "approval", toolCallId: event.id, name: event.name, proposalId: event.pendingApproval.proposalId });
        pendingApprovals.push({ toolCallId: event.id, name: event.name, proposalId: event.pendingApproval.proposalId });
      }
    }
    onEvent?.(event);
  };

  // A public bot never gets tools; a team bot only the group it was given.
  const narrowing = bot.audience === "team" && bot.toolset ? { toolset: bot.toolset } : { allowedTools: [] as string[] };
  const result = await ctx.agents.run({
    agentId: bot.agentId,
    message,
    history: earlier,
    ...(found.length ? { context: contextOf(found) } : {}),
    ...narrowing,
    onEvent: hear,
  });
  // An engine that sends no text events still answered: keep its text as the part.
  if (!parts.some((p) => p.type === "text") && result.response) parts.unshift({ type: "text", text: result.response });
  for (const s of sources) parts.push({ type: "source", documentId: s.documentId, title: s.title, attachment: s.attachment });
  for (const t of result.toolCalls) {
    if (t.pendingApproval && !pendingApprovals.some((p) => p.proposalId === t.pendingApproval!.proposalId)) {
      pendingApprovals.push({ toolCallId: "", name: t.name, proposalId: t.pendingApproval.proposalId });
      parts.push({ type: "approval", toolCallId: "", name: t.name, proposalId: t.pendingApproval.proposalId });
    }
  }

  const costUsd = costOf(bot, result.tokensIn, result.tokensOut);
  const now = new Date();
  const messageId = input.messageId ?? createId();
  const rows = [
    ...(input.regenerate ? [] : [{ id: createId(), conversationId, botId: bot.id, role: "user" as const, content: message, parts: [{ type: "text" as const, text: message }], createdAt: now }]),
    {
      id: messageId,
      conversationId,
      botId: bot.id,
      role: "assistant" as const,
      content: result.response,
      parts,
      sources: sources.map(({ documentId, title }) => ({ documentId, title })),
      toolCalls: result.toolCalls.map((t) => t.name),
      traceId: result.traceId,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: costUsd.toFixed(6),
      createdAt: new Date(now.getTime() + 1),
    },
  ];
  await db.insert(chatMessages).values(rows);
  await db
    .update(chatConversations)
    .set({ messageCount: sql`${chatConversations.messageCount} + ${rows.length}`, lastAt: new Date() })
    .where(eq(chatConversations.id, conversationId));
  return {
    conversationId,
    messageId,
    reply: result.response,
    parts,
    sources: sources.map(({ documentId, title }) => ({ documentId, title })),
    toolCalls: result.toolCalls.map((t) => t.name),
    pendingApprovals,
    costUsd,
  };
}

/**
 * A new conversation with the messages of this one up to `fromMessageId` (included): to try another question
 * from that point without losing the original. Editing a question is a fork before it plus the new question.
 */
export async function fork(db: Db, bot: Bot, speaker: Speaker, conversationId: string, fromMessageId: string): Promise<string> {
  const source = await speakersConversation(db, bot, speaker, conversationId);
  const [from] = await db.select().from(chatMessages).where(and(eq(chatMessages.id, fromMessageId), eq(chatMessages.conversationId, source.id)));
  if (!from) throw AppError.notFound("Message not found in that conversation");
  const copied = await db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, source.id), lte(chatMessages.createdAt, from.createdAt)))
    .orderBy(asc(chatMessages.createdAt));
  const id = await newConversation(db, bot, speaker, source.id);
  if (copied.length) {
    // Copies carry no cost: it was paid once, in the original.
    await db.insert(chatMessages).values(
      copied.map((m: typeof chatMessages.$inferSelect) => ({ ...m, id: createId(), conversationId: id, costUsd: null, feedback: null, feedbackComment: null, feedbackAt: null }))
    );
    await db.update(chatConversations).set({ messageCount: copied.length }).where(eq(chatConversations.id, id));
  }
  return id;
}

/** A conversation's messages, oldest first. */
export async function messagesOf(db: Db, conversationId: string) {
  return db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId)).orderBy(asc(chatMessages.createdAt));
}

/** One rating per answer, from whoever had the conversation; a new one replaces it. */
export async function rate(db: Db, bot: Bot, speaker: Speaker, messageId: string, rating: 1 | -1, comment?: string) {
  const [message] = await db.select().from(chatMessages).where(and(eq(chatMessages.id, messageId), eq(chatMessages.botId, bot.id), eq(chatMessages.role, "assistant")));
  if (!message) throw AppError.notFound("Answer not found");
  await speakersConversation(db, bot, speaker, message.conversationId);
  const [row] = await db
    .update(chatMessages)
    .set({ feedback: rating, feedbackComment: comment ?? null, feedbackAt: new Date() })
    .where(eq(chatMessages.id, message.id))
    .returning({ id: chatMessages.id, feedback: chatMessages.feedback });
  return row;
}
