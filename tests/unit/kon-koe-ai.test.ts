/**
 * kon-koe: the AI bot through kon-chat, the store context and the copilot
 * ============================================================================
 *
 * koe and kon-chat on ONE database, as a host with both kons has it: koe's bench (PGlite as a non-superuser
 * with row security, the queue drained through the real handlers, Meta's Graph API recorded) plus kon-chat's
 * migrations and its `chat-channel-turns` handler on the same queue. The core's agent engine is a recorder
 * that answers from a script, so what is tested is what each side asks for and does with the answer:
 *
 *   - a message in the `bot` state goes to kon-chat and its reply goes out through Graph, as `ai`;
 *   - `HANDOFF: <summary>` queues the conversation with the summary;
 *   - a person taking the conversation before the reply arrives turns it into a note, and nothing is sent;
 *   - failures count and hand off at the channel's limit; without kon-chat a person gets it at once;
 *   - the store context carries open payment promises and kon-ecommerce orders, and survives missing kons;
 *   - repeated jobs (at least once) neither run the model nor send twice;
 *   - the copilot drafts, summarizes and translates for koe members only.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { KonAgentRun } from "@kitsuden/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerChatQueues } from "../../kons/kon-chat";

import { APP_SECRET, koeBench, waBody, waText } from "./helpers/koe-bench";
import { ACTORS, APP_ROLE } from "./helpers/safe-kons-bench";

const runs: KonAgentRun[] = [];
/** What the fake model answers; an Error makes the run throw. */
let script: (o: KonAgentRun) => string | Error = (o) => `Reply to: ${o.message}`;

const fakeAgents = {
  run: async (options: KonAgentRun) => {
    runs.push(options);
    const answer = script(options);
    if (answer instanceof Error) throw answer;
    return { response: answer, sessionId: "s", traceId: "trace-1", provider: "fake", model: "fake", tokensIn: 1000, tokensOut: 500, toolCalls: [] };
  },
};

describe("koe's AI bot through kon-chat", () => {
  let k: Awaited<ReturnType<typeof koeBench>>;
  const json = async (res: Response): Promise<any> => res.json();
  let channelId: string;

  /**
   * A WhatsApp message from `from`, processed to the end; returns the conversation. Meta's timestamps are in
   * seconds: one from the future is stored as the moment it arrives, so the thread keeps the order it had.
   */
  async function inbound(from: string, id: string, text: string, name = "Cliente") {
    const ts = Math.floor(Date.now() / 1000) + 60;
    expect((await k.webhook(waBody("PN1", { contacts: [{ wa_id: from, profile: { name } }], messages: [waText(from, id, text, ts)] }))).status).toBe(200);
    await k.drain();
    return conversationOf(from);
  }
  async function conversationOf(from: string) {
    const [conv] = await k.rows<any>(
      "SELECT c.* FROM koe_conversations c JOIN koe_identities i ON i.id = c.identity_id WHERE i.external_id = $1",
      [from]
    );
    return conv;
  }
  const sentTexts = () => k.graphCalls.filter((c) => c.url.endsWith("/PN1/messages")).map((c) => (c.body as any)?.text?.body);
  const notesOf = async (conversationId: string) => (await k.rows<any>("SELECT author_kind, body FROM koe_notes WHERE conversation_id = $1 ORDER BY created_at", [conversationId])).map((n) => n);

  beforeAll(async () => {
    k = await koeBench({ agents: fakeAgents });
    // kon-chat's tables on the same database, as the host's migration runner would leave them, and a minimal
    // kon-ecommerce order table (the columns the store context reads).
    await k.client.exec("RESET ROLE");
    const chatDir = resolve(__dirname, "../../kons/kon-chat/migrations");
    for (const f of readdirSync(chatDir).filter((f) => f.endsWith(".sql")).sort()) await k.client.exec(readFileSync(resolve(chatDir, f), "utf8"));
    await k.client.exec(`
      CREATE TABLE shop_orders (
        id text PRIMARY KEY, number text NOT NULL, status text NOT NULL, customer_email text NOT NULL,
        total_cents integer NOT NULL, currency text NOT NULL, shipping_address jsonb, tracking_number text,
        placed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
      );
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
      SET ROLE ${APP_ROLE};
    `);
    registerChatQueues(k.ctx);

    await k.rows(
      `INSERT INTO chat_bots (id, slug, name, agent_id, audience, price_in_per_million, price_out_per_million)
       VALUES ('bot-shop', 'tienda', 'Tienda', 'agent-shop', 'channel', 4, 20)`
    );
    await k.rows(`INSERT INTO chat_documents (id, bot_id, title, content, chunk_count) VALUES ('doc-1', 'bot-shop', 'Shipping policy', 'Envíos a todo el país en 48 horas.', 1)`);
    await k.rows(`INSERT INTO chat_chunks (id, document_id, bot_id, ordinal, text) VALUES ('chunk-1', 'doc-1', 'bot-shop', 0, 'Envíos a todo el país en 48 horas.')`);

    const member = await k.request("admin", "PUT", `/members/${ACTORS.member.id}`, { role: "supervisor", displayName: ACTORS.member.name });
    expect(member.status, await member.clone().text()).toBe(200);
    const res = await k.request("admin", "POST", "/channels", {
      kind: "whatsapp",
      name: "Tienda WA",
      externalId: "PN1",
      accountId: "waba-1",
      accessToken: "EAAG-test-token-123",
      appSecret: APP_SECRET,
      botSlug: "tienda",
    });
    expect(res.status, await res.clone().text()).toBe(201);
    channelId = (await json(res)).data.id;
  });

  afterAll(async () => {
    await k?.close();
  });

  it("answers in the bot state: kon-chat runs the bot, the reply goes out through Graph as `ai`", async () => {
    const conv = await inbound("51900001", "wamid.a1", "¿Hacen envíos a todo el país?", "Lucía");
    const run = runs.at(-1)!;
    expect(run).toMatchObject({ agentId: "agent-shop", message: "¿Hacen envíos a todo el país?", allowedTools: [], history: [] });
    expect(run.toolset).toBeUndefined();
    expect(run.context).toContain("HANDOFF:");
    expect(run.context).toContain("Shipping policy");
    expect(run.context).toMatch(/Reference data about this customer[\s\S]*Name: Lucía/);

    expect(sentTexts()).toContain("Reply to: ¿Hacen envíos a todo el país?");
    const [out] = await k.rows<any>("SELECT author_kind, author_id, status, idempotency_key FROM koe_messages WHERE conversation_id = $1 AND direction = 'out'", [conv.id]);
    expect(out).toMatchObject({ author_kind: "ai", author_id: "tienda", status: "sent" });
    expect(out.idempotency_key).toMatch(/^bot:/);
    expect(conv.state).toBe("bot");

    // Sources reach the team, never the customer.
    expect((await notesOf(conv.id)).map((n) => n.body)).toContain("Answered from: Shipping policy");
    expect(sentTexts().join(" ")).not.toContain("Shipping policy");

    // kon-chat recorded the cost and kept no conversation of its own.
    const [turn] = await k.rows<any>("SELECT status, tokens_in, tokens_out, cost_usd, ref_conversation_id FROM chat_channel_turns WHERE ref_conversation_id = $1", [conv.id]);
    expect(turn).toMatchObject({ status: "answered", tokens_in: 1000, tokens_out: 500, ref_conversation_id: conv.id });
    expect(Number(turn.cost_usd)).toBeCloseTo(0.014, 6);
    expect(await k.rows("SELECT 1 FROM chat_conversations")).toHaveLength(0);
  });

  it("a repeated job (at least once) neither runs the model again nor sends twice", async () => {
    const conv = await conversationOf("51900001");
    const [msg] = await k.rows<any>("SELECT id FROM koe_messages WHERE conversation_id = $1 AND direction = 'in'", [conv.id]);
    const before = { runs: runs.length, sent: sentTexts().length };
    const ref = { conversationId: conv.id, messageId: msg.id };
    k.jobs.push({ queue: "koe-bot", name: "turn", payload: ref, attempts: 3 });
    k.jobs.push({ queue: "koe-bot-replies", name: "reply", payload: { ref, reply: "Otra respuesta", sources: [], handoff: false, costUsd: 0, tokensIn: 0, tokensOut: 0 }, attempts: 3 });
    await k.drain();
    expect(runs.length).toBe(before.runs);
    expect(sentTexts().length).toBe(before.sent);
    expect(await k.rows("SELECT 1 FROM koe_messages WHERE conversation_id = $1 AND direction = 'out'", [conv.id])).toHaveLength(1);
  });

  it("a second message carries the first exchange as history", async () => {
    await inbound("51900001", "wamid.a2", "¿Y cuánto cuesta?");
    expect(runs.at(-1)!.history).toEqual([
      { role: "user", content: "¿Hacen envíos a todo el país?" },
      { role: "assistant", content: "Reply to: ¿Hacen envíos a todo el país?" },
    ]);
    expect(runs.at(-1)!.message).toBe("¿Y cuánto cuesta?");
  });

  it("HANDOFF: queues the conversation with the summary for whoever takes it", async () => {
    script = (o) => (o.message.includes("reembolso") ? "HANDOFF: Quiere un reembolso del pedido 1001" : `Reply to: ${o.message}`);
    const sentBefore = sentTexts().length;
    const conv = await inbound("51900002", "wamid.b1", "Quiero un reembolso, pásame con alguien");
    script = (o) => `Reply to: ${o.message}`;
    expect(conv.state).toBe("queued");
    expect(conv.metadata.handoffSummary).toBe("Quiere un reembolso del pedido 1001");
    expect(await notesOf(conv.id)).toContainEqual({ author_kind: "ai", body: "Handoff: Quiere un reembolso del pedido 1001" });
    expect(sentTexts().length).toBe(sentBefore);
    expect(k.events.some((e) => e.name === "koe:handoff.requested" && e.data.conversationId === conv.id)).toBe(true);
    expect((await k.rows<any>("SELECT status FROM chat_channel_turns WHERE ref_conversation_id = $1", [conv.id]))[0].status).toBe("handoff");
  });

  it("a person who takes the conversation before the reply arrives gets it as a note; nothing is sent", async () => {
    expect((await k.webhook(waBody("PN1", { contacts: [{ wa_id: "51900003", profile: { name: "Beto" } }], messages: [waText("51900003", "wamid.c1", "Hola, ¿tienen talla M?")] }))).status).toBe(200);
    // The webhook and the bot turn run; kon-chat's turn is still waiting in the queue.
    expect(await k.drain(2)).toEqual([
      { queue: "koe-inbound", name: "webhook" },
      { queue: "koe-bot", name: "turn" },
    ]);
    expect(k.jobs.map((j) => j.queue)).toContain("chat-channel-turns");
    const conv = await conversationOf("51900003");
    const take = await k.request("member", "POST", `/conversations/${conv.id}/take`, {});
    expect(take.status, await take.clone().text()).toBe(200);
    const sentBefore = sentTexts().length;
    await k.drain();
    expect(sentTexts().length).toBe(sentBefore);
    expect(await k.rows("SELECT 1 FROM koe_messages WHERE conversation_id = $1 AND direction = 'out'", [conv.id])).toHaveLength(0);
    const notes = await notesOf(conv.id);
    expect(notes.some((n) => n.author_kind === "ai" && n.body.includes("not sent") && n.body.includes("Reply to: Hola, ¿tienen talla M?"))).toBe(true);
    expect((await conversationOf("51900003")).state).toBe("human");
  });

  it("failures count, and at the channel's limit (default 3) a person takes over", async () => {
    script = () => new Error("the model is down");
    try {
      let conv = await inbound("51900004", "wamid.d1", "Hola");
      expect(conv).toMatchObject({ state: "bot", bot_failures: 1 });
      conv = await inbound("51900004", "wamid.d2", "¿Hola?");
      expect(conv).toMatchObject({ state: "bot", bot_failures: 2 });
      conv = await inbound("51900004", "wamid.d3", "¿Alguien?");
      expect(conv).toMatchObject({ state: "queued", bot_failures: 3 });
      expect((await notesOf(conv.id)).some((n) => n.body.includes("could not answer"))).toBe(true);
      expect((await k.rows<any>("SELECT count(*)::int AS n FROM chat_channel_turns WHERE ref_conversation_id = $1 AND status = 'failed'", [conv.id]))[0].n).toBe(3);
    } finally {
      script = (o) => `Reply to: ${o.message}`;
    }
  });

  it("a bot that cannot answer at all (inactive) hands off at once", async () => {
    await k.rows("UPDATE chat_bots SET active = false WHERE id = 'bot-shop'");
    try {
      const before = runs.length;
      const conv = await inbound("51900005", "wamid.e1", "Hola");
      expect(conv.state).toBe("queued");
      expect(runs.length).toBe(before);
    } finally {
      await k.rows("UPDATE chat_bots SET active = true WHERE id = 'bot-shop'");
    }
  });

  it("without kon-chat installed the conversation goes to a person immediately", async () => {
    const db = k.ctx.db as { tableExists: (t: string) => Promise<boolean> };
    const real = db.tableExists;
    db.tableExists = async (t: string) => t !== "chat_bots";
    try {
      const before = runs.length;
      const conv = await inbound("51900006", "wamid.f1", "Hola");
      expect(conv.state).toBe("queued");
      expect(runs.length).toBe(before);
      expect(k.jobs).toHaveLength(0);
      const [event] = await k.rows<any>("SELECT reason, actor_kind FROM koe_conversation_events WHERE conversation_id = $1 AND type = 'state' ORDER BY created_at DESC LIMIT 1", [conv.id]);
      expect(event).toEqual({ reason: "no bot", actor_kind: "system" });
    } finally {
      db.tableExists = real;
    }
  });

  it("the store context carries open payment promises and kon-ecommerce orders, and skips kons that are not there", async () => {
    await k.rows("INSERT INTO koe_contacts (id, display_name, phone, email, attributes) VALUES ('contact-ana', 'Ana', '51900007', 'ana@shop.test', '{\"plan\":\"gold\"}')");
    await k.rows("INSERT INTO koe_promises (id, contact_id, amount_cents, currency, due_date, reference) VALUES ('p1', 'contact-ana', 15000, 'PEN', '2026-11-20', 'CUOTA-3')");
    await k.rows("INSERT INTO koe_promises (id, contact_id, amount_cents, currency, due_date, status) VALUES ('p2', 'contact-ana', 9900, 'PEN', '2026-10-01', 'kept')");
    await k.rows(
      "INSERT INTO shop_orders (id, number, status, customer_email, total_cents, currency, tracking_number, placed_at) VALUES ('o1', '1001', 'shipped', 'ANA@shop.test', 5990, 'EUR', 'TRK-77', '2026-11-01')"
    );
    // crm_contacts does not exist here although the bench says every table does: that part is left out.
    await inbound("51900007", "wamid.g1", "¿Dónde está mi pedido?", "Ana");
    const context = runs.at(-1)!.context!;
    expect(context).toContain("Name: Ana. Phone: 51900007. Email: ana@shop.test");
    expect(context).toContain("Attributes: plan: gold");
    expect(context).toContain("Open payment promise: 150.00 PEN due 2026-11-20 (ref CUOTA-3)");
    expect(context).not.toContain("99.00 PEN");
    expect(context).toContain("Order #1001: shipped, 59.90 EUR, placed 2026-11-01, tracking TRK-77");
    expect(context).not.toContain("CRM");
    expect(sentTexts()).toContain("Reply to: ¿Dónde está mi pedido?");
  });
});

describe("the copilot for people in the inbox", () => {
  let k: Awaited<ReturnType<typeof koeBench>>;
  const json = async (res: Response): Promise<any> => res.json();
  let conversationId: string;

  beforeAll(async () => {
    k = await koeBench({ agents: fakeAgents });
    await k.request("admin", "PUT", `/members/${ACTORS.a.id}`, { role: "agent", displayName: ACTORS.a.name });
    await k.request("admin", "POST", "/channels", { kind: "whatsapp", name: "WA", externalId: "PN1", accountId: "waba-1", accessToken: "EAAG-test-token-123", appSecret: APP_SECRET });
    await k.webhook(waBody("PN1", { contacts: [{ wa_id: "51911", profile: { name: "Lucía" } }], messages: [waText("51911", "wamid.1", "Hello, my order never arrived")] }));
    await k.drain();
    conversationId = (await k.rows<any>("SELECT id FROM koe_conversations"))[0].id;
  });

  afterAll(async () => {
    await k?.close();
  });

  it("answers 409 until an admin chooses its agent; only admins choose it", async () => {
    const draft = await k.request("a", "POST", `/conversations/${conversationId}/copilot/draft`, {});
    expect(draft.status).toBe(409);
    expect((await k.request("a", "PUT", "/config/copilot", { agentId: "agent-copilot" })).status).toBe(403);
    const set = await k.request("admin", "PUT", "/config/copilot", { agentId: "agent-copilot" });
    expect(set.status, await set.clone().text()).toBe(200);
    expect((await json(await k.request("a", "GET", "/config/copilot"))).data).toMatchObject({ enabled: true, agentId: "agent-copilot" });
  });

  it("drafts a reply without sending it, from the thread, with no tools", async () => {
    const before = await k.rows("SELECT 1 FROM koe_messages WHERE direction = 'out'");
    const res = await k.request("a", "POST", `/conversations/${conversationId}/copilot/draft`, { instructions: "offer a refund" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await json(res)).data.draft).toMatch(/^Reply to: Write the next message/);
    const run = runs.at(-1)!;
    expect(run).toMatchObject({ agentId: "agent-copilot", allowedTools: [] });
    expect(run.message).toContain("offer a refund");
    expect(run.context).toContain("Customer: Hello, my order never arrived");
    expect(run.context).toContain("Name: Lucía");
    expect(await k.rows("SELECT 1 FROM koe_messages WHERE direction = 'out'")).toHaveLength(before.length);
  });

  it("summarizes and translates", async () => {
    const summary = await k.request("a", "POST", `/conversations/${conversationId}/copilot/summary`, { language: "Spanish" });
    expect(summary.status).toBe(200);
    expect(runs.at(-1)!.message).toContain("in Spanish");
    const translated = await json(await k.request("a", "POST", `/conversations/${conversationId}/copilot/translate`, { to: "es" }));
    expect(translated.data).toMatchObject({ to: "es", source: "Hello, my order never arrived" });
    expect(runs.at(-1)!.message).toContain("Hello, my order never arrived");
    expect(runs.at(-1)!.context).toBeUndefined();
  });

  it("is for koe members only, and only on conversations they see", async () => {
    expect((await k.request("staff", "POST", `/conversations/${conversationId}/copilot/draft`, {})).status).toBe(403);
    expect((await k.request("anon", "POST", `/conversations/${conversationId}/copilot/draft`, {})).status).toBe(401);
    expect((await k.request("a", "POST", `/conversations/does-not-exist/copilot/summary`, {})).status).toBe(404);
  });
});
