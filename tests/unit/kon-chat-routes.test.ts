/**
 * kon-chat: the edges of every route — who is turned away, what is refused, what each limit does
 * ============================================================================
 *
 * `kon-chat.test.ts` walks the main story (set a bot up, teach it, a visitor and the team talk to
 * it, stream, approvals, fork, attachments, budget). This file covers what that story skips, on the
 * same bench: the kon's migrations (listed from the folder) on PGlite as a NON-superuser role, the
 * host's per-request RLS transaction (`rlsHost`), and the core's agent engine replaced by a recorder.
 * No LLM and no network: `ctx.agents.run` is a fake that echoes the question.
 *
 *   · access: anonymous, a plain account, an editor, an admin and agent keys on the admin, team and
 *     public routes; a denial beats `admin`;
 *   · validation: a 422 that names every bad field, and a question that is refused never reaches
 *     the engine;
 *   · bot management: slug conflicts, missing rows, a team bot turned public, delete cascades;
 *   · the turn: a team bot without a tool group gets NO tools, inactive bots do not exist, the
 *     bot's daily limit, sites, attachments (cap, size, someone else's conversation), fork and
 *     rating only inside your own conversation, another editor cannot read yours;
 *   · what a visitor gets back carries no parts, tools, approvals or cost.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import type { KonAgentRun } from "@kitsuden/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonChat, kon } from "../../kons/kon-chat";
import { registerChatPolicy } from "../../kons/kon-chat/chat.policy";

import { ACTORS, dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

const KON = "kon-chat";
const migrations = () =>
  readdirSync(resolve(__dirname, `../../kons/${KON}/migrations`))
    .filter((f) => f.endsWith(".sql"))
    .sort();

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const json = async (res: Response): Promise<any> => res.json();
const agentKey = (...scopes: string[]) => ({ agent: scopes });

/** Every run the kon asked the "engine" for. */
const runs: KonAgentRun[] = [];
const agents = {
  run: async (options: KonAgentRun) => {
    runs.push(options);
    options.onEvent?.({ type: "text-delta", delta: `Answer to: ${options.message}` });
    return {
      response: `Answer to: ${options.message}`,
      sessionId: "s",
      traceId: "t",
      provider: "fake",
      model: "fake",
      tokensIn: 100,
      tokensOut: 50,
      toolCalls: [],
    };
  },
};

const VISITOR = "visitor-key-".padEnd(32, "x");
const OTHER_VISITOR = "another-visitor-".padEnd(32, "y");

/** Bots created once, through the API, as the admin. */
const bots: Record<string, { id: string; slug: string }> = {};

async function createBot(body: Record<string, unknown>) {
  const res = await request("admin", "POST", "/bots", body);
  if (res.status !== 201) throw new Error(`could not create ${String(body.slug)}: ${res.status} ${await res.text()}`);
  return (await json(res)).data as { id: string; slug: string };
}

const sys = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await client.query<T>(text, params)).rows;

beforeAll(async () => {
  client = await migratedBase(KON, migrations());
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never, agents } as never);
  request = requestAs(host.mount(createKonChat(ctx)));
  registerChatPolicy();

  bots.ops = await createBot({ slug: "ops", name: "Ops", agentId: "agent-ops", audience: "team" });
  bots.sales = await createBot({ slug: "sales", name: "Sales", agentId: "agent-sales", audience: "team", toolset: "kon:crm/assistant" });
  bots.help = await createBot({ slug: "help", name: "Help", agentId: "agent-help", audience: "public", greeting: "Hi" });
  bots.shop = await createBot({ slug: "shop", name: "Shop", agentId: "agent-shop", audience: "public", allowedOrigins: ["https://shop.example"] });
  bots.offTeam = await createBot({ slug: "off-team", name: "Off", agentId: "a", audience: "team", active: false });
  bots.offPublic = await createBot({ slug: "off-public", name: "Off", agentId: "a", audience: "public", active: false });
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerChatPolicy();
  runs.length = 0;
});

const ask = (actor: Parameters<typeof request>[0], slug: string, body: Record<string, unknown>) =>
  request(actor, "POST", `/bots/${slug}/chat`, body);
const askPublic = (slug: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  request("anon", "POST", `/public/bots/${slug}/chat`, { visitorId: VISITOR, ...body }, headers);

// ════════════════════════════════════════════════════════════════════════════

describe("who reaches what", () => {
  const adminRoutes = (): Array<[string, string, unknown?]> => [
    ["GET", "/bots"],
    ["POST", "/bots", { slug: "nope", name: "N", agentId: "a", audience: "team" }],
    ["PATCH", `/bots/${bots.ops!.id}`, { name: "Renamed" }],
    ["DELETE", `/bots/${bots.ops!.id}`],
    ["GET", `/bots/${bots.ops!.id}/knowledge`],
    ["POST", `/bots/${bots.ops!.id}/knowledge`, { title: "T", content: "C" }],
    ["GET", `/bots/${bots.ops!.id}/conversations`],
    ["GET", `/bots/${bots.ops!.id}/usage`],
    ["GET", `/bots/${bots.ops!.id}/feedback`],
  ];

  it("the admin routes: 401 without a session, 403 for a plain account and for an editor", async () => {
    for (const [method, route, body] of adminRoutes()) {
      expect((await request("anon", method, route, body)).status, `${method} ${route} anon`).toBe(401);
      expect((await request("a", method, route, body)).status, `${method} ${route} user`).toBe(403);
      expect((await request("staff", method, route, body)).status, `${method} ${route} editor`).toBe(403);
    }
    // Nothing moved.
    expect((await sys<{ name: string }>("SELECT name FROM chat_bots WHERE id = $1", [bots.ops!.id]))[0]!.name).toBe("Ops");
    expect(await sys("SELECT 1 FROM chat_bots WHERE slug = 'nope'")).toEqual([]);
  });

  it("the team routes: 401 without a session, 403 for a plain account, and the engine is never called", async () => {
    const teamRoutes: Array<[string, string, unknown]> = [
      ["POST", "/bots/ops/chat", { message: "hi" }],
      ["POST", "/bots/ops/chat/stream", { message: "hi" }],
      ["POST", "/bots/ops/attachments", { title: "T", content: "C" }],
      ["POST", "/conversations/whatever/fork", { fromMessageId: "m" }],
      ["POST", "/messages/whatever/feedback", { rating: 1 }],
      ["GET", "/conversations/whatever", undefined],
    ];
    for (const [method, route, body] of teamRoutes) {
      expect((await request("anon", method, route, body)).status, `${route} anon`).toBe(401);
      expect((await request("a", method, route, body)).status, `${route} user`).toBe(403);
    }
    expect(runs).toEqual([]);
  });

  it("an agent key with no chat scope is refused; agents do not chat with team bots without a scope", async () => {
    const key = agentKey("mcp:connect");
    expect((await request(key, "GET", "/bots")).status).toBe(403);
    expect((await request(key, "POST", "/bots", { slug: "agent-bot", name: "A", agentId: "a", audience: "team" })).status).toBe(403);
    expect((await ask(key, "ops", { message: "hi" })).status).toBe(403);
    expect(runs).toEqual([]);
  });

  it("a denial beats an `admin` key", async () => {
    const key = agentKey("admin", "!kon:chat:delete-chatbot", "!chat:create-chatbot");
    expect((await request(key, "DELETE", `/bots/${bots.ops!.id}`)).status).toBe(403);
    expect((await request(key, "POST", "/bots", { slug: "denied", name: "D", agentId: "a", audience: "team" })).status).toBe(403);
    expect(await sys("SELECT 1 FROM chat_bots WHERE id = $1", [bots.ops!.id])).toHaveLength(1);
  });

  // Fixed (found by this test): the HTTP policy lets an agent with the kon's scope (`chat:*`)
  // configure bots, and `list-chatbots` / `create-chatbot` are MCP tools, but the RLS of
  // `chat_bots` only knows the HUMAN roles (`admin`, `editor`) and never calls the core's
  // `kitsuden_effective_admin('chat')`. So such an agent sees an EMPTY list, and creating a bot
  // breaks on the row-level security check. The same class of bug the core fixed for dms, members,
  // booking and directory (tests/unit/effective-agents-in-kons.test.ts).
  it("an agent with `chat:*` sees the bots it may configure", async () => {
    const res = await request(agentKey("chat:*"), "GET", "/bots");
    expect(res.status).toBe(200);
    expect((await json(res)).data.length).toBeGreaterThan(0);
  });

  it("an agent with `chat:*` can create a bot it is allowed to create", async () => {
    const res = await request(agentKey("chat:*"), "POST", "/bots", { slug: "by-agent", name: "A", agentId: "a", audience: "team" });
    expect(res.status).toBe(201);
  });

  // Fixed (0002_fine_scopes_in_rls): a fine scope (`kon:chat:<operation>`) or the policy scope
  // `chat:configure` passed the HTTP check, but the row security admitted an agent only when its
  // key opened the whole kon, so the list came back empty and a write failed.
  it("a fine scope reaches the rows of its own operation: list, create, teach", async () => {
    const list = await request(agentKey("kon:chat:list-chatbots"), "GET", "/bots");
    expect(list.status).toBe(200);
    expect((await json(list)).data.length).toBeGreaterThan(0);

    const created = await request(agentKey("kon:chat:create-chatbot"), "POST", "/bots", { slug: "by-fine-scope", name: "F", agentId: "a", audience: "team" });
    expect(created.status).toBe(201);
    expect(await sys("SELECT 1 FROM chat_bots WHERE slug = 'by-fine-scope'")).toHaveLength(1);

    const taught = await request(agentKey("kon:chat:add-chatbot-knowledge"), "POST", `/bots/${bots.ops!.id}/knowledge`, { title: "Fine", content: "Taught with a fine scope." });
    expect(taught.status).toBe(201);
    const knowledge = await request(agentKey("kon:chat:list-chatbot-knowledge"), "GET", `/bots/${bots.ops!.id}/knowledge`);
    expect((await json(knowledge)).data.map((d: { title: string }) => d.title)).toContain("Fine");
  });

  it("`chat:configure` reaches every admin table; a fine scope does not reach another operation's rows", async () => {
    const res = await request(agentKey("chat:configure"), "GET", "/bots");
    expect((await json(res)).data.length).toBeGreaterThan(0);
    // `list-chatbots` reads bots, not what they were taught: the other operation stays closed.
    expect((await request(agentKey("kon:chat:list-chatbots"), "GET", `/bots/${bots.ops!.id}/knowledge`)).status).toBe(403);
    // A denial of the kon beats the fine scope, also in the rows.
    expect((await request(agentKey("kon:chat:list-chatbots", "!chat:*"), "GET", "/bots")).status).toBe(403);
  });

  it("the public routes need no session, and the kon declares its own per-connection limit for them", async () => {
    expect((await request("anon", "GET", "/public/bots/help")).status).toBe(200);
    expect((await request("anon", "GET", "/public/widget.js")).status).toBe(200);
    const rule = kon.rateLimits?.find((r) => r.path.startsWith("/public/bots"));
    expect(rule).toBeDefined();
    expect(rule!.limit).toBeLessThanOrEqual(60);
  });
});

describe("what is refused", () => {
  const fieldsOf = async (res: Response): Promise<string[]> => {
    const body = await json(res);
    const details = body?.error?.details ?? body?.details ?? {};
    return Object.keys(details.fields ?? details).sort();
  };

  it("a bot with several bad fields is one 422 that names them all", async () => {
    const res = await request("admin", "POST", "/bots", {
      slug: "Bad Slug!",
      name: "   ",
      agentId: "",
      audience: "everyone",
      dailyLimit: 0,
      allowedOrigins: ["not a url"],
      dailyBudgetUsd: -1,
    });
    expect(res.status).toBe(422);
    expect(await fieldsOf(res)).toEqual(["agentId", "allowedOrigins.0", "audience", "dailyBudgetUsd", "dailyLimit", "name", "slug"]);
  });

  it.each([
    ["one character", "a"],
    ["a leading dash", "-help"],
    ["capitals", "Help"],
    ["sixty-one characters", "a".repeat(61)],
  ])("a slug with %s is refused", async (_label, slug) => {
    expect((await request("admin", "POST", "/bots", { slug, name: "N", agentId: "a", audience: "team" })).status).toBe(422);
  });

  it("an unknown field is refused, not silently dropped", async () => {
    const res = await request("admin", "POST", "/bots", { slug: "tools", name: "N", agentId: "a", audience: "team", tools: ["x"] });
    expect(res.status).toBe(422);
    expect(await sys("SELECT 1 FROM chat_bots WHERE slug = 'tools'")).toEqual([]);
  });

  it.each([
    ["an empty question", { message: "" }],
    ["a question of only spaces", { message: "   \n " }],
    ["no question at all", {}],
    ["a question over 2,000 characters", { message: "x".repeat(2001) }],
    ["regenerate without a conversation", { regenerate: true }],
    ["an unknown field", { message: "hi", model: "gpt-x" }],
  ])("%s is a 422, and the engine is never called", async (_label, body) => {
    expect((await ask("staff", "ops", body)).status).toBe(422);
    expect(runs).toEqual([]);
  });

  it("a visitor key shorter than 20 characters is refused", async () => {
    expect((await request("anon", "POST", "/public/bots/help/chat", { visitorId: "short", message: "hi" })).status).toBe(422);
    expect(runs).toEqual([]);
  });

  it.each([[0], [2], ["1"]])("a rating of %j is refused", async (rating) => {
    expect((await request("staff", "POST", "/messages/any/feedback", { rating })).status).toBe(422);
  });
});

describe("managing bots", () => {
  it("renaming to a slug that is taken is a 409; to its own slug is fine", async () => {
    expect((await request("admin", "PATCH", `/bots/${bots.ops!.id}`, { slug: "sales" })).status).toBe(409);
    expect((await request("admin", "PATCH", `/bots/${bots.ops!.id}`, { slug: "ops", name: "Ops" })).status).toBe(200);
  });

  it("a bot that does not exist is a 404 to change, delete, teach or measure", async () => {
    expect((await request("admin", "PATCH", "/bots/ghost", { name: "X" })).status).toBe(404);
    expect((await request("admin", "DELETE", "/bots/ghost")).status).toBe(404);
    expect((await request("admin", "POST", "/bots/ghost/knowledge", { title: "T", content: "C" })).status).toBe(404);
    expect((await request("admin", "GET", "/bots/ghost/usage")).status).toBe(404);
    expect((await request("admin", "DELETE", "/knowledge/ghost")).status).toBe(404);
  });

  it("a team bot with tools cannot just become public: its tools must go first", async () => {
    expect((await request("admin", "PATCH", `/bots/${bots.sales!.id}`, { audience: "public" })).status).toBe(422);
    const temp = await createBot({ slug: "temp-team", name: "T", agentId: "a", audience: "team", members: [ACTORS.staff.id] });
    expect((await request("admin", "PATCH", `/bots/${temp.id}`, { audience: "public" })).status).toBe(422);
    const ok = await request("admin", "PATCH", `/bots/${temp.id}`, { audience: "public", members: [], toolset: null });
    expect(ok.status).toBe(200);
    expect((await json(ok)).data).toMatchObject({ audience: "public", toolset: null, members: [] });
  });

  it("deleting a bot takes its knowledge, conversations and messages with it", async () => {
    const temp = await createBot({ slug: "temp-delete", name: "T", agentId: "a", audience: "team" });
    await request("admin", "POST", `/bots/${temp.id}/knowledge`, { title: "Doc", content: "Some text." });
    expect((await ask("staff", "temp-delete", { message: "hello" })).status).toBe(200);
    expect((await request("admin", "DELETE", `/bots/${temp.id}`)).status).toBe(200);
    for (const table of ["chat_documents", "chat_chunks", "chat_conversations", "chat_messages"]) {
      expect(await sys(`SELECT 1 FROM ${table} WHERE bot_id = $1`, [temp.id]), table).toEqual([]);
    }
  });

  it("forgetting a document removes its chunks", async () => {
    const doc = (await json(await request("admin", "POST", `/bots/${bots.ops!.id}/knowledge`, { title: "Forget me", content: "Temporary." }))).data;
    expect(await sys("SELECT 1 FROM chat_chunks WHERE document_id = $1", [doc.id])).toHaveLength(1);
    expect((await request("admin", "DELETE", `/knowledge/${doc.id}`)).status).toBe(200);
    expect(await sys("SELECT 1 FROM chat_chunks WHERE document_id = $1", [doc.id])).toEqual([]);
  });
});

describe("a turn", () => {
  it("a team bot with no tool group gets no tools at all: tools are opted into", async () => {
    expect((await ask("staff", "ops", { message: "What can you do?" })).status).toBe(200);
    expect(runs[0]).toMatchObject({ agentId: "agent-ops", allowedTools: [] });
    expect(runs[0]!.toolset).toBeUndefined();
  });

  it("an inactive bot does not exist, for the team or for visitors", async () => {
    expect((await ask("admin", "off-team", { message: "hi" })).status).toBe(404);
    expect((await request("anon", "GET", "/public/bots/off-public")).status).toBe(404);
    expect((await askPublic("off-public", { message: "hi" })).status).toBe(404);
    expect((await ask("staff", "missing-bot", { message: "hi" })).status).toBe(404);
    expect(runs).toEqual([]);
  });

  it("a public bot that lists sites refuses a request with no Origin; one that lists none answers anyone", async () => {
    expect((await askPublic("shop", { message: "hi" })).status).toBe(403);
    expect((await askPublic("shop", { message: "hi" }, { origin: "https://shop.example.evil.com" })).status).toBe(403);
    expect((await askPublic("shop", { message: "hi" }, { origin: "https://shop.example" })).status).toBe(200);
    expect((await askPublic("help", { message: "hi" }, { origin: "https://anywhere.example" })).status).toBe(200);
  });

  it("a visitor gets the reply and source titles, never parts, tools, approvals, cost or internal ids", async () => {
    const data = (await json(await askPublic("help", { message: "Hello there" }))).data;
    expect(Object.keys(data).sort()).toEqual(["conversationId", "messageId", "reply", "sources"]);
    expect(data.reply).toBe("Answer to: Hello there");
  });

  it("the bot's daily limit stops everyone, and a refused turn is not counted or sent to the engine", async () => {
    const temp = await createBot({ slug: "temp-limit", name: "T", agentId: "a", audience: "team", dailyLimit: 2 });
    expect((await ask("staff", "temp-limit", { message: "one" })).status).toBe(200);
    expect((await ask("admin", "temp-limit", { message: "two" })).status).toBe(200);
    runs.length = 0;
    const third = await ask("revisor", "temp-limit", { message: "three" });
    expect(third.status).toBe(429);
    expect(runs).toEqual([]);
    expect(await sys("SELECT 1 FROM chat_messages WHERE bot_id = $1 AND role = 'user'", [temp.id])).toHaveLength(2);
  });

  it("regenerating someone else's conversation is a 404", async () => {
    const mine = (await json(await ask("staff", "ops", { message: "Mine" }))).data;
    runs.length = 0;
    expect((await ask("revisor", "ops", { conversationId: mine.conversationId, regenerate: true })).status).toBe(404);
    expect((await ask("revisor", "ops", { conversationId: mine.conversationId, message: "Hijack" })).status).toBe(404);
    expect(runs).toEqual([]);
  });

  it("a conversation of one bot cannot be continued through another", async () => {
    const onOps = (await json(await ask("staff", "ops", { message: "On ops" }))).data;
    expect((await ask("staff", "sales", { conversationId: onOps.conversationId, message: "Moved" })).status).toBe(404);
  });

  it("another editor cannot read your conversation; you and an admin can", async () => {
    const mine = (await json(await ask("staff", "ops", { message: "Private question" }))).data;
    expect((await request("staff", "GET", `/conversations/${mine.conversationId}`)).status).toBe(200);
    expect((await request("admin", "GET", `/conversations/${mine.conversationId}`)).status).toBe(200);
    const other = await request("revisor", "GET", `/conversations/${mine.conversationId}`);
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain("Private question");
  });

  // Fixed (found by this test): `HISTORY_TURNS = 10` means ten earlier turns, twenty messages, but
  // the query takes `HISTORY_TURNS * 2 + 1` rows and only drops the extra one when regenerating. A
  // normal turn therefore sends 21 messages, and the oldest is an ASSISTANT message with no question
  // before it (some model providers reject a history that does not start with the user).
  it("a long conversation sends the last ten turns, starting with a question", async () => {
    let conversationId: string | undefined;
    for (let i = 1; i <= 11; i++) {
      const res = (await json(await ask("staff", "ops", { message: `Turn ${i}`, ...(conversationId ? { conversationId } : {}) }))).data;
      conversationId = res.conversationId;
    }
    runs.length = 0;
    await ask("staff", "ops", { message: "Turn 12", conversationId });
    const history = runs[0]!.history ?? [];
    expect(history).toHaveLength(20);
    expect(history[0]).toEqual({ role: "user", content: "Turn 2" });
  });
});

describe("attachments", () => {
  it("at most five per conversation", async () => {
    const first = (await json(await request("staff", "POST", "/bots/ops/attachments", { title: "F1", content: "File one." }))).data;
    for (let i = 2; i <= 5; i++) {
      expect((await request("staff", "POST", "/bots/ops/attachments", { conversationId: first.conversationId, title: `F${i}`, content: `File ${i}.` })).status).toBe(201);
    }
    const sixth = await request("staff", "POST", "/bots/ops/attachments", { conversationId: first.conversationId, title: "F6", content: "File six." });
    expect(sixth.status).toBe(422);
    expect(await sys("SELECT 1 FROM chat_documents WHERE conversation_id = $1", [first.conversationId])).toHaveLength(5);
  });

  it("a file with no text, or with more than 200,000 characters of it, is refused and stores nothing", async () => {
    const before = (await sys<{ n: number }>("SELECT count(*)::int AS n FROM chat_documents"))[0]!.n;
    expect((await request("staff", "POST", "/bots/ops/attachments", { title: "Blank", content: "   \n\t " })).status).toBe(422);
    expect((await request("staff", "POST", "/bots/ops/attachments", { title: "Huge", content: "word ".repeat(40_001) })).status).toBe(422);
    expect((await sys<{ n: number }>("SELECT count(*)::int AS n FROM chat_documents"))[0]!.n).toBe(before);
  });

  it("nobody attaches to someone else's conversation, editor or visitor", async () => {
    const mine = (await json(await ask("staff", "ops", { message: "Hold my files" }))).data;
    expect((await request("revisor", "POST", "/bots/ops/attachments", { conversationId: mine.conversationId, title: "X", content: "Y" })).status).toBe(404);
    const visitors = (await json(await askPublic("help", { message: "Visitor chat" }))).data;
    const stranger = await request("anon", "POST", "/public/bots/help/attachments", {
      visitorId: OTHER_VISITOR,
      conversationId: visitors.conversationId,
      title: "X",
      content: "Y",
    });
    expect(stranger.status).toBe(404);
    expect(await sys("SELECT 1 FROM chat_documents WHERE conversation_id IN ($1, $2)", [mine.conversationId, visitors.conversationId])).toEqual([]);
  });
});

describe("fork and rating stay inside your own conversation", () => {
  it("forking at a message of another conversation is a 404", async () => {
    const one = (await json(await ask("staff", "ops", { message: "One" }))).data;
    const two = (await json(await ask("staff", "ops", { message: "Two" }))).data;
    expect((await request("staff", "POST", `/conversations/${one.conversationId}/fork`, { fromMessageId: two.messageId })).status).toBe(404);
    expect((await request("revisor", "POST", `/conversations/${one.conversationId}/fork`, { fromMessageId: one.messageId })).status).toBe(404);
  });

  it("a visitor forks only their own conversation", async () => {
    const chat = (await json(await askPublic("help", { message: "Fork me" }))).data;
    const fork = (visitorId: string) =>
      request("anon", "POST", `/public/bots/help/conversations/${chat.conversationId}/fork`, { visitorId, fromMessageId: chat.messageId });
    expect((await fork(OTHER_VISITOR)).status).toBe(404);
    const ok = await fork(VISITOR);
    expect(ok.status).toBe(201);
    expect((await json(ok)).data.conversationId).not.toBe(chat.conversationId);
  });

  it("only an answer can be rated, only by whoever asked, and a new rating replaces the old one", async () => {
    const answer = (await json(await ask("staff", "ops", { message: "Rate this" }))).data;
    const [question] = await sys<{ id: string }>("SELECT id FROM chat_messages WHERE conversation_id = $1 AND role = 'user'", [answer.conversationId]);
    expect((await request("staff", "POST", `/messages/${question!.id}/feedback`, { rating: 1 })).status).toBe(404);
    expect((await request("revisor", "POST", `/messages/${answer.messageId}/feedback`, { rating: -1 })).status).toBe(404);
    expect((await json(await request("staff", "POST", `/messages/${answer.messageId}/feedback`, { rating: -1, comment: "meh" }))).data).toMatchObject({ feedback: -1 });
    expect((await json(await request("staff", "POST", `/messages/${answer.messageId}/feedback`, { rating: 1 }))).data).toMatchObject({ feedback: 1 });
    const [row] = await sys<{ feedback: number; feedback_comment: string | null }>("SELECT feedback, feedback_comment FROM chat_messages WHERE id = $1", [answer.messageId]);
    expect(row).toEqual({ feedback: 1, feedback_comment: null });
  });

  it("a visitor cannot rate an answer through a different public bot", async () => {
    const answer = (await json(await askPublic("help", { message: "Cross-bot" }))).data;
    const res = await request("anon", "POST", `/public/bots/shop/messages/${answer.messageId}/feedback`, { visitorId: VISITOR, rating: 1 }, { origin: "https://shop.example" });
    expect(res.status).toBe(404);
  });
});
