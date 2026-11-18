/**
 * kon-koe: the core — state machine, windows, WhatsApp in and out, inbox access, web chat
 * ============================================================================
 *
 * The pure parts are tested exhaustively (every state × trigger, every channel's window). The rest walks
 * the real routes on PGlite as a non-superuser with row-level security, with the queue drained through
 * koe's real handlers and Meta's Graph API replaced by a recorder.
 *
 * Actors (safe-kons-bench): `a` and `b` are koe agents in different teams, `member` is a koe supervisor,
 * `staff` is a Kitsuden editor who is NOT on koe, `admin` is a Kitsuden admin (a koe admin).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseWhatsApp, whatsappPayload } from "../../kons/kon-koe/channels/whatsapp";
import { sign, verifySignature, classify } from "../../kons/kon-koe/channels/graph";
import { ALL_STATES, ALL_TRIGGERS, TRANSITIONS, transition, TransitionError, botMaySpeak } from "../../kons/kon-koe/koe.states";
import { checkWindow, windowOf } from "../../kons/kon-koe/koe.window";
import { fillTemplate } from "../../kons/kon-koe/koe.templates";

import { APP_SECRET, koeBench, waBody, waText } from "./helpers/koe-bench";
import { ACTORS } from "./helpers/safe-kons-bench";

const HOUR = 3_600_000;

// ════════════════════════════════════════════════════════════════════════════
// Pure parts
// ════════════════════════════════════════════════════════════════════════════

describe("the state machine", () => {
  it("allows exactly the transitions in the table, for every state and trigger", () => {
    for (const from of ALL_STATES) {
      for (const trigger of ALL_TRIGGERS) {
        const targets = TRANSITIONS[from][trigger];
        if (!targets) {
          expect(() => transition({ from, trigger, to: "queued", assigneeId: "u", snoozedUntil: new Date(Date.now() + HOUR) }), `${from} ${trigger}`).toThrow(TransitionError);
          continue;
        }
        for (const to of targets) {
          const r = transition({ from, trigger, to, assigneeId: trigger === "reassign" ? "other" : "u", currentAssigneeId: "u", snoozedUntil: new Date(Date.now() + HOUR) });
          expect(r.to).toBe(to);
        }
      }
    }
  });

  it("a person is required to be human, a future date to snooze", () => {
    expect(() => transition({ from: "queued", trigger: "assign" })).toThrow(TransitionError);
    expect(() => transition({ from: "human", trigger: "snooze", currentAssigneeId: "u", snoozedUntil: new Date(Date.now() - 1) })).toThrow(TransitionError);
    expect(() => transition({ from: "human", trigger: "reassign", assigneeId: "u", currentAssigneeId: "u" })).toThrow(TransitionError);
  });

  it("snoozing keeps who had it; waking returns it to them", () => {
    const s = transition({ from: "human", trigger: "snooze", currentAssigneeId: "ana", snoozedUntil: new Date(Date.now() + HOUR) });
    expect(s.assigneeId).toBe("ana");
    expect(transition({ from: "snoozed", trigger: "wake", to: "human", currentAssigneeId: "ana" }).assigneeId).toBe("ana");
  });

  it("only the bot state lets the bot speak", () => {
    expect(ALL_STATES.filter(botMaySpeak)).toEqual(["bot"]);
  });
});

describe("windows", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * HOUR);

  it("WhatsApp: free for 24 h, then only templates", () => {
    expect(checkWindow("whatsapp", "free", "agent", ago(23), null, now)).toEqual({ ok: true });
    expect(checkWindow("whatsapp", "free", "agent", ago(25), null, now)).toMatchObject({ ok: false, code: "WINDOW_CLOSED" });
    expect(checkWindow("whatsapp", "template", "campaign", null, null, now)).toEqual({ ok: true });
    expect(checkWindow("whatsapp", "free", "agent", null, null, now)).toMatchObject({ ok: false });
  });

  it("WhatsApp: a free-entry point keeps it open 72 h", () => {
    const free = new Date(ago(30).getTime() + 72 * HOUR);
    expect(checkWindow("whatsapp", "free", "bot", ago(30), free, now)).toEqual({ ok: true });
    expect(windowOf("whatsapp", ago(30), free, now).expiresAt).toEqual(free);
  });

  it("Messenger and Instagram: 24 h, then the human-agent tag for a person only, up to 7 days", () => {
    for (const kind of ["messenger", "instagram"] as const) {
      expect(checkWindow(kind, "free", "bot", ago(2), null, now)).toEqual({ ok: true });
      expect(checkWindow(kind, "free", "agent", ago(48), null, now)).toEqual({ ok: true, tag: "HUMAN_AGENT" });
      for (const author of ["bot", "ai", "rule", "campaign"] as const) expect(checkWindow(kind, "free", author, ago(48), null, now)).toMatchObject({ ok: false, code: "TAG_NOT_ALLOWED" });
      expect(checkWindow(kind, "free", "agent", ago(24 * 8), null, now)).toMatchObject({ ok: false, code: "WINDOW_CLOSED" });
      expect(checkWindow(kind, "template", "agent", ago(1), null, now)).toMatchObject({ ok: false, code: "TEMPLATE_NOT_SUPPORTED" });
    }
  });

  it("web chat has no window", () => {
    expect(checkWindow("webchat", "free", "bot", null, null, now)).toEqual({ ok: true });
  });
});

describe("WhatsApp wire format", () => {
  it("parses messages of every kind, statuses and template updates", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PN1" },
                contacts: [{ wa_id: "519", profile: { name: "Lucía" } }],
                messages: [
                  waText("519", "m1", "hola"),
                  { from: "519", id: "m2", timestamp: "1", type: "audio", audio: { id: "A1", mime_type: "audio/ogg; codecs=opus", voice: true } },
                  { from: "519", id: "m3", timestamp: "1", type: "sticker", sticker: { id: "S1", mime_type: "image/webp", animated: true } },
                  { from: "519", id: "m4", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes", title: "Sí" } } },
                  { from: "519", id: "m5", timestamp: "1", type: "reaction", reaction: { message_id: "wamid.x", emoji: "👍" } },
                  { from: "519", id: "m6", timestamp: "1", type: "text", text: { body: "from an ad" }, referral: { source_type: "ad", source_id: "ad1" } },
                ],
                statuses: [{ id: "wamid.9", status: "failed", timestamp: "1", errors: [{ code: 131047, title: "Re-engagement message" }] }],
              },
            },
            { field: "message_template_status_update", value: { event: "APPROVED", message_template_id: 77, message_template_name: "pago", message_template_language: "es" } },
          ],
        },
      ],
    };
    const events = parseWhatsApp(body);
    const messages = events.filter((e) => e.type === "message");
    expect(messages.map((m) => m.type === "message" && m.kind)).toEqual(["text", "voice", "sticker", "button_reply", "reaction", "text"]);
    expect(messages[0]).toMatchObject({ contactExternalId: "519", profile: { name: "Lucía" }, body: "hola" });
    expect(messages[1]).toMatchObject({ media: { ref: "A1", kind: "voice" } });
    expect(messages[2]).toMatchObject({ media: { animated: true } });
    expect(messages[5]).toMatchObject({ freeEntry: true });
    expect(events.find((e) => e.type === "status")).toMatchObject({ status: "failed", error: { code: "131047" } });
    expect(events.find((e) => e.type === "template_status")).toMatchObject({ name: "pago", status: "approved", accountId: "waba-1" });
    expect(parseWhatsApp({ object: "page" })).toEqual([]);
    expect(parseWhatsApp(null)).toEqual([]);
  });

  it("builds outbound payloads: text, voice note, sticker, template, buttons", () => {
    expect(whatsappPayload({ to: "519", kind: "text", body: "hi" })).toMatchObject({ type: "text", text: { body: "hi" } });
    expect(whatsappPayload({ to: "519", kind: "voice", media: { channelMediaId: "M", mime: "audio/ogg" } })).toMatchObject({ type: "audio", audio: { id: "M" } });
    expect(whatsappPayload({ to: "519", kind: "sticker", media: { channelMediaId: "S", mime: "image/webp" } })).toMatchObject({ type: "sticker", sticker: { id: "S" } });
    expect(whatsappPayload({ to: "519", kind: "template", template: { name: "pago", language: "es", components: [] } })).toMatchObject({ template: { name: "pago", language: { code: "es" } } });
    const buttons = whatsappPayload({ to: "519", kind: "interactive", interactive: { type: "buttons", body: "¿Pagas hoy?", buttons: [{ id: "y", title: "Sí, hoy pago sin falta" }] } }) as any;
    expect(buttons.interactive.action.buttons[0].reply.title).toHaveLength(20);
  });

  it("signatures: the exact bytes, constant time", () => {
    const raw = '{"a":1}';
    expect(verifySignature(raw, sign(raw, "s3cret"), "s3cret")).toBe(true);
    expect(verifySignature(raw + " ", sign(raw, "s3cret"), "s3cret")).toBe(false);
    expect(verifySignature(raw, sign(raw, "other"), "s3cret")).toBe(false);
    expect(verifySignature(raw, undefined, "s3cret")).toBe(false);
    expect(verifySignature(raw, "sha256=zz", "s3cret")).toBe(false);
  });

  it("classifies Meta errors", () => {
    expect(classify(400, { error: { code: 131047, message: "x" } }).retryable).toBe(false);
    expect(classify(400, { error: { code: 130429, message: "x" } }).retryable).toBe(true);
    expect(classify(500, {}).retryable).toBe(true);
    const auth = classify(401, { error: { code: 190, message: "expired" } });
    expect(auth.authBroken).toBe(true);
    expect(auth.retryable).toBe(false);
  });

  it("fills templates and names what is missing", () => {
    const t = {
      name: "cobro",
      components: [
        { type: "HEADER" as const, format: "TEXT" as const, text: "Hola {{1}}" },
        { type: "BODY" as const, text: "Tu deuda de {{1}} vence el {{2}}" },
        { type: "BUTTONS" as const, buttons: [{ type: "URL", text: "Pagar", url: "https://pay.test/{{1}}" }] },
      ],
    };
    expect(() => fillTemplate(t, { values: { "1": "x" } })).toThrow(/needs: 2, button_2|needs: 2, button_0/);
    const f = fillTemplate(t, { values: { "1": "{{contact.name}}", "2": "20/11", button_0: "abc" } }, { displayName: "Ana" });
    expect(f.preview).toBe("Hola Ana\nTu deuda de Ana vence el 20/11");
    expect(f.components).toContainEqual({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "abc" }] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The kon on a real database
// ════════════════════════════════════════════════════════════════════════════

describe("the kon end to end", () => {
  let k: Awaited<ReturnType<typeof koeBench>>;
  const json = async (res: Response): Promise<any> => res.json();
  let support: string;
  let sales: string;
  let wa: { id: string; externalId: string };

  beforeAll(async () => {
    k = await koeBench();
    // Team: a (agent, support), b (agent, sales), member (supervisor).
    for (const [actor, role] of [["a", "agent"], ["b", "agent"], ["member", "supervisor"]] as const) {
      const res = await k.request("admin", "PUT", `/members/${ACTORS[actor].id}`, { role, displayName: ACTORS[actor].name });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    support = (await json(await k.request("member", "POST", "/teams", { slug: "support", name: "Support", assignment: "round_robin", slaFirstResponseS: 600 }))).data.id;
    sales = (await json(await k.request("member", "POST", "/teams", { slug: "sales", name: "Sales", purpose: "sales" }))).data.id;
    await k.request("member", "PUT", `/teams/${support}/members`, { userIds: [ACTORS.a.id] });
    await k.request("member", "PUT", `/teams/${sales}/members`, { userIds: [ACTORS.b.id] });
    const res = await k.request("admin", "POST", "/channels", {
      kind: "whatsapp",
      name: "Ventas WA",
      externalId: "PN1",
      accountId: "waba-1",
      accessToken: "EAAG-test-token-123",
      appSecret: APP_SECRET,
      defaultTeamId: support,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    wa = (await json(res)).data;
  });

  afterAll(async () => {
    await k?.close();
  });

  it("channels never return their credentials, and only admins connect them", async () => {
    const list = await json(await k.request("a", "GET", "/channels"));
    expect(JSON.stringify(list)).not.toMatch(/EAAG-test-token|test-app-secret|valueEncrypted/);
    expect(list.data[0]).toMatchObject({ hasAccessToken: true, hasAppSecret: true });
    expect((await k.request("member", "POST", "/channels", { kind: "webchat", name: "X" })).status).toBe(403);
    expect((await k.request("staff", "GET", "/conversations")).status).toBe(403); // an editor who is not on koe
    expect((await k.request("anon", "GET", "/conversations")).status).toBe(401);
  });

  it("Meta's verification answers the challenge only with the right token", async () => {
    await k.request("admin", "PUT", "/config/meta", { verifyToken: "a-long-verify-token-123" });
    const ok = await k.request("anon", "GET", "/webhooks/meta?hub.mode=subscribe&hub.verify_token=a-long-verify-token-123&hub.challenge=42");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("42");
    expect((await k.request("anon", "GET", "/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong-token-xxxxxxxx&hub.challenge=42")).status).toBe(403);
  });

  it("a forged webhook is refused; a signed one is stored once and processed by a job", async () => {
    const body = waBody("PN1", { contacts: [{ wa_id: "51911", profile: { name: "Lucía" } }], messages: [waText("51911", "wamid.in1", "Hola, quiero pagar")] });
    expect((await k.webhook(body, "not-the-secret")).status).toBe(401);
    expect((await k.webhook(body)).status).toBe(200);
    expect((await k.webhook(body)).status).toBe(200); // Meta resends: no second job
    expect(k.jobs.filter((j) => j.queue === "koe-inbound")).toHaveLength(1);
    await k.drain();
    const [conv] = await k.rows<any>("SELECT * FROM koe_conversations");
    // No bot on the channel → queued → the support team assigns round robin → Ana.
    expect(conv).toMatchObject({ state: "human", assignee_id: ACTORS.a.id, team_id: support, unread_count: 1 });
    expect(conv.first_response_due_at).not.toBeNull();
    expect(await k.rows("SELECT * FROM koe_messages")).toHaveLength(1);
    expect(k.events.map((e) => e.name)).toEqual(expect.arrayContaining(["koe:conversation.created", "koe:conversation.assigned", "koe:message.received"]));
  });

  it("row security: Ana sees it, Beto (another team) does not, the supervisor does", async () => {
    expect((await json(await k.request("a", "GET", "/conversations"))).data).toHaveLength(1);
    expect((await json(await k.request("b", "GET", "/conversations"))).data).toHaveLength(0);
    expect((await json(await k.request("member", "GET", "/conversations"))).data).toHaveLength(1);
    const [conv] = await k.rows<any>("SELECT id FROM koe_conversations");
    expect((await k.request("b", "GET", `/conversations/${conv.id}/messages`)).status).toBe(404);
    expect((await k.request("b", "POST", `/conversations/${conv.id}/messages`, { body: "x" })).status).toBe(404);
    // Realtime: the same rule decides who hears the conversation.
    expect(await k.authorize(`conversation:${conv.id}`, { id: ACTORS.a.id, role: "user" })).toBe(true);
    expect(await k.authorize(`conversation:${conv.id}`, { id: ACTORS.b.id, role: "user" })).toBe(false);
    expect(await k.authorize("inbox", { id: ACTORS.staff.id, role: "editor" })).toBe(false);
    expect(await k.authorize(`user:${ACTORS.a.id}`, { id: ACTORS.b.id, role: "user" })).toBe(false);
  });

  it("a reply goes out once, through the queue, and statuses only move forward", async () => {
    const [conv] = await k.rows<any>("SELECT id FROM koe_conversations");
    const res = await k.request("a", "POST", `/conversations/${conv.id}/messages`, { body: "¡Hola Lucía! Te ayudo.", idempotencyKey: "reply-0001" });
    expect(res.status, await res.clone().text()).toBe(201);
    const again = await k.request("a", "POST", `/conversations/${conv.id}/messages`, { body: "¡Hola Lucía! Te ayudo.", idempotencyKey: "reply-0001" });
    expect((await json(again)).data.id).toBe((await json(res)).data.id);
    await k.drain();
    const sent = k.graphCalls.filter((c) => c.url.endsWith("/PN1/messages"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ to: "51911", type: "text", text: { body: "¡Hola Lucía! Te ayudo." } });
    const [msg] = await k.rows<any>("SELECT * FROM koe_messages WHERE direction = 'out'");
    expect(msg).toMatchObject({ status: "sent" });
    expect(k.opened).toContain("send-message");

    // read arrives before delivered: delivered must not overwrite read.
    await k.webhook(waBody("PN1", { statuses: [{ id: msg.external_id, status: "read", timestamp: "2" }] }));
    await k.webhook(waBody("PN1", { statuses: [{ id: msg.external_id, status: "delivered", timestamp: "1" }] }));
    await k.drain();
    expect((await k.rows<any>("SELECT status FROM koe_messages WHERE id = $1", [msg.id]))[0].status).toBe("read");
    expect((await k.rows<any>("SELECT first_responded_at FROM koe_conversations"))[0].first_responded_at).not.toBeNull();
  });

  it("two people taking the same conversation: the second gets 409", async () => {
    const [conv] = await k.rows<any>("SELECT id FROM koe_conversations");
    await k.request("a", "POST", `/conversations/${conv.id}/release`, {});
    expect((await k.rows<any>("SELECT state FROM koe_conversations"))[0].state).toBe("queued");
    const [r1, r2] = [await k.request("a", "POST", `/conversations/${conv.id}/take`, {}), await k.request("member", "POST", `/conversations/${conv.id}/take`, {})];
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(409);
    const history = await json(await k.request("member", "GET", `/conversations/${conv.id}/events`));
    expect(history.data.map((e: any) => e.to_state ?? e.toState)).toEqual(expect.arrayContaining(["queued", "human"]));
  });

  it("after 24 h only an approved template goes out", async () => {
    const [conv] = await k.rows<any>("SELECT id FROM koe_conversations");
    await k.rows("UPDATE koe_conversations SET last_inbound_at = now() - interval '25 hours'");
    const closed = await k.request("a", "POST", `/conversations/${conv.id}/messages`, { body: "¿Sigues ahí?" });
    expect(closed.status).toBe(409);
    const problem = await json(closed);
    expect(JSON.stringify(problem)).toMatch(/WINDOW_CLOSED|only an approved template/);
    const window = await json(await k.request("a", "GET", `/conversations/${conv.id}/window`));
    expect(window.data).toMatchObject({ open: false, personMayWrite: false });

    await k.rows(
      `INSERT INTO koe_templates (id, channel_id, name, language, category, status, components) VALUES
       ('t-ok', $1, 'recordatorio', 'es', 'utility', 'approved', '[{"type":"BODY","text":"Hola {{1}}, ¿seguimos?"}]'),
       ('t-pending', $1, 'promo', 'es', 'marketing', 'pending', '[{"type":"BODY","text":"Promo"}]')`,
      [wa.id]
    );
    expect((await k.request("a", "POST", `/conversations/${conv.id}/messages`, { kind: "template", template: { templateId: "t-pending" } })).status).toBe(409);
    expect((await k.request("a", "POST", `/conversations/${conv.id}/messages`, { kind: "template", template: { templateId: "t-ok" } })).status).toBe(422);
    const ok = await k.request("a", "POST", `/conversations/${conv.id}/messages`, { kind: "template", template: { templateId: "t-ok", values: { "1": "{{contact.name}}" } } });
    expect(ok.status, await ok.clone().text()).toBe(201);
    k.graphCalls.length = 0;
    await k.drain();
    expect(k.graphCalls[0]!.body).toMatchObject({ type: "template", template: { name: "recordatorio", components: [{ type: "body", parameters: [{ type: "text", text: "Lucía" }] }] } });
  });

  it("a template status webhook updates the copy", async () => {
    await k.webhook({ object: "whatsapp_business_account", entry: [{ id: "waba-1", changes: [{ field: "message_template_status_update", value: { event: "REJECTED", message_template_name: "promo", message_template_language: "es", reason: "INVALID_FORMAT" } }] }] });
    await k.drain();
    expect((await k.rows<any>("SELECT status, rejected_reason FROM koe_templates WHERE id = 't-pending'"))[0]).toEqual({ status: "rejected", rejected_reason: "INVALID_FORMAT" });
  });

  it("a revoked token marks the channel broken and the message failed, without retrying", async () => {
    const [conv] = await k.rows<any>("SELECT id FROM koe_conversations");
    await k.rows("UPDATE koe_conversations SET last_inbound_at = now()");
    k.respondGraph(() => ({ status: 401, body: { error: { code: 190, message: "Session expired" } } }));
    await k.request("a", "POST", `/conversations/${conv.id}/messages`, { body: "hola" });
    await k.drain();
    expect((await k.rows<any>("SELECT status FROM koe_channels"))[0].status).toBe("error");
    expect((await k.rows<any>("SELECT status, error_code FROM koe_messages ORDER BY created_at DESC LIMIT 1"))[0]).toEqual({ status: "failed", error_code: "190" });
    expect(k.events.some((e) => e.name === "koe:channel.broken")).toBe(true);
    k.respondGraph((call) => ({ body: call.url.includes("/messages") ? { messages: [{ id: `wamid.r${Date.now()}` }] } : {} }));
    await k.request("admin", "PATCH", `/channels/${wa.id}`, { accessToken: "EAAG-new-token-456" });
    expect((await k.rows<any>("SELECT status FROM koe_channels"))[0].status).toBe("active");
  });

  it("the bot never writes over a person, even if its message was queued before", async () => {
    const [conv] = await k.rows<any>("SELECT id FROM koe_conversations");
    // Put it with the bot, queue a bot message by hand, then a person takes it before delivery.
    await k.rows("UPDATE koe_conversations SET state = 'bot', assignee_id = NULL WHERE id = $1", [conv.id]);
    const { send } = await import("../../kons/kon-koe/koe.send");
    await send({ ctx: k.ctx, db: k.ctx.db.instance }, { conversationId: conv.id, author: { kind: "bot" }, kind: "text", body: "Soy el bot" });
    await k.request("a", "POST", `/conversations/${conv.id}/take`, {});
    k.graphCalls.length = 0;
    await k.drain();
    expect(k.graphCalls.filter((c) => JSON.stringify(c.body).includes("Soy el bot"))).toHaveLength(0);
    expect((await k.rows<any>("SELECT status, error_code FROM koe_messages WHERE body = 'Soy el bot'"))[0]).toEqual({ status: "failed", error_code: "BOT_SILENCED" });
    await expect(send({ ctx: k.ctx, db: k.ctx.db.instance }, { conversationId: conv.id, author: { kind: "ai" }, kind: "text", body: "x" })).rejects.toThrow(/does not write/);
  });

  it("opt-out by keyword blocks campaigns and marketing, and is recorded", async () => {
    await k.webhook(waBody("PN1", { messages: [waText("51911", "wamid.stop", "BAJA")] }));
    await k.drain();
    expect((await k.rows<any>("SELECT status, source FROM koe_consents"))[0]).toEqual({ status: "opted_out", source: "keyword" });
    const [conv] = await k.rows<any>("SELECT id FROM koe_conversations");
    const { send } = await import("../../kons/kon-koe/koe.send");
    await expect(send({ ctx: k.ctx, db: k.ctx.db.instance }, { conversationId: conv.id, author: { kind: "campaign" }, kind: "template", template: { templateId: "t-ok", values: { "1": "x" } } })).rejects.toThrow(/agreed|opted out/);
  });

  it("starting a conversation by template for collections takes it for the person", async () => {
    const contact = (await k.rows<any>("SELECT id FROM koe_contacts"))[0];
    await k.rows("INSERT INTO koe_consents (id, contact_id, channel_id, status, source) VALUES ('c2', $1, $2, 'opted_in', 'form') ON CONFLICT (contact_id, channel_id) DO UPDATE SET status = 'opted_in'", [contact.id, wa.id]);
    await k.request("member", "POST", `/conversations/${(await k.rows<any>("SELECT id FROM koe_conversations"))[0].id}/resolve`, {});
    const res = await k.request("b", "POST", `/contacts/${contact.id}/start`, { channelId: wa.id, templateId: "t-ok", values: { "1": "Lucía" } });
    // Beto cannot see the contact (its conversations are another team's).
    expect(res.status).toBe(404);
    const ok = await k.request("member", "POST", `/contacts/${contact.id}/start`, { channelId: wa.id, templateId: "t-ok", values: { "1": "Lucía" } });
    expect(ok.status, await ok.clone().text()).toBe(201);
    expect((await k.rows<any>("SELECT state, assignee_id FROM koe_conversations"))[0]).toEqual({ state: "human", assignee_id: ACTORS.member.id });
  });

  it("web chat: a visitor writes, a person answers, the visitor hears it on their channel", async () => {
    const ch = (await json(await k.request("admin", "POST", "/channels", { kind: "webchat", name: "Web", settings: { greeting: "¡Hola!" } }))).data;
    const visitorId = "visitor-".padEnd(40, "z");
    expect((await json(await k.request("anon", "GET", `/public/webchat/${ch.externalId}/config`))).data).toMatchObject({ greeting: "¡Hola!" });
    const sent = await k.request("anon", "POST", `/public/webchat/${ch.externalId}/messages`, { visitorId, clientMessageId: "abc123", text: "¿Tienen envíos?" });
    expect(sent.status, await sent.clone().text()).toBe(201);
    const { channel } = (await json(sent)).data;
    // Same client id: the same message.
    await k.request("anon", "POST", `/public/webchat/${ch.externalId}/messages`, { visitorId, clientMessageId: "abc123", text: "¿Tienen envíos?" });
    await k.drain();
    const conv = (await k.rows<any>("SELECT * FROM koe_conversations WHERE channel_id = $1", [ch.id]))[0];
    expect(await k.rows("SELECT 1 FROM koe_messages WHERE conversation_id = $1", [conv.id])).toHaveLength(1);
    // No team on the channel: unassigned without team → every agent sees it.
    await k.request("b", "POST", `/conversations/${conv.id}/messages`, { body: "¡Sí, a todo el país!" });
    await k.drain();
    expect(k.broadcasts.find((b) => b.channel === `kon:koe:${channel.replace("kon:koe:", "")}` && b.message.body === "¡Sí, a todo el país!")).toBeDefined();
    expect(await k.authorize(channel.replace("kon:koe:", ""), { id: null, role: null })).toBe(true);
    const history = await json(await k.request("anon", "GET", `/public/webchat/${ch.externalId}/messages?visitorId=${visitorId}`));
    expect(history.data.map((m: any) => m.body)).toEqual(["¿Tienen envíos?", "¡Sí, a todo el país!"]);
    expect(JSON.stringify(history)).not.toMatch(new RegExp(ACTORS.b.id));
    // Another visitor reads nothing.
    expect((await json(await k.request("anon", "GET", `/public/webchat/${ch.externalId}/messages?visitorId=${"other-".padEnd(40, "y")}`))).data).toEqual([]);
  });
});
