/**
 * kon-koe: security findings of the 2026-11-19 audit, fixed on 2026-11-21
 * ============================================================================
 *
 * Each block reproduces one finding on the real routes (PGlite as a non-superuser with row-level
 * security, the queue drained through koe's handlers, Meta's Graph API replaced by a recorder):
 *
 *   12  a template's header media is checked against what the sender may see, and must fit the header
 *   13  a key with one fine scope `kon:koe:<op>` opens that operation only, not the whole inbox
 *   14  the web chat visitor's channel is a server-keyed capability, not a hash staff can read
 *   18  a Meta webhook only applies the events of the channels whose app secret signed it
 *   19  the sales pipeline drops a deal's value and currency when kon-crm says the caller has no money access
 *   27  a member who is not a lead cannot snooze, resolve, transfer or grab someone else's conversation
 *   30  a marketing template needs the contact's opt-in, whoever sends it
 */

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_SECRET, koeBench, waBody, waText } from "./helpers/koe-bench";
import { ACTORS, APP_ROLE } from "./helpers/safe-kons-bench";

const OTHER_SECRET = "other-app-secret-9876543210";
const HOUR = 3_600_000;

describe("kon-koe security 2026-11-21", () => {
  let k: Awaited<ReturnType<typeof koeBench>>;
  const json = async (res: Response): Promise<any> => res.json();
  let support: string;
  let sales: string;
  let wa: { id: string };
  let wa2: { id: string };

  /** A new conversation on PN1 from this WhatsApp contact; returns its id. */
  async function conversationFrom(waId: string): Promise<string> {
    const res = await k.webhook(waBody("PN1", { contacts: [{ wa_id: waId, profile: { name: `C ${waId}` } }], messages: [waText(waId, `wamid.${waId}`, "hola")] }));
    expect(res.status).toBe(200);
    await k.drain();
    const [row] = await k.rows<{ id: string }>(
      "SELECT c.id FROM koe_conversations c JOIN koe_identities i ON i.id = c.identity_id WHERE i.external_id = $1",
      [waId]
    );
    expect(row, `conversation of ${waId}`).toBeDefined();
    return row!.id;
  }

  beforeAll(async () => {
    k = await koeBench();
    for (const [actor, role] of [["a", "agent"], ["b", "agent"], ["revisor", "agent"], ["member", "supervisor"]] as const) {
      const res = await k.request("admin", "PUT", `/members/${ACTORS[actor].id}`, { role, displayName: ACTORS[actor].name });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    support = (await json(await k.request("member", "POST", "/teams", { slug: "support", name: "Support", assignment: "manual" }))).data.id;
    sales = (await json(await k.request("member", "POST", "/teams", { slug: "sales", name: "Sales", purpose: "sales", assignment: "manual" }))).data.id;
    await k.request("member", "PUT", `/teams/${support}/members`, { userIds: [ACTORS.a.id, ACTORS.revisor.id] });
    await k.request("member", "PUT", `/teams/${sales}/members`, { userIds: [ACTORS.b.id] });
    const one = await k.request("admin", "POST", "/channels", { kind: "whatsapp", name: "WA 1", externalId: "PN1", accountId: "waba-1", accessToken: "EAAG-test-token-1", appSecret: APP_SECRET, defaultTeamId: support });
    expect(one.status, await one.clone().text()).toBe(201);
    wa = (await json(one)).data;
    const two = await k.request("admin", "POST", "/channels", { kind: "whatsapp", name: "WA 2", externalId: "PN2", accountId: "waba-2", accessToken: "EAAG-test-token-2", appSecret: OTHER_SECRET, defaultTeamId: support });
    expect(two.status, await two.clone().text()).toBe(201);
    wa2 = (await json(two)).data;
    await k.rows(
      `INSERT INTO koe_templates (id, channel_id, name, language, category, status, components) VALUES
       ('t-image', $1, 'oferta_foto', 'es', 'utility', 'approved', '[{"type":"HEADER","format":"IMAGE"},{"type":"BODY","text":"Tu pedido"}]'),
       ('t-promo', $1, 'promo', 'es', 'marketing', 'approved', '[{"type":"BODY","text":"Promo de hoy"}]')`,
      [wa.id]
    );
  });

  afterAll(async () => {
    await k?.close();
  });

  /** Several statements as the superuser that migrated (kon-crm's tables, for one test). */
  async function asSuperuser(statements: string) {
    await k.client.exec("RESET ROLE");
    try {
      await k.client.exec(statements);
    } finally {
      await k.client.exec(`SET ROLE ${APP_ROLE}`);
    }
  }

  async function mediaRow(id: string, kind: string, mime: string, conversationId: string | null) {
    await k.rows("INSERT INTO koe_media (id, conversation_id, kind, mime, size_bytes, storage_key, status) VALUES ($1, $2, $3, $4, 10, $5, 'ready')", [id, conversationId, kind, mime, `koe/${id}`]);
    k.files.set(`koe/${id}`, Buffer.from("bytes"));
  }

  // ── 12 ────────────────────────────────────────────────────────────────
  it("12: a template header media must be one the sender sees, of this conversation or the library, and fit the header", async () => {
    const mine = await conversationFrom("51801");
    const theirs = await conversationFrom("51802");
    await k.rows("UPDATE koe_conversations SET team_id = $2, state = 'human', assignee_id = $3 WHERE id = $1", [mine, support, ACTORS.a.id]);
    await k.rows("UPDATE koe_conversations SET team_id = $2, state = 'human', assignee_id = $3 WHERE id = $1", [theirs, sales, ACTORS.b.id]);
    await mediaRow("m-sales", "image", "image/jpeg", theirs); // Beto's conversation: Ana cannot see it
    await mediaRow("m-other-conv", "image", "image/jpeg", theirs);
    await mediaRow("m-doc", "document", "application/pdf", null);
    await mediaRow("m-lib", "image", "image/jpeg", null);

    const sendAs = (actor: "a" | "member", headerMediaId: string) =>
      k.request(actor, "POST", `/conversations/${mine}/messages`, { kind: "template", template: { templateId: "t-image", headerMediaId } });

    const hidden = await sendAs("a", "m-sales");
    expect([404, 422]).toContain(hidden.status);
    // A supervisor sees every conversation, but a header from another conversation stays out.
    expect([404, 422]).toContain((await sendAs("member", "m-other-conv")).status);
    // A document does not fit an IMAGE header.
    expect((await sendAs("a", "m-doc")).status).toBe(422);

    const ok = await sendAs("a", "m-lib");
    expect(ok.status, await ok.clone().text()).toBe(201);
    k.graphCalls.length = 0;
    await k.drain();
    expect(k.graphCalls.filter((c) => c.url.includes("/media"))).toHaveLength(1);
  });

  // ── 13 ────────────────────────────────────────────────────────────────
  it("13: a key with kon:koe:list-conversations lists, but does not send; koe:* still opens everything", async () => {
    const agentId = "agente-de-prueba";
    expect((await k.request("admin", "PUT", `/members/${agentId}`, { role: "agent", displayName: "Bot" })).status).toBe(200);
    const conv = await conversationFrom("51813");
    await k.rows("UPDATE koe_conversations SET team_id = NULL, state = 'queued', assignee_id = NULL WHERE id = $1", [conv]);

    const fine = { agent: ["kon:koe:list-conversations"] };
    expect((await k.request(fine, "GET", "/conversations")).status).toBe(200);
    expect((await k.request(fine, "POST", `/conversations/${conv}/messages`, { body: "hola" })).status).toBe(403);
    expect((await k.request(fine, "POST", `/conversations/${conv}/resolve`, {})).status).toBe(403);

    const whole = { agent: ["koe:*"] };
    expect((await k.request(whole, "GET", "/conversations")).status).toBe(200);
    expect((await k.request(whole, "POST", `/conversations/${conv}/resolve`, {})).status).toBe(200);
  });

  // ── 14 ────────────────────────────────────────────────────────────────
  it("14: the visitor's channel cannot be computed from what staff read", async () => {
    const ch = (await json(await k.request("admin", "POST", "/channels", { kind: "webchat", name: "Web" }))).data;
    const visitorId = "visitor-".padEnd(40, "k");
    const sent = await k.request("anon", "POST", `/public/webchat/${ch.externalId}/messages`, { visitorId, clientMessageId: "v-0001", text: "hola" });
    expect(sent.status, await sent.clone().text()).toBe(201);
    const { channel } = (await json(sent)).data as { channel: string };
    await k.drain();

    // What an agent can read: the identity's external id (the visitor hash).
    const [identity] = await k.rows<{ external_id: string }>("SELECT external_id FROM koe_identities WHERE channel_id = $1", [ch.id]);
    const hash = createHash("sha256").update(`koe-visitor:${visitorId}`).digest("hex");
    expect(identity!.external_id).toBe(hash);
    expect(channel).toMatch(/^kon:koe:visitor:[a-f0-9]{64}$/);
    expect(channel).not.toContain(identity!.external_id);

    // The history gives the same channel, and the answer travels on it, never on the readable one.
    const history = await json(await k.request("anon", "GET", `/public/webchat/${ch.externalId}/messages?visitorId=${visitorId}`));
    expect(history.channel).toBe(channel);
    const [conv] = await k.rows<{ id: string }>("SELECT id FROM koe_conversations WHERE channel_id = $1", [ch.id]);
    const reply = await k.request("member", "POST", `/conversations/${conv!.id}/messages`, { body: "¡Hola!" });
    expect(reply.status, await reply.clone().text()).toBe(201);
    await k.drain();
    expect(k.broadcasts.some((b) => b.channel === channel && b.message.body === "¡Hola!")).toBe(true);
    expect(k.broadcasts.some((b) => b.channel === `kon:koe:visitor:${identity!.external_id}`)).toBe(false);
  });

  // ── 18 ────────────────────────────────────────────────────────────────
  it("18: a webhook signed by one channel's app secret applies only that channel's events", async () => {
    const before = (await k.rows("SELECT 1 FROM koe_messages WHERE channel_id = $1", [wa2.id])).length;
    const p1 = waBody("PN1", { contacts: [{ wa_id: "51818" }], messages: [waText("51818", "wamid.mix1", "real")] });
    const p2 = waBody("PN2", { wabaId: "waba-2", contacts: [{ wa_id: "51819" }], messages: [waText("51819", "wamid.mix2", "forged")] });
    // Channel 1's account, but channel 2's number.
    const p3 = waBody("PN2", { wabaId: "waba-1", contacts: [{ wa_id: "51820" }], messages: [waText("51820", "wamid.mix3", "forged too")] });
    const body = { object: "whatsapp_business_account", entry: [...p1.entry, ...p2.entry, ...p3.entry] };
    expect((await k.webhook(body, APP_SECRET)).status).toBe(200);
    await k.drain();
    expect(await k.rows("SELECT 1 FROM koe_messages WHERE external_id = 'wamid.mix1'")).toHaveLength(1);
    expect(await k.rows("SELECT 1 FROM koe_messages WHERE external_id IN ('wamid.mix2', 'wamid.mix3')")).toHaveLength(0);
    expect(await k.rows("SELECT 1 FROM koe_messages WHERE channel_id = $1", [wa2.id])).toHaveLength(before);
    // Signed by channel 2's own secret, its event goes in.
    expect((await k.webhook(p2, OTHER_SECRET)).status).toBe(200);
    await k.drain();
    expect(await k.rows("SELECT 1 FROM koe_messages WHERE external_id = 'wamid.mix2'")).toHaveLength(1);
  });

  // ── 19 ────────────────────────────────────────────────────────────────
  it("19: the sales pipeline shows a deal's money only when kon-crm grants it", async () => {
    const conv = await conversationFrom("51819x");
    await k.rows("UPDATE koe_conversations SET team_id = $2, state = 'human', assignee_id = $3, crm_deal_id = 'deal-1' WHERE id = $1", [conv, sales, ACTORS.b.id]);
    await asSuperuser(`CREATE TABLE crm_pipeline_stages (id text PRIMARY KEY, name text);
      CREATE TABLE crm_deals (id text PRIMARY KEY, title text, status text, value numeric, currency text, stage_id text);
      INSERT INTO crm_pipeline_stages VALUES ('s1', 'Propuesta');
      INSERT INTO crm_deals VALUES ('deal-1', 'Flota', 'open', 125000, 'PEN', 's1');
      GRANT SELECT ON crm_deals, crm_pipeline_stages TO ${APP_ROLE};`);

    const deal = async () => (await json(await k.request("member", "GET", "/sales/pipeline"))).data.find((r: any) => r.id === conv).deal;

    // kon-crm without its access function (an older kon-crm): no money.
    expect(await deal()).toMatchObject({ title: "Flota", stage: "Propuesta" });
    expect(await deal()).not.toHaveProperty("value");

    await asSuperuser(`CREATE FUNCTION crm_access() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"records":"all","money":false}'::jsonb $$`);
    const hidden = await deal();
    expect(hidden).toMatchObject({ title: "Flota", status: "open", stage: "Propuesta" });
    expect(hidden).not.toHaveProperty("value");
    expect(hidden).not.toHaveProperty("currency");

    await asSuperuser(`CREATE OR REPLACE FUNCTION crm_access() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"records":"all","money":true}'::jsonb $$`);
    expect(await deal()).toMatchObject({ title: "Flota", currency: "PEN" });
  });

  // ── 27 ────────────────────────────────────────────────────────────────
  it("27: a member who is not a lead cannot act on a conversation someone else has", async () => {
    const conv = await conversationFrom("51827");
    await k.rows("UPDATE koe_conversations SET team_id = $2, state = 'human', assignee_id = $3, last_inbound_at = now() WHERE id = $1", [conv, support, ACTORS.a.id]);
    const until = new Date(Date.now() + HOUR).toISOString();

    // Rita is on the same team and sees it, but Ana has it.
    expect((await k.request("revisor", "GET", `/conversations/${conv}`)).status).toBe(200);
    expect((await k.request("revisor", "POST", `/conversations/${conv}/snooze`, { until })).status).toBe(403);
    expect((await k.request("revisor", "POST", `/conversations/${conv}/resolve`, {})).status).toBe(403);
    expect((await k.request("revisor", "POST", `/conversations/${conv}/transfer`, { teamId: sales })).status).toBe(403);
    expect((await k.rows<any>("SELECT state, assignee_id FROM koe_conversations WHERE id = $1", [conv]))[0]).toEqual({ state: "human", assignee_id: ACTORS.a.id });

    // Ana snoozes it; Rita can neither take it nor grab it by replying.
    expect((await k.request("a", "POST", `/conversations/${conv}/snooze`, { until })).status).toBe(200);
    expect((await k.request("revisor", "POST", `/conversations/${conv}/take`, {})).status).toBe(403);
    expect((await k.request("revisor", "POST", `/conversations/${conv}/messages`, { body: "yo la tomo" })).status).toBe(409);
    expect((await k.request("revisor", "POST", `/conversations/${conv}/resolve`, {})).status).toBe(403);
    expect((await k.rows<any>("SELECT state, assignee_id FROM koe_conversations WHERE id = $1", [conv]))[0]).toEqual({ state: "snoozed", assignee_id: ACTORS.a.id });

    // A supervisor keeps full power.
    expect((await k.request("member", "POST", `/conversations/${conv}/resolve`, {})).status).toBe(200);
  });

  // ── 30 ────────────────────────────────────────────────────────────────
  it("30: a marketing template needs the contact's opt-in, also when a person or a rule sends it", async () => {
    const conv = await conversationFrom("51830");
    await k.rows("UPDATE koe_conversations SET team_id = $2, state = 'human', assignee_id = $3 WHERE id = $1", [conv, support, ACTORS.a.id]);
    const promo = () => k.request("a", "POST", `/conversations/${conv}/messages`, { kind: "template", template: { templateId: "t-promo" } });

    const refused = await promo();
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await json(refused))).toMatch(/OPTED_OUT/);
    const { send } = await import("../../kons/kon-koe/koe.send");
    for (const kind of ["ai", "rule", "system"] as const) {
      if (kind === "ai") await k.rows("UPDATE koe_conversations SET state = 'bot', assignee_id = NULL WHERE id = $1", [conv]);
      await expect(send({ ctx: k.ctx, db: k.ctx.db.instance }, { conversationId: conv, author: { kind }, kind: "template", template: { templateId: "t-promo" } }), kind).rejects.toThrow(/agreed|opted/);
    }
    await k.rows("UPDATE koe_conversations SET state = 'human', assignee_id = $2 WHERE id = $1", [conv, ACTORS.a.id]);

    const [c] = await k.rows<{ contact_id: string }>("SELECT contact_id FROM koe_conversations WHERE id = $1", [conv]);
    await k.rows("INSERT INTO koe_consents (id, contact_id, channel_id, status, source) VALUES ('cons-30', $1, $2, 'opted_in', 'form')", [c!.contact_id, wa.id]);
    const ok = await promo();
    expect(ok.status, await ok.clone().text()).toBe(201);
  });
});

// A second bench resets the queue and Graph doubles: it runs after the first one closed.
describe("kon-koe security 2026-11-21, on a host without realtime capabilities", () => {
  const json = async (res: Response): Promise<any> => res.json();
  it("14: a host without capabilities gives no visitor channel (the widget polls)", async () => {
    const broadcasts: Array<{ channel: string }> = [];
    const bare = await koeBench({ realtime: { broadcast: (channel: string) => broadcasts.push({ channel }), sendToUser: () => {} } });
    try {
      const ch = (await json(await bare.request("admin", "POST", "/channels", { kind: "webchat", name: "Web" }))).data;
      const sent = await bare.request("anon", "POST", `/public/webchat/${ch.externalId}/messages`, { visitorId: "visitor-".padEnd(40, "p"), clientMessageId: "v-0002", text: "hola" });
      expect(sent.status, await sent.clone().text()).toBe(201);
      expect((await json(sent)).data.channel ?? null).toBeNull();
    } finally {
      await bare.close();
    }
  });
});
