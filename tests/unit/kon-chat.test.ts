/**
 * kon-chat: what a bot may do depends on who talks to it
 * ============================================================================
 *
 * The migrations on PGlite as a NON-superuser role; the core's agent engine replaced by a recorder that also
 * plays a run (text in pieces, a tool call, a tool held for approval), so what is tested is what each bot ASKS the
 * core for and what it makes of the answer: no tools for a public bot, only its group for a team bot, the
 * conversation so far, the knowledge and attachments it found, the stream in the AI SDK's protocol, the parts it
 * keeps, what it costs, the limits, and whose conversation is whose.
 */

import type { PGlite } from "@electric-sql/pglite";
import type { KonAgentRun } from "@kitsuden/shared";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { chunkText, createKonChat } from "../../kons/kon-chat";
import { registerChatPolicy } from "../../kons/kon-chat/chat.policy";

import { ACTORS, dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
let noEngine: ReturnType<typeof requestAs>;
const json = (res: Response): Promise<any> => res.json();
const runs: KonAgentRun[] = [];
const VISITOR = "v".repeat(32);
const ORIGIN = { origin: "https://shop.example" };

/** A fake embedding: one dimension per topic word, enough to tell refunds from shipping. */
const TOPICS = ["refund", "shipping", "price", "warranty"];
const embed = async (texts: string[]) => texts.map((t) => TOPICS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0.01)));

/** Plays a run: text in two pieces; with a tool group, a tool call; asked to "approve", a tool held for a person. */
const agents = {
  run: async (options: KonAgentRun) => {
    runs.push(options);
    const emit = options.onEvent ?? (() => {});
    const toolCalls: Array<{ name: string; ok: boolean; pendingApproval?: { proposalId: string } }> = [];
    emit({ type: "step-start" });
    if (options.toolset) {
      emit({ type: "tool-call", id: "call-1", name: "crm__count-deals", input: { groupBy: "stageId" } });
      const held = options.message.includes("approve");
      emit({
        type: "tool-result",
        id: "call-1",
        name: "crm__count-deals",
        ok: !held,
        output: held ? '{"code":"KITSUDEN_E_APPROVAL_REQUIRED"}' : '{"data":[{"key":"s1","count":2}]}',
        ...(held ? { pendingApproval: { proposalId: "prop-9" } } : {}),
      });
      toolCalls.push({ name: "crm__count-deals", ok: !held, ...(held ? { pendingApproval: { proposalId: "prop-9" } } : {}) });
      emit({ type: "step-finish" });
      emit({ type: "step-start" });
    }
    emit({ type: "text-delta", delta: "Answer to: " });
    emit({ type: "text-delta", delta: options.message });
    emit({ type: "step-finish" });
    return { response: `Answer to: ${options.message}`, sessionId: "s", traceId: "t", provider: "fake", model: "fake", tokensIn: 1000, tokensOut: 500, toolCalls };
  },
};

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-chat/migrations");
  client = await migratedBase("kon-chat", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never, agents, ai: { embed } } as never);
  request = requestAs(host.mount(createKonChat(ctx)));
  const bare = createTestKonContext({ db: host.db as never, auth: auth as never } as never);
  noEngine = requestAs(rlsHost(db, auth).mount(createKonChat(bare)));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => registerChatPolicy());

/** The parts of a streamed answer, as `useChat` would read them. */
async function streamed(res: Response): Promise<Array<Record<string, any> | "[DONE]">> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((event) => event.replace(/^data: /, ""))
    .map((line) => (line === "[DONE]" ? "[DONE]" : JSON.parse(line)));
}

let teamBot: { id: string; slug: string };
let publicBot: { id: string; slug: string };

describe("setting bots up", () => {
  it("only an admin creates one, and a public bot cannot have tools or members", async () => {
    const team = { slug: "sales", name: "Sales assistant", agentId: "agent-1", audience: "team", toolset: "kon:crm/assistant", priceInPerMillion: 4, priceOutPerMillion: 20 };
    expect((await request("staff", "POST", "/bots", team)).status).toBe(403);
    expect((await request("admin", "POST", "/bots", { ...team, slug: "web", audience: "public" })).status).toBe(422);
    expect((await request("admin", "POST", "/bots", { slug: "web", name: "W", agentId: "a", audience: "public", members: ["x"] })).status).toBe(422);
    teamBot = (await json(await request("admin", "POST", "/bots", team))).data;
    expect(teamBot).toMatchObject({ priceInPerMillion: "4.0000", priceOutPerMillion: "20.0000" });
    publicBot = (await json(await request("admin", "POST", "/bots", { slug: "help", name: "Help", agentId: "agent-2", audience: "public", greeting: "Hi!", visitorHourlyLimit: 5, allowedOrigins: ["https://shop.example"] }))).data;
    expect((await request("admin", "POST", "/bots", team)).status).toBe(409);
    expect((await request("admin", "PATCH", `/bots/${publicBot.id}`, { toolset: "kon:crm/sales" })).status).toBe(422);
  });

  it("learns documents in chunks, searched by meaning when the core has embeddings", async () => {
    expect(chunkText("a\n\nb")).toEqual(["a\n\nb"]);
    expect(chunkText("x".repeat(2000)).length).toBeGreaterThan(1);
    const doc = await json(await request("admin", "POST", `/bots/${publicBot.id}/knowledge`, { title: "Refunds", content: "A refund is paid within 14 days of the return." }));
    expect(doc.data).toMatchObject({ chunkCount: 1, embedded: true });
    await request("admin", "POST", `/bots/${publicBot.id}/knowledge`, { title: "Shipping", content: "Shipping takes 3 working days." });
    expect((await json(await request("admin", "GET", `/bots/${publicBot.id}/knowledge`))).data).toHaveLength(2);
    expect((await request("staff", "GET", `/bots/${publicBot.id}/knowledge`)).status).toBe(403);
  });
});

describe("a public bot", () => {
  const ask = (body: Record<string, unknown>, headers = ORIGIN) => request("anon", "POST", "/public/bots/help/chat", { visitorId: VISITOR, ...body }, headers);

  it("shows its greeting, and answers from what it knows, with no tools", async () => {
    expect((await json(await request("anon", "GET", "/public/bots/help"))).data).toEqual({ slug: "help", name: "Help", greeting: "Hi!" });
    runs.length = 0;
    const res = await json(await ask({ message: "How long does a refund take?" }));
    expect(res.data).toMatchObject({ reply: "Answer to: How long does a refund take?", sources: ["Refunds"] });
    expect(res.data).not.toHaveProperty("costUsd");
    expect(runs[0]).toMatchObject({ agentId: "agent-2", allowedTools: [] });
    expect(runs[0]!.toolset).toBeUndefined();
    expect(runs[0]!.context).toContain("within 14 days");
    expect(runs[0]!.context).not.toContain("Shipping takes");
  });

  it("streams in the AI SDK's protocol, by titles and without cost", async () => {
    const res = await request("anon", "POST", "/public/bots/help/chat/stream", { visitorId: VISITOR, message: "And shipping?" }, ORIGIN);
    expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const parts = await streamed(res);
    const types = parts.map((p) => (p === "[DONE]" ? p : p.type));
    expect(types).toEqual(["start", "start-step", "text-start", "text-delta", "text-delta", "text-end", "finish-step", "source-document", "data-chat", "finish", "[DONE]"]);
    const text = parts.filter((p): p is Record<string, any> => p !== "[DONE]" && p.type === "text-delta").map((p) => p.delta).join("");
    expect(text).toBe("Answer to: And shipping?");
    const source = parts.find((p) => p !== "[DONE]" && p.type === "source-document") as Record<string, any>;
    expect(source).toMatchObject({ sourceId: "Shipping", title: "Shipping" });
    const chat = (parts.find((p) => p !== "[DONE]" && p.type === "data-chat") as Record<string, any>).data;
    expect(chat).not.toHaveProperty("costUsd");
    expect(chat.conversationId).toBeTruthy();
  });

  it("continues the visitor's own conversation with its history, and nobody else's", async () => {
    const first = (await json(await ask({ message: "Hello" }))).data;
    runs.length = 0;
    await ask({ message: "Thanks", conversationId: first.conversationId });
    expect(runs[0]!.history).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Answer to: Hello" },
    ]);
    const stranger = await request("anon", "POST", "/public/bots/help/chat", { visitorId: "w".repeat(32), message: "hi", conversationId: first.conversationId }, ORIGIN);
    expect(stranger.status).toBe(404);
  });

  it("lets the visitor rate an answer in their own conversation, and nobody else", async () => {
    const answer = (await json(await ask({ message: "Rate me" }))).data;
    const rate = (visitorId: string, rating: number) =>
      request("anon", "POST", `/public/bots/help/messages/${answer.messageId}/feedback`, { visitorId, rating, comment: "too short" }, ORIGIN);
    expect((await rate("w".repeat(32), -1)).status).toBe(404);
    expect((await json(await rate(VISITOR, -1))).data).toMatchObject({ feedback: -1 });
    const bad = (await json(await request("admin", "GET", `/bots/${publicBot.id}/feedback?rating=down`))).data;
    expect(bad[0]).toMatchObject({ question: "Rate me", answer: "Answer to: Rate me", comment: "too short", rating: -1 });
  });

  it("answers only the sites it lists, and stops a visitor past the hourly limit", async () => {
    expect((await ask({ message: "hi" }, { origin: "https://evil.example" })).status).toBe(403);
    // Five questions so far from this visitor: the limit is five.
    expect((await ask({ message: "one more" })).status).toBe(429);
  });

  it("stores a hash of the visitor's key, never the key", async () => {
    const rows = await client.query<{ visitor_key: string }>("SELECT visitor_key FROM chat_conversations WHERE visitor_key IS NOT NULL");
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.rows)).not.toContain(VISITOR);
  });

  it("is not reachable as a team bot, and a team bot is not public", async () => {
    expect((await request("staff", "POST", "/bots/help/chat", { message: "hi" })).status).toBe(404);
    expect((await request("anon", "GET", "/public/bots/sales")).status).toBe(404);
  });
});

describe("a team bot", () => {
  it("is for the team, and asks the core only for its tool group", async () => {
    expect((await request("a", "POST", "/bots/sales/chat", { message: "hi" })).status).toBe(403);
    runs.length = 0;
    const res = await json(await request("staff", "POST", "/bots/sales/chat", { message: "How many open deals?" }));
    expect(res.data.toolCalls).toEqual(["crm__count-deals"]);
    expect(runs[0]).toMatchObject({ agentId: "agent-1", toolset: "kon:crm/assistant" });
    expect(runs[0]!.allowedTools).toBeUndefined();
  });

  it("keeps the answer as parts, and says what it cost at the bot's prices", async () => {
    const res = (await json(await request("staff", "POST", "/bots/sales/chat", { message: "Parts please" }))).data;
    expect(res.parts.map((p: { type: string }) => p.type)).toEqual(["tool", "text"]);
    expect(res.parts[0]).toMatchObject({ name: "crm__count-deals", ok: true, input: { groupBy: "stageId" } });
    // 1,000 tokens in at US$4/M and 500 out at US$20/M.
    expect(res.costUsd).toBeCloseTo(0.014, 6);
    const stored = (await json(await request("staff", "GET", `/conversations/${res.conversationId}`))).data.messages;
    expect(stored[1]).toMatchObject({ role: "assistant", costUsd: "0.014000" });
    expect(stored[1].parts[1]).toEqual({ type: "text", text: "Answer to: Parts please" });
  });

  it("a tool held for a person is a pending approval, in the answer and in the stream", async () => {
    const plain = (await json(await request("staff", "POST", "/bots/sales/chat", { message: "Please approve this" }))).data;
    expect(plain.pendingApprovals).toEqual([{ toolCallId: "call-1", name: "crm__count-deals", proposalId: "prop-9" }]);
    expect(plain.parts.find((p: { type: string }) => p.type === "approval")).toMatchObject({ proposalId: "prop-9" });
    const parts = await streamed(await request("staff", "POST", "/bots/sales/chat/stream", { message: "Stream approve" }));
    expect(parts).toContainEqual({ type: "tool-input-available", toolCallId: "call-1", toolName: "crm__count-deals", input: { groupBy: "stageId" } });
    expect(parts).toContainEqual({ type: "tool-approval-request", toolCallId: "call-1", approvalId: "prop-9" });
    const chat = (parts.find((p) => p !== "[DONE]" && p.type === "data-chat") as Record<string, any>).data;
    expect(chat).toMatchObject({ pendingApprovals: ["prop-9"] });
    expect(typeof chat.costUsd).toBe("number");
  });

  it("answers the last question again, replacing its answer, without counting the question twice", async () => {
    const first = (await json(await request("staff", "POST", "/bots/sales/chat", { message: "Again?" }))).data;
    runs.length = 0;
    const again = (await json(await request("staff", "POST", "/bots/sales/chat", { conversationId: first.conversationId, regenerate: true }))).data;
    expect(runs[0]).toMatchObject({ message: "Again?", history: [] });
    const messages = (await json(await request("staff", "GET", `/conversations/${first.conversationId}`))).data.messages;
    expect(messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1].id).toBe(again.messageId);
  });

  it("branches a conversation at a message, leaving the original as it was", async () => {
    const one = (await json(await request("staff", "POST", "/bots/sales/chat", { message: "First" }))).data;
    await request("staff", "POST", "/bots/sales/chat", { message: "Second", conversationId: one.conversationId });
    const branch = await json(await request("staff", "POST", `/conversations/${one.conversationId}/fork`, { fromMessageId: one.messageId }));
    const copied = (await json(await request("staff", "GET", `/conversations/${branch.data.conversationId}`))).data;
    expect(copied.messages.map((m: { content: string }) => m.content)).toEqual(["First", "Answer to: First"]);
    expect(copied.forkedFrom).toBe(one.conversationId);
    expect(copied.messages[1].costUsd).toBeNull();
    expect((await request("admin", "POST", `/conversations/${one.conversationId}/fork`, { fromMessageId: one.messageId })).status).toBe(404);
  });

  it("searches a conversation's attachments in that conversation only", async () => {
    const attached = (await json(await request("staff", "POST", "/bots/sales/attachments", { title: "Contract", content: "The warranty lasts 24 months." }))).data;
    expect(attached).toMatchObject({ chunkCount: 1, embedded: true });
    runs.length = 0;
    await request("staff", "POST", "/bots/sales/chat", { message: "How long is the warranty?", conversationId: attached.conversationId });
    expect(runs[0]!.context).toContain("(attached) Contract");
    runs.length = 0;
    await request("staff", "POST", "/bots/sales/chat", { message: "How long is the warranty?" });
    expect(runs[0]!.context).toBeUndefined();
    expect((await request("staff", "POST", "/bots/sales/attachments", { title: "Odd", mime: "application/x-odd", content: "AAAA" })).status).toBe(422);
    expect((await json(await request("admin", "GET", `/bots/${teamBot.id}/knowledge`))).data).toEqual([]);
  });

  it("a person reads their own conversation; another editor does not, an admin does", async () => {
    const mine = (await json(await request("staff", "POST", "/bots/sales/chat", { message: "Mine" }))).data;
    expect((await request("staff", "GET", `/conversations/${mine.conversationId}`)).status).toBe(200);
    expect((await request("admin", "GET", `/conversations/${mine.conversationId}`)).status).toBe(200);
    await client.exec("RESET ROLE");
    const owner = await client.query<{ user_id: string }>(`SELECT user_id FROM chat_conversations WHERE id = '${mine.conversationId}'`);
    await dropToAppRole(client);
    expect(owner.rows[0]!.user_id).toBe(ACTORS.staff.id);
  });

  it("only its members may talk to it, when it names any", async () => {
    await request("admin", "PATCH", `/bots/${teamBot.id}`, { members: [ACTORS.admin.id] });
    expect((await request("staff", "POST", "/bots/sales/chat", { message: "hi" })).status).toBe(404);
    expect((await request("admin", "POST", "/bots/sales/chat", { message: "hi" })).status).toBe(200);
    await request("admin", "PATCH", `/bots/${teamBot.id}`, { members: [] });
  });

  it("reports its use and spending per day", async () => {
    const usage = (await json(await request("admin", "GET", `/bots/${teamBot.id}/usage`))).data;
    expect(usage.days[0].questions).toBeGreaterThan(5);
    expect(usage.days[0].costUsd).toBeGreaterThan(0);
    expect(usage.last24h).toMatchObject({ dailyLimit: 500, dailyBudgetUsd: null });
  });

  it("stops at its daily budget, at a person's daily limit, and without an agent engine", async () => {
    await request("admin", "PATCH", `/bots/${teamBot.id}`, { dailyBudgetUsd: 0.01 });
    expect((await request("staff", "POST", "/bots/sales/chat", { message: "over budget" })).status).toBe(429);
    await request("admin", "PATCH", `/bots/${teamBot.id}`, { dailyBudgetUsd: null, userDailyLimit: 1 });
    expect((await request("staff", "POST", "/bots/sales/chat", { message: "too many" })).status).toBe(429);
    const streamedLimit = await streamed(await request("staff", "POST", "/bots/sales/chat/stream", { message: "too many" }));
    expect(streamedLimit).toContainEqual({ type: "error", errorText: "You have asked this assistant all you can today. Try again tomorrow." });
    expect((await noEngine("admin", "POST", "/bots/sales/chat", { message: "hi" })).status).toBe(409);
  });
});

describe("the widget", () => {
  it("streams, rates, and writes server text as text, never as HTML", async () => {
    const res = await request("anon", "GET", "/public/widget.js");
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js).toContain("/chat/stream");
    expect(js).toContain("/feedback");
    expect(js).toContain("textContent");
    expect(js).not.toMatch(/innerHTML\s*=\s*[^`]*\b(body|data|reply|part)\b/);
  });
});
