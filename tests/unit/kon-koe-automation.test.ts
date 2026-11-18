/**
 * kon-koe: automation — bot flows, rule steps, campaigns, sequences, sales and collections, the sweep, reports
 * ============================================================================
 *
 * The pure parts first (flow checks, the flow engine, local time). Then the kon on PGlite as a
 * non-superuser with row-level security, the queue drained through koe's real handlers and Meta's Graph
 * API replaced by a recorder (tests/unit/helpers/koe-bench.ts).
 *
 * Actors: `a` is a koe agent of the support team, `member` a koe supervisor, `admin` a Kitsuden admin.
 */

import { reportDefinitionProblem } from "@kitsuden/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { koeActionHandlers, koeReports, registerAutomationListeners, sweepOnce } from "../../kons/kon-koe/koe.automation";
import { checkFlow, runFlowTurn, simulateFlow, type FlowDefinition } from "../../kons/kon-koe/koe.flows";
import { inBusinessHours, inQuietHours } from "../../kons/kon-koe/koe.hours";
import { runSequenceStep } from "../../kons/kon-koe/koe.sequences";

import { APP_SECRET, koeBench, waBody, waText } from "./helpers/koe-bench";
import { ACTORS } from "./helpers/safe-kons-bench";

const HOUR = 3_600_000;
const json = async (res: Response): Promise<any> => res.json();

// A menu, an email with one retry, a branch on the captured value, and a person at the end.
const LEAD_FLOW = (teamId: string): FlowDefinition => ({
  start: "menu",
  nodes: {
    menu: { type: "message", interactive: { type: "buttons", body: "¡Hola {{contact.name}}! ¿Qué necesitas?", buttons: [{ id: "sales", title: "Comprar" }, { id: "agent", title: "Una persona" }] }, next: "route" },
    route: { type: "branch", cases: [{ reply: "sales", next: "email" }, { reply: "agent", next: "human" }, { keywords: ["precio", "precios"], next: "email" }], retryText: "Elige una opción, por favor." },
    email: { type: "ask", text: "¿Cuál es tu correo?", var: "email", validate: { kind: "email" }, retryText: "Ese correo no parece válido.", maxRetries: 1, next: "tag", onFail: "human" },
    tag: { type: "set", labels: ["lead"], attributes: { email: "{{vars.email}}" }, next: "check" },
    check: { type: "branch", cases: [{ var: "email", op: "contains", value: "@empresa.com", next: "vip" }], default: "human" },
    vip: { type: "set", priority: "high", next: "human" },
    human: { type: "handoff", teamId, text: "Te paso con una persona.", summary: "Lead {{vars.email}}" },
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Pure parts
// ════════════════════════════════════════════════════════════════════════════

describe("flow definitions are checked before they are saved", () => {
  it("accepts a good flow and names what is wrong with bad ones", () => {
    expect(checkFlow(LEAD_FLOW("team-1")).problems).toEqual([]);
    expect(checkFlow({ start: "x", nodes: { x: { type: "dance" } } }).problems.join()).toMatch(/unknown type "dance"/);
    expect(checkFlow({ start: "a", nodes: { a: { type: "message", text: "hi", next: "nowhere" } } }).problems.join()).toMatch(/next "nowhere" is not a node/);
    expect(checkFlow({ start: "missing", nodes: { a: { type: "resolve" } } }).problems.join()).toMatch(/start must name/);
    expect(checkFlow({ start: "a", nodes: { a: { type: "message", interactive: { type: "buttons", body: "x", buttons: [1, 2, 3, 4] } } } }).problems.join()).toMatch(/1 to 3 buttons/);
    expect(checkFlow({ start: "a", nodes: { a: { type: "ask", text: "?", var: "x", validate: { kind: "regex", pattern: "(" }, next: "a" } } }).problems.join()).toMatch(/not a valid regular expression/);
    expect(checkFlow({ start: "b", nodes: { b: { type: "branch", cases: [{ var: "x", op: "exists", next: "b" }] } } }).problems.join()).toMatch(/needs a default/);
  });

  it("refuses loops that never wait for the contact, but not loops through a question", () => {
    const loop = checkFlow({ start: "a", nodes: { a: { type: "message", text: "1", next: "b" }, b: { type: "goto", next: "a" } } });
    expect(loop.problems.join()).toMatch(/loop without waiting/);
    const asking = checkFlow({ start: "a", nodes: { a: { type: "message", text: "1", next: "q" }, q: { type: "ask", text: "?", var: "x", next: "a" } } });
    expect(asking.problems).toEqual([]);
    expect(checkFlow({ start: "a", nodes: { a: { type: "resolve" }, lost: { type: "resolve" } } }).warnings.join()).toMatch(/"lost" cannot be reached/);
  });

  it("a dry run: retries, then a person when the contact cannot answer", async () => {
    const run = await simulateFlow(LEAD_FLOW("team-1"), ["hola", { id: "sales" }, "no sé", "tampoco"], { interactive: true });
    expect(run.outcome).toBe("handoff");
    const bot = run.transcript.filter((l) => "from" in l && l.from === "bot").map((l: any) => l.text ?? l.interactive?.body);
    expect(bot).toEqual(["¡Hola Test contact! ¿Qué necesitas?", "¿Cuál es tu correo?", "Ese correo no parece válido.", "Te paso con una persona."]);
    expect(run.transcript.at(-1)).toMatchObject({ action: "handoff", teamId: "team-1", summary: "Lead " });
  });

  it("menus become numbered text where buttons do not exist, and a number answers them", async () => {
    const run = await simulateFlow(LEAD_FLOW("t"), ["hola", "1", "ana@empresa.com"], { interactive: false });
    expect((run.transcript[1] as any).text).toBe("¡Hola Test contact! ¿Qué necesitas?\n1. Comprar\n2. Una persona");
    expect(run.outcome).toBe("handoff");
    expect(run.transcript.filter((l: any) => l.action === "set")).toEqual([
      { action: "set", labels: ["lead"], attributes: { email: "ana@empresa.com" }, priority: undefined, contact: undefined },
      { action: "set", priority: "high", labels: undefined, attributes: undefined, contact: undefined },
    ]);
    // A keyword routes too.
    const kw = await simulateFlow(LEAD_FLOW("t"), ["hola", "¿cuáles son los PRECIOS?"], { interactive: true });
    expect(kw.state.node).toBe("email");
  });
});

describe("local time", () => {
  const at = new Date("2026-11-16T03:30:00Z"); // Monday 03:30 UTC = Sunday 22:30 in Lima
  it("quiet hours wrap midnight and follow the contact's zone", () => {
    const quiet = { from: "21:00", to: "08:00", timezone: "UTC" };
    expect(inQuietHours(at, quiet)).toBe(true);
    expect(inQuietHours(new Date("2026-11-16T12:00:00Z"), quiet)).toBe(false);
    expect(inQuietHours(new Date("2026-11-16T12:00:00Z"), quiet, "Asia/Tokyo")).toBe(true); // 21:00 in Tokyo
    expect(inQuietHours(at, { from: "08:00", to: "08:00", timezone: "UTC" })).toBe(false);
  });
  it("business hours by day, in a zone; none set means any time", () => {
    const hours = { mon: [["09:00", "18:00"]] as Array<[string, string]>, sun: [["10:00", "23:00"]] as Array<[string, string]> };
    expect(inBusinessHours(at, hours, "America/Lima")).toBe(true); // Sunday 22:30
    expect(inBusinessHours(at, hours, "UTC")).toBe(false); // Monday 03:30
    expect(inBusinessHours(at, {}, "UTC")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The kon on a real database
// ════════════════════════════════════════════════════════════════════════════

describe("automation end to end", () => {
  let k: Awaited<ReturnType<typeof koeBench>>;
  let support: string;
  let wa: { id: string };
  let flowChannel: { id: string };
  const handler = (id: string) => koeActionHandlers.find((h) => h.id === id)!;
  const rule = { id: "rule-1", name: "Test rule" };

  /** A webhook, processed (its inbound job only: the bot turn is run by hand where a test wants it). */
  async function receive(phoneNumberId: string, message: unknown, contacts?: unknown[]) {
    await k.drain();
    expect((await k.webhook(waBody(phoneNumberId, { messages: [message], ...(contacts ? { contacts } : {}) }))).status).toBe(200);
    await k.drain(1);
    for (let i = k.jobs.length - 1; i >= 0; i--) if (k.jobs[i]!.queue === "koe-bot") k.jobs.splice(i, 1);
  }
  const conversationOf = async (phone: string) => (await k.rows<any>("SELECT c.* FROM koe_conversations c JOIN koe_identities i ON i.id = c.identity_id WHERE i.external_id = $1 ORDER BY c.created_at DESC LIMIT 1", [phone]))[0];
  const messageOf = async (externalId: string) => (await k.rows<any>("SELECT * FROM koe_messages WHERE external_id = $1", [externalId]))[0];
  const outBodies = async (conversationId: string) => (await k.rows<any>("SELECT body FROM koe_messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY created_at, id", [conversationId])).map((r) => r.body);
  const eventsOf = (name: string, conversationId?: string) => k.events.filter((e) => e.name === name && (!conversationId || e.data.conversationId === conversationId));

  beforeAll(async () => {
    k = await koeBench();
    for (const [actor, role] of [["a", "agent"], ["member", "supervisor"]] as const) {
      expect((await k.request("admin", "PUT", `/members/${ACTORS[actor].id}`, { role, displayName: ACTORS[actor].name })).status).toBe(200);
    }
    support = (await json(await k.request("member", "POST", "/teams", { slug: "support", name: "Support", assignment: "round_robin", slaFirstResponseS: 600 }))).data.id;
    await k.request("member", "PUT", `/teams/${support}/members`, { userIds: [ACTORS.a.id] });
    const channel = (externalId: string) => k.request("admin", "POST", "/channels", { kind: "whatsapp", name: externalId, externalId, accountId: "waba-1", accessToken: "EAAG-test-token-123", appSecret: APP_SECRET, defaultTeamId: support });
    wa = (await json(await channel("PN1"))).data;
    flowChannel = (await json(await channel("PN2"))).data;
    await k.rows(
      `INSERT INTO koe_templates (id, channel_id, name, language, category, status, components) VALUES
       ('t-camp', $1, 'novedades', 'es', 'utility', 'approved', '[{"type":"BODY","text":"Hola {{1}}, tenemos novedades"}]'),
       ('t-remind', $1, 'recordatorio', 'es', 'utility', 'approved', '[{"type":"BODY","text":"Hola, ¿seguimos?"}]')`,
      [wa.id]
    );
    registerAutomationListeners(k.ctx);
  });

  afterAll(async () => {
    await k?.close();
  });

  // ── Flows ───────────────────────────────────────────────────────────────

  it("flows: only leads save them, and a bad definition is refused with its problems", async () => {
    expect((await k.request("a", "POST", "/flows", { name: "x", definition: LEAD_FLOW(support) })).status).toBe(403);
    const bad = await k.request("member", "POST", "/flows", { name: "x", definition: { start: "a", nodes: { a: { type: "goto", next: "a" } } } });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await json(bad))).toMatch(/loop without waiting/);
    const ghostTeam = await k.request("member", "POST", "/flows", { name: "x", definition: LEAD_FLOW("no-such-team") });
    expect(ghostTeam.status).toBe(422);
  });

  it("flows: menu → email (with a retry) → branch → handoff, idempotent when the job runs again", async () => {
    const created = await k.request("member", "POST", "/flows", { name: "Leads", channelId: flowChannel.id, definition: LEAD_FLOW(support) });
    expect(created.status, await created.clone().text()).toBe(201);
    const flow = (await json(created)).data;
    expect((await k.request("admin", "PATCH", `/channels/${flowChannel.id}`, { settings: { flowId: flow.id } })).status).toBe(200);
    const dry = await json(await k.request("a", "POST", `/flows/${flow.id}/test`, { replies: ["hola", { id: "agent" }] }));
    expect(dry.data.outcome).toBe("handoff");
    k.graphCalls.length = 0;

    const turn = async (externalId: string) => {
      const m = await messageOf(externalId);
      const c = await k.rows<any>("SELECT id FROM koe_conversations WHERE id = $1", [m.conversation_id]);
      return runFlowTurn(k.ctx, k.ctx.db.instance, { id: c[0].id } as any, { id: m.id, body: m.body, payload: m.payload } as any);
    };

    await receive("PN2", waText("51977", "wamid.f1", "hola"), [{ wa_id: "51977", profile: { name: "Ana" } }]);
    const conv = await conversationOf("51977");
    expect(conv.state).toBe("bot");
    expect(await turn("wamid.f1")).toBe("handled");
    await receive("PN2", { from: "51977", id: "wamid.f2", timestamp: String(Math.floor(Date.now() / 1000)), type: "interactive", interactive: { type: "button_reply", button_reply: { id: "sales", title: "Comprar" } } });
    expect(await turn("wamid.f2")).toBe("handled");
    // The job runs again (at least once): nothing new goes out.
    expect(await turn("wamid.f2")).toBe("handled");
    await receive("PN2", waText("51977", "wamid.f3", "no tengo"));
    expect(await turn("wamid.f3")).toBe("handled");
    await receive("PN2", waText("51977", "wamid.f4", "Ana@Empresa.com"));
    expect(await turn("wamid.f4")).toBe("handoff");
    expect(await turn("wamid.f4")).toBe("handoff");

    expect(await outBodies(conv.id)).toEqual(["¡Hola Ana! ¿Qué necesitas?", "¿Cuál es tu correo?", "Ese correo no parece válido.", "Te paso con una persona."]);
    const [after] = await k.rows<any>("SELECT * FROM koe_conversations WHERE id = $1", [conv.id]);
    expect(after).toMatchObject({ state: "human", assignee_id: ACTORS.a.id, team_id: support, priority: "high", labels: ["lead"] });
    expect(after.metadata).toMatchObject({ handoffSummary: "Lead ana@empresa.com", flow: { node: null, vars: { email: "ana@empresa.com" }, outcome: "handoff" } });
    expect((await k.rows<any>("SELECT attributes FROM koe_contacts WHERE id = $1", [conv.contact_id]))[0].attributes).toMatchObject({ email: "ana@empresa.com" });
    expect(eventsOf("koe:flow.completed", conv.id)).toHaveLength(1);
    expect(eventsOf("koe:flow.completed", conv.id)[0]!.data).toMatchObject({ outcome: "handoff", vars: { email: "ana@empresa.com" } });

    // What went out: the buttons and three texts, each once; the last words after the handoff as the system.
    await k.drain();
    const sent = k.graphCalls.filter((c) => c.url.endsWith("/PN2/messages")).map((c) => c.body as any);
    expect(sent).toHaveLength(4);
    expect(sent[0]).toMatchObject({ type: "interactive", interactive: { type: "button" } });
    expect((await k.rows<any>("SELECT author_kind, status FROM koe_messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY created_at, id", [conv.id])).map((r) => `${r.author_kind}:${r.status}`)).toEqual(["bot:sent", "bot:sent", "bot:sent", "system:sent"]);
    // A person has it now: the flow stays quiet.
    await receive("PN2", waText("51977", "wamid.f5", "¿hola?"));
    expect(await turn("wamid.f5")).toBe("no-flow");
  });

  // ── Rule steps ──────────────────────────────────────────────────────────

  it("rule steps check their config", () => {
    expect(koeActionHandlers.map((h) => h.id).sort()).toEqual(["add-label", "add-note", "assign", "record-outcome", "send-message", "send-template", "set-state", "start-sequence"]);
    expect(handler("send-message").validate!({})).toMatch(/text is required/);
    expect(handler("send-message").validate!({ text: "hola" })).toBeNull();
    expect(handler("send-template").validate!({ values: {} })).toMatch(/templateId/);
    expect(handler("assign").validate!({ userId: "u", teamId: "t" })).toMatch(/exactly one/);
    expect(handler("assign").validate!({ auto: true })).toBeNull();
    expect(handler("set-state").validate!({ state: "snooze" })).toMatch(/minutes/);
    expect(handler("set-state").validate!({ state: "snooze", minutes: "{{event.minutes}}" })).toBeNull();
    expect(handler("add-label").validate!({ labels: "vip, deuda" })).toBeNull();
    expect(handler("add-label").validate!({ labels: [] })).toMatch(/1 to 10/);
    expect(handler("add-note").validate!({ body: "" })).toMatch(/body/);
    expect(handler("start-sequence").validate!({})).toMatch(/sequenceId/);
    expect(handler("record-outcome").validate!({ kind: "sold" })).toMatch(/kind must be/);
    expect(handler("record-outcome").validate!({ kind: "paid", amountCents: 100 })).toMatch(/currency/);
    expect(handler("record-outcome").validate!({ kind: "paid", amountCents: 100, currency: "PEN" })).toBeNull();
    expect(handler("add-note").validate!({ body: "x", conversationId: 5 })).toMatch(/conversationId/);
  });

  it("rule steps act on the event's conversation, as the rule, once per event", async () => {
    await receive("PN1", waText("51911", "wamid.r1", "quiero pagar"), [{ wa_id: "51911", profile: { name: "Lucía" } }]);
    const conv = await conversationOf("51911");
    expect(conv).toMatchObject({ state: "human", assignee_id: ACTORS.a.id });
    const input = (config: Record<string, unknown>) => ({ config, event: { name: "koe:message.received", data: { conversationId: conv.id, messageId: "m-1" } }, rule, actorUserId: ACTORS.member.id });

    const first = (await handler("send-message").run(input({ text: "Hola, te ayudamos" }), k.ctx)) as any;
    const again = (await handler("send-message").run(input({ text: "Hola, te ayudamos" }), k.ctx)) as any;
    expect(again.messageId).toBe(first.messageId);
    expect((await k.rows<any>("SELECT author_kind, author_id FROM koe_messages WHERE id = $1", [first.messageId]))[0]).toEqual({ author_kind: "rule", author_id: "rule-1" });
    expect(await handler("send-message").preview!(input({ text: "x" }), k.ctx)).toMatchObject({ found: true, state: "human", windowOpen: true });

    expect(((await handler("send-template").run(input({ templateId: "t-camp", values: { "1": "{{contact.name}}" } }), k.ctx)) as any).messageId).toBeTruthy();
    expect((await k.rows<any>("SELECT body FROM koe_messages WHERE template_id = 't-camp' AND conversation_id = $1", [conv.id]))[0].body).toBe("Hola Lucía, tenemos novedades");

    await handler("add-label").run(input({ labels: "vip, deuda-30" }), k.ctx);
    await handler("add-label").run(input({ labels: ["vip"] }), k.ctx);
    expect((await k.rows<any>("SELECT labels FROM koe_conversations WHERE id = $1", [conv.id]))[0].labels).toEqual(["vip", "deuda-30"]);

    await handler("add-note").run(input({ body: "Cliente prioritario" }), k.ctx);
    expect((await k.rows<any>("SELECT author_kind, author_id, body FROM koe_notes WHERE conversation_id = $1", [conv.id]))[0]).toEqual({ author_kind: "rule", author_id: ACTORS.member.id, body: "Cliente prioritario" });

    await handler("record-outcome").run(input({ kind: "contacted", note: "por regla" }), k.ctx);
    expect((await k.rows<any>("SELECT kind, author_id FROM koe_outcomes WHERE conversation_id = $1", [conv.id]))[0]).toEqual({ kind: "contacted", author_id: ACTORS.member.id });
    expect(eventsOf("koe:outcome.recorded", conv.id)).toHaveLength(1);

    expect(await handler("assign").run(input({ userId: ACTORS.member.id }), k.ctx)).toMatchObject({ state: "human", assigneeId: ACTORS.member.id, changed: true });
    expect(await handler("set-state").run(input({ state: "snooze", minutes: 30 }), k.ctx)).toMatchObject({ state: "snoozed" });
    expect(await handler("set-state").run(input({ state: "resolve" }), k.ctx)).toMatchObject({ state: "resolved" });
    expect(await handler("set-state").run(input({ state: "resolve" }), k.ctx)).toMatchObject({ state: "resolved", changed: false });
    await expect(handler("add-note").run({ config: { body: "x" }, rule, actorUserId: null }, k.ctx)).rejects.toThrow(/No conversation/);
  });

  // ── Campaigns ───────────────────────────────────────────────────────────

  it("campaigns: only contacts who agreed get it, at the campaign's pace, and it finishes", async () => {
    // A contact who said STOP before, and one the team blocked.
    await k.rows(`INSERT INTO koe_contacts (id, display_name, phone) VALUES ('c-out', 'Cinco', '51900000005'), ('c-blocked', 'Seis', '51900000006')`);
    await k.rows(`INSERT INTO koe_consents (id, contact_id, channel_id, status, source) VALUES ('cs-out', 'c-out', $1, 'opted_out', 'keyword')`, [wa.id]);

    expect((await k.request("a", "POST", "/campaigns", { channelId: wa.id, name: "x", templateId: "t-camp" })).status).toBe(403);
    const created = await k.request("member", "POST", "/campaigns", { channelId: wa.id, name: "Novedades", templateId: "t-camp", variables: { "1": "{{contact.name}}" }, ratePerMinute: 2 });
    expect(created.status, await created.clone().text()).toBe(201);
    const id = (await json(created)).data.id;
    const optIn = { source: "formulario web 2026-11" };
    const importRes = await k.request("member", "POST", `/campaigns/${id}/recipients`, {
        contacts: [
          { phone: "+51 900 000 001", name: "Uno", optIn },
          { phone: "51900000002", name: "Dos", optIn },
          { phone: "51900000003", name: "Tres", optIn },
          { phone: "51900000004", name: "Cuatro" },
          { phone: "51900000005", optIn },
          { phone: "51900000006", optIn },
          { phone: "1234567", optIn },
        ],
      });
    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const imported = await json(importRes);
    expect(imported.data).toMatchObject({ added: 6, contactsCreated: 4, consentsRecorded: 4, optOutsKept: 1, invalidPhones: 1 });
    await k.rows(`UPDATE koe_contacts SET blocked = true WHERE id = 'c-blocked'`);

    let estimate = (await json(await k.request("member", "GET", `/campaigns/${id}/estimate`))).data;
    expect(estimate).toMatchObject({ recipients: 6, eligible: 3, skipped: { noConsent: 1, optedOut: 1, blocked: 1, noPhone: 0 } });
    expect(estimate.cost).toMatchObject({ currency: null, estimated: null });
    expect((await k.request("member", "PUT", "/config/pricing", { currency: "USD", categories: { utility: { "51": 0.02 } } })).status).toBe(403);
    expect((await k.request("admin", "PUT", "/config/pricing", { currency: "USD", categories: { utility: { "51": 0.02, "*": 0.05 } }, note: "test prices" })).status).toBe(200);
    estimate = (await json(await k.request("member", "GET", `/campaigns/${id}/estimate`))).data;
    expect(estimate.cost).toMatchObject({ currency: "USD", estimated: 0.06, complete: true });

    expect((await k.request("member", "POST", `/campaigns/${id}/schedule`, {})).status).toBe(409); // not approved
    const approved = await k.request("member", "POST", `/campaigns/${id}/approve`, {});
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect((await json(approved)).data.estimatedCostUsd).toBe("0.0600");
    expect((await k.request("member", "POST", `/campaigns/${id}/recipients`, { contacts: [{ phone: "51900000009", optIn }] })).status).toBe(409);

    await k.drain();
    const t0 = Date.now();
    expect((await k.request("member", "POST", `/campaigns/${id}/schedule`, {})).status).toBe(200);
    await k.drain();
    const status = async () => Object.fromEntries((await k.rows<any>("SELECT status, count(*)::int AS n FROM koe_campaign_recipients WHERE campaign_id = $1 GROUP BY status", [id])).map((r) => [r.status, r.n]));
    // First minute: two sent (the pace), the three that cannot receive it skipped, one waiting.
    expect(await status()).toEqual({ sent: 2, skipped: 3, pending: 1 });
    expect(eventsOf("koe:campaign.started")).toHaveLength(1);
    // The same minute again: nothing more.
    await sweepOnce(k.ctx, new Date(t0 + 1000));
    await k.drain();
    expect((await status()).sent).toBe(2);
    // The next minute: the last one, and the campaign is done.
    await sweepOnce(k.ctx, new Date(t0 + 61_000));
    await k.drain();
    expect(await status()).toEqual({ sent: 3, skipped: 3 });
    expect(eventsOf("koe:campaign.finished")).toEqual([{ name: "koe:campaign.finished", data: { campaignId: id, sent: 3, failed: 0, skipped: 3 } }]);

    const reasons = await k.rows<any>("SELECT error FROM koe_campaign_recipients WHERE campaign_id = $1 AND status = 'skipped' ORDER BY error", [id]);
    expect(reasons.map((r) => r.error)).toEqual(["blocked", "no_consent", "opted_out"]);
    const sent = k.graphCalls.filter((c) => c.url.endsWith("/PN1/messages") && (c.body as any).type === "template" && (c.body as any).template.name === "novedades" && String((c.body as any).to).startsWith("519000")).map((c) => (c.body as any).to);
    expect(sent.sort()).toEqual(["51900000001", "51900000002", "51900000003"]);
    // The messages landed in resolved threads nobody has to answer, from the campaign.
    const landed = await k.rows<any>("SELECT c.state, m.author_kind FROM koe_campaign_recipients r JOIN koe_messages m ON m.id = r.message_id JOIN koe_conversations c ON c.id = m.conversation_id WHERE r.campaign_id = $1", [id]);
    expect(landed).toEqual(Array(3).fill({ state: "resolved", author_kind: "campaign" }));
    const stats = (await json(await k.request("member", "GET", `/campaigns/${id}/stats`))).data;
    expect(stats).toMatchObject({ status: "done", recipients: { sent: 3, skipped: 3, total: 6 }, reasons: { blocked: 1, no_consent: 1, opted_out: 1 } });
  });

  it("campaigns: quiet hours keep recipients waiting", async () => {
    const id = (await json(await k.request("member", "POST", "/campaigns", { channelId: wa.id, name: "Noche", templateId: "t-camp", variables: { "1": "x" }, quietHours: { from: "00:00", to: "23:59", timezone: "UTC" } }))).data.id;
    await k.request("member", "POST", `/campaigns/${id}/recipients`, { contacts: [{ phone: "51900000001" }] });
    await k.request("member", "POST", `/campaigns/${id}/approve`, {});
    await k.request("member", "POST", `/campaigns/${id}/schedule`, {});
    await k.drain();
    const quietNow = new Date();
    quietNow.setUTCHours(12, 0, 0, 0);
    const { runCampaignBatch } = await import("../../kons/kon-koe/koe.campaigns");
    expect(await runCampaignBatch(k.ctx, id, quietNow)).toMatchObject({ sent: 0, waiting: 1 });
    expect((await k.request("member", "POST", `/campaigns/${id}/cancel`, {})).status).toBe(200);
    expect((await k.rows<any>("SELECT status, error FROM koe_campaign_recipients WHERE campaign_id = $1", [id]))[0]).toEqual({ status: "skipped", error: "cancelled" });
  });

  // ── Sequences ───────────────────────────────────────────────────────────

  it("sequences: steps go out on time, and stop when the contact replies", async () => {
    await receive("PN1", waText("51922", "wamid.s1", "hola"), [{ wa_id: "51922", profile: { name: "Bea" } }]);
    const conv = await conversationOf("51922");
    expect(conv.assignee_id).toBe(ACTORS.a.id);
    expect((await k.request("a", "POST", "/sequences", { name: "x", channelId: wa.id, steps: [{ delayMinutes: 0, text: "x" }] })).status).toBe(403);
    const seq = (await json(await k.request("member", "POST", "/sequences", { name: "Cobranza", channelId: wa.id, steps: [{ delayMinutes: 0, text: "Recordatorio 1" }, { delayMinutes: 60, text: "Recordatorio 2" }] }))).data;
    // The agent who has the conversation starts it.
    const started = await k.request("a", "POST", `/conversations/${conv.id}/sequences/${seq.id}`, {});
    expect(started.status, await started.clone().text()).toBe(201);
    expect((await json(await k.request("a", "POST", `/conversations/${conv.id}/sequences/${seq.id}`, {}))).started).toBe(false);

    const t0 = Date.now();
    await k.drain();
    await sweepOnce(k.ctx, new Date(t0 + 1000));
    await k.drain();
    expect(await outBodies(conv.id)).toEqual(["Recordatorio 1"]);
    // The same minute again: nothing (the next step is in an hour).
    await sweepOnce(k.ctx, new Date(t0 + 2000));
    await k.drain();
    expect(await outBodies(conv.id)).toEqual(["Recordatorio 1"]);

    await receive("PN1", waText("51922", "wamid.s2", "ya pagué", Math.floor(t0 / 1000) + 5));
    await k.drain();
    await new Promise((r) => setTimeout(r, 50)); // the listener runs after the event
    expect((await k.rows<any>("SELECT status FROM koe_sequence_runs WHERE conversation_id = $1", [conv.id]))[0].status).toBe("stopped");
    expect(eventsOf("koe:sequence.stopped", conv.id)[0]!.data).toMatchObject({ reason: "reply" });
    await sweepOnce(k.ctx, new Date(t0 + 2 * HOUR));
    await k.drain();
    expect(await outBodies(conv.id)).toEqual(["Recordatorio 1"]);
  });

  it("sequences: the step job finds a reply the event missed, and skips text when the window is closed", async () => {
    const conv = await conversationOf("51922");
    const seq = (await json(await k.request("member", "POST", "/sequences", { name: "Otra", channelId: wa.id, steps: [{ delayMinutes: 5, text: "Paso" }, { delayMinutes: 5, templateId: "t-remind" }] }))).data;
    await k.request("member", "POST", `/conversations/${conv.id}/sequences/${seq.id}`, {});
    const [run] = await k.rows<any>("SELECT * FROM koe_sequence_runs WHERE sequence_id = $1", [seq.id]);
    // A reply with no event (as if it were lost).
    await k.rows(`INSERT INTO koe_messages (id, conversation_id, channel_id, direction, author_kind, kind, body, status, created_at) VALUES ('m-silent', $1, $2, 'in', 'contact', 'text', 'ok', 'received', now() + interval '1 minute')`, [conv.id, wa.id]);
    expect(await runSequenceStep(k.ctx, run.id, new Date(Date.now() + 10 * 60_000))).toBe("stopped");

    // Without stop-on-reply and with the window closed: the text step is skipped with its reason, the template goes.
    await k.request("member", "PATCH", `/sequences/${seq.id}`, { stopOnReply: false });
    await k.rows("UPDATE koe_conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1", [conv.id]);
    await k.request("member", "POST", `/conversations/${conv.id}/sequences/${seq.id}`, {});
    expect(await runSequenceStep(k.ctx, run.id, new Date(Date.now() + 6 * 60_000))).toBe("skipped");
    expect(await runSequenceStep(k.ctx, run.id, new Date(Date.now() + 12 * 60_000))).toBe("sent");
    const history = await k.rows<any>("SELECT reason FROM koe_conversation_events WHERE conversation_id = $1 AND type = 'sequence' ORDER BY created_at", [conv.id]);
    expect(history.map((h) => h.reason)).toContain("step 1 skipped: the free window is closed: a text step cannot go out");
    expect(eventsOf("koe:sequence.finished", conv.id)).toHaveLength(1);
  });

  it("the rule step starts a sequence", async () => {
    const conv = await conversationOf("51922");
    const seq = (await json(await k.request("member", "POST", "/sequences", { name: "Regla", channelId: wa.id, steps: [{ delayMinutes: 30, templateId: "t-remind" }] }))).data;
    const r = (await handler("start-sequence").run({ config: { sequenceId: seq.id }, event: { name: "koe:sla.breached", data: { conversationId: conv.id } }, rule, actorUserId: null }, k.ctx)) as any;
    expect(r.started).toBe(true);
    expect((await k.rows<any>("SELECT status, step FROM koe_sequence_runs WHERE id = $1", [r.runId]))[0]).toEqual({ status: "running", step: 0 });
  });

  // ── Sales and collections ───────────────────────────────────────────────

  it("promises: created by whoever sees the conversation, kept by hand, broken by the sweep", async () => {
    const conv = await conversationOf("51922");
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const kept = await k.request("a", "POST", `/conversations/${conv.id}/promises`, { amountCents: 15000, currency: "PEN", dueDate: day(3), reference: "INV-1" });
    expect(kept.status, await kept.clone().text()).toBe(201);
    const late = (await json(await k.request("a", "POST", `/conversations/${conv.id}/promises`, { amountCents: 5000, currency: "PEN", dueDate: day(-1) }))).data;
    expect((await k.request("a", "POST", `/conversations/${conv.id}/promises`, { amountCents: 5000, currency: "PEN", dueDate: "2026-02-31" })).status).toBe(422);
    expect(eventsOf("koe:promise.created")).toHaveLength(2);

    const keptId = (await json(kept)).data.id;
    expect((await k.request("a", "PATCH", `/promises/${keptId}`, { status: "kept" })).status).toBe(200);
    expect((await k.request("a", "PATCH", `/promises/${keptId}`, { status: "cancelled" })).status).toBe(409);
    expect(eventsOf("koe:promise.kept")).toHaveLength(1);

    await sweepOnce(k.ctx);
    await sweepOnce(k.ctx);
    expect((await k.rows<any>("SELECT status FROM koe_promises WHERE id = $1", [late.id]))[0].status).toBe("broken");
    expect(eventsOf("koe:promise.broken")).toHaveLength(1);
    await k.drain();

    const portfolio = await json(await k.request("a", "GET", "/collections/portfolio?status=all"));
    expect(portfolio.data.map((p: any) => p.amountCents)).toEqual([5000, 15000]); // by due date
    expect(portfolio.data[0].contact).toMatchObject({ phone: "51922" });
    expect((await k.request("a", "POST", `/conversations/${conv.id}/outcomes`, { kind: "paid", amountCents: 15000, currency: "PEN" })).status).toBe(201);
    expect((await json(await k.request("a", "GET", `/conversations/${conv.id}/outcomes`))).data[0]).toMatchObject({ kind: "paid", amountCents: 15000 });
    const pipeline = await json(await k.request("member", "GET", "/sales/pipeline"));
    expect(pipeline).toMatchObject({ data: [], crm: null });
  });

  // ── The sweep ───────────────────────────────────────────────────────────

  it("the sweep: snoozes wake, windows warn once and close once, SLAs breach, idle conversations resolve", async () => {
    const make = async (phone: string, id: string) => {
      await receive("PN1", waText(phone, id, "hola"));
      await k.drain();
      return (await conversationOf(phone)).id as string;
    };
    const snoozed = await make("51931", "wamid.w1");
    const expiring = await make("51932", "wamid.w2");
    const closed = await make("51933", "wamid.w3");
    const late = await make("51934", "wamid.w4");
    const idle = await make("51935", "wamid.w5");

    await k.rows(`UPDATE koe_conversations SET state = 'snoozed', snoozed_until = now() - interval '1 minute' WHERE id = $1`, [snoozed]);
    await k.rows(`UPDATE koe_conversations SET last_inbound_at = now() - interval '23 hours', window_expires_at = now() + interval '1 hour' WHERE id = $1`, [expiring]);
    await k.rows(`UPDATE koe_conversations SET last_inbound_at = now() - interval '25 hours', window_expires_at = now() - interval '1 hour' WHERE id = $1`, [closed]);
    await k.rows(`UPDATE koe_conversations SET first_response_due_at = now() - interval '1 minute', first_responded_at = NULL WHERE id = $1`, [late]);
    await k.rows(`UPDATE koe_conversations SET last_message_at = now() - interval '3 hours' WHERE id = $1`, [idle]);
    await k.request("admin", "PATCH", `/channels/${wa.id}`, { settings: { autoResolveHours: 2 } });

    const report = await sweepOnce(k.ctx);
    expect(report.errors).toEqual([]);
    await sweepOnce(k.ctx); // twice: nothing happens twice
    await k.drain();

    expect((await k.rows<any>("SELECT state, assignee_id FROM koe_conversations WHERE id = $1", [snoozed]))[0]).toEqual({ state: "human", assignee_id: ACTORS.a.id });
    expect(eventsOf("koe:window.expiring", expiring)).toHaveLength(1);
    expect(eventsOf("koe:window.expiring", expiring)[0]!.data).toMatchObject({ assigneeId: ACTORS.a.id });
    expect(eventsOf("koe:window.closed", closed)).toHaveLength(1);
    expect(eventsOf("koe:window.closed", expiring)).toHaveLength(0);
    expect((await k.rows<any>("SELECT sla_breached FROM koe_conversations WHERE id = $1", [late]))[0].sla_breached).toBe(true);
    expect(eventsOf("koe:sla.breached", late)).toEqual([{ name: "koe:sla.breached", data: expect.objectContaining({ kind: "first_response", teamId: support }) }]);
    expect((await k.rows<any>("SELECT state FROM koe_conversations WHERE id = $1", [idle]))[0].state).toBe("resolved");
    // Notices: the assignee hears about the window, the leads about the SLA.
    const notices = await k.rows<any>("SELECT user_id, kind, conversation_id FROM koe_notices WHERE conversation_id IN ($1, $2)", [expiring, late]);
    expect(notices).toEqual(expect.arrayContaining([{ user_id: ACTORS.a.id, kind: "window", conversation_id: expiring }, { user_id: ACTORS.member.id, kind: "sla", conversation_id: late }]));
    expect(notices.filter((n) => n.kind === "window")).toHaveLength(1);
    await k.request("admin", "PATCH", `/channels/${wa.id}`, { settings: { autoResolveHours: 24 * 90 } });
  });

  // ── Reports ─────────────────────────────────────────────────────────────

  it("reports: the shipped definitions are valid and name real columns", async () => {
    for (const r of koeReports) {
      expect(reportDefinitionProblem(r), r.id).toBeNull();
      const table = r.query.source.table!;
      const columns = new Set((await k.rows<any>("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [table])).map((c) => c.column_name));
      const fields = [...r.query.measures.flatMap((m) => (m.field ? [m.field] : [])), ...(r.query.groupBy ?? []).map((g) => g.field), ...(r.query.filters ?? []).map((f) => f.field)];
      for (const f of fields) expect(columns.has(f), `${r.id}: ${table}.${f}`).toBe(true);
    }
  });

  it("reports: the dashboard summary adds up", async () => {
    expect((await k.request("a", "GET", "/reports/summary")).status).toBe(403);
    await k.rows(`UPDATE koe_messages SET payload = payload || '{"pricing":{"category":"utility","billable":true}}'::jsonb WHERE author_kind = 'campaign'`);
    const answered = (await conversationOf("51931")).id;
    expect((await k.request("a", "POST", `/conversations/${answered}/messages`, { body: "Hola, ¿en qué te ayudo?" })).status).toBe(201);
    const res = await k.request("member", "GET", "/reports/summary");
    expect(res.status, await res.clone().text()).toBe(200);
    const s = (await json(res)).data;
    expect(s.collections).toEqual([{ currency: "PEN", promisedCents: 20000, keptCents: 15000, brokenCents: 5000, pendingCents: 0, cancelledCents: 0, promises: 2, kept: 1, broken: 1, keptRate: 0.5 }]);
    expect(s.campaigns.find((c: any) => c.name === "Novedades")).toMatchObject({ status: "done", sent: 3, skipped: 3, failed: 0 });
    expect(s.templateCosts).toMatchObject({ currency: "USD", pricing: "set" });
    expect(s.templateCosts.byCategory.find((c: any) => c.category === "utility")).toMatchObject({ billable: 3, cost: 0.06, unpriced: 0 });
    const perDay = s.conversationsPerChannelPerDay.filter((r: any) => r.channelId === wa.id).reduce((a: number, r: any) => a + r.conversations, 0);
    expect(perDay).toBe(Number((await k.rows<any>("SELECT count(*)::int AS n FROM koe_conversations WHERE channel_id = $1", [wa.id]))[0].n));
    expect(s.firstResponse.find((r: any) => r.teamId === support)).toMatchObject({ conversations: expect.any(Number) });
    expect(s.sla.find((r: any) => r.teamId === support).breached).toBeGreaterThanOrEqual(1);
    expect(s.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "paid", count: 1, amountCents: 15000 })]));
  });
});
