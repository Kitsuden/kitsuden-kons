/**
 * kon-koe: Messenger and Instagram adapters
 * ============================================================================
 *
 * The wire format is tested on its own (every webhook shape koe reads, every payload it builds, what each
 * adapter refuses to offer), then each channel walks the real routes on PGlite: a signed webhook in, a
 * person's answer out, and the window after 24 h (the human-agent tag for a person, nothing for the bot)
 * and after 7 days (nothing for anyone). Meta's Graph API is a recorder; no network.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { setGraphFetch } from "../../kons/kon-koe/channels/graph";
import { instagram, parseInstagram } from "../../kons/kon-koe/channels/instagram";
import { messenger, parseMessenger } from "../../kons/kon-koe/channels/messenger";
import { fetchAttachment, INSTAGRAM, MESSENGER, messagingPayloads } from "../../kons/kon-koe/channels/meta-messaging";
import type { ChannelAuth, NormalizedEvent } from "../../kons/kon-koe/channels/types";
import { parseWhatsApp } from "../../kons/kon-koe/channels/whatsapp";
import { parseAny } from "../../kons/kon-koe/koe.inbound";

import { APP_SECRET, koeBench } from "./helpers/koe-bench";
import { ACTORS } from "./helpers/safe-kons-bench";

const HOUR = 3_600_000;
const T = 1_763_200_000_000; // milliseconds, as Meta sends them

/** One `messaging` webhook body for Messenger (`page`) or Instagram. */
function body(object: "page" | "instagram", channelId: string, items: unknown[]) {
  return { object, entry: [{ id: channelId, time: T, messaging: items }] };
}
const from = (sender: string, channelId: string, extra: Record<string, unknown>, ts = T) => ({ sender: { id: sender }, recipient: { id: channelId }, timestamp: ts, ...extra });
const messages = (events: NormalizedEvent[]) => events.filter((e) => e.type === "message") as Array<Extract<NormalizedEvent, { type: "message" }>>;

// ════════════════════════════════════════════════════════════════════════════
// Wire format
// ════════════════════════════════════════════════════════════════════════════

describe("Messenger webhooks", () => {
  const PAGE = "1001";
  const events = parseMessenger(
    body("page", PAGE, [
      from("2001", PAGE, { message: { mid: "m_1", text: "hola", reply_to: { mid: "m_0" }, referral: { source: "ADS", type: "OPEN_THREAD", ref: "promo", ad_id: "ad9" } } }),
      from("2001", PAGE, { message: { mid: "m_2", text: "Sí", quick_reply: { payload: "PAY_TODAY" } } }),
      from("2001", PAGE, { message: { mid: "m_3", attachments: [{ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/a.jpg" } }, { type: "image", payload: { url: "https://scontent.xx.fbcdn.net/b.jpg" } }] } }),
      // A sticker during the transition: once as `sticker`, once as `image` with the same sticker_id.
      from("2001", PAGE, { message: { mid: "m_4", sticker_id: 369239263222822, attachments: [{ type: "sticker", payload: { url: "https://scontent.xx.fbcdn.net/s.png", sticker_id: 369239263222822 } }, { type: "image", payload: { url: "https://scontent.xx.fbcdn.net/s.png", sticker_id: 369239263222822 } }] } }),
      from("2001", PAGE, { message: { mid: "m_5", attachments: [{ type: "file", payload: { url: "https://cdn.fbsbx.com/v/t59/factura%20mayo.pdf?x=1" } }] } }),
      from("2001", PAGE, { message: { mid: "m_6", attachments: [{ type: "audio", payload: { url: "https://cdn.fbsbx.com/v/clip.mp4" } }] } }),
      from("2001", PAGE, { message: { mid: "m_7", text: "mira", attachments: [{ type: "fallback", payload: { url: "https://example.com/p", title: "Producto" } }] } }),
      from("2001", PAGE, { postback: { mid: "m_8", title: "Empezar", payload: "GET_STARTED", referral: { ref: "landing", source: "SHORTLINK", type: "OPEN_THREAD" } } }),
      from("2001", PAGE, { reaction: { mid: "m_out1", action: "react", reaction: "love", emoji: "❤️" } }),
      from("2001", PAGE, { read: { watermark: T + 5 } }),
      from("2001", PAGE, { delivery: { mids: ["m_out1", "m_out2"], watermark: T + 3 } }),
      // What the page sent itself, from koe or Meta's inbox: never the contact's.
      from(PAGE, "2001", { message: { mid: "m_echo", text: "eco", is_echo: true } }),
      from("2001", PAGE, { message: { mid: "m_echo2", text: "eco", is_echo: true } }),
      // Shapes koe does not read: skipped without a throw.
      from("2001", PAGE, { optin: { ref: "x" } }),
      from("2001", PAGE, { referral: { ref: "again", source: "SHORTLINK" } }),
      { sender: null, message: { mid: "m_x" } },
      "garbage",
    ])
  );

  it("parses each kind of message", () => {
    const m = messages(events);
    expect(m.map((e) => `${e.externalMessageId}:${e.kind}`)).toEqual([
      "m_1:text",
      "m_2:button_reply",
      "m_3:image",
      "m_3#2:image",
      "m_4:sticker",
      "m_5:document",
      "m_6:audio",
      "m_7:share",
      "m_8:postback",
      `reaction:m_out1:2001:${T}:reaction`,
    ]);
    expect(m[0]).toMatchObject({ channelKind: "messenger", channelExternalId: PAGE, contactExternalId: "2001", body: "hola", replyToExternalId: "m_0", referral: { source: "ADS", ad_id: "ad9" }, timestamp: new Date(T) });
    expect(m[1]).toMatchObject({ payload: { id: "PAY_TODAY", title: "Sí" }, body: "Sí" });
    expect(m[2]).toMatchObject({ media: { ref: "https://scontent.xx.fbcdn.net/a.jpg", kind: "image", expiring: true } });
    expect(m[3]).toMatchObject({ media: { ref: "https://scontent.xx.fbcdn.net/b.jpg" } });
    expect(m[4]).toMatchObject({ media: { kind: "sticker" }, payload: { stickerId: "369239263222822" } });
    expect(m[5]).toMatchObject({ media: { kind: "document", filename: "factura mayo.pdf" } });
    expect(m[7]).toMatchObject({ body: "mira", payload: { type: "fallback", url: "https://example.com/p", title: "Producto" } });
    expect(m[7]!.media).toBeUndefined();
    expect(m[8]).toMatchObject({ body: "Empezar", payload: { id: "GET_STARTED", payload: "GET_STARTED" }, referral: { ref: "landing" } });
    expect(m[9]).toMatchObject({ kind: "reaction", body: "❤️", payload: { messageExternalId: "m_out1", emoji: "❤️", action: "react" } });
  });

  it("read receipts and deliveries", () => {
    expect(events.filter((e) => e.type === "seen")).toEqual([{ type: "seen", channelKind: "messenger", channelExternalId: PAGE, contactExternalId: "2001", watermark: new Date(T + 5) }]);
    const statuses = events.filter((e) => e.type === "status");
    expect(statuses.map((s) => s.type === "status" && [s.externalMessageId, s.status])).toEqual([
      ["m_out1", "delivered"],
      ["m_out2", "delivered"],
    ]);
  });

  it("each adapter reads only its own object", () => {
    const page = body("page", PAGE, [from("2001", PAGE, { message: { mid: "m_1", text: "hola" } })]);
    const ig = body("instagram", "1789", [from("3001", "1789", { message: { mid: "ig_1", text: "hola" } })]);
    expect(parseInstagram(page)).toEqual([]);
    expect(parseMessenger(ig)).toEqual([]);
    expect(parseWhatsApp(page)).toEqual([]);
    expect(parseAny(page).map((e) => e.channelKind)).toEqual(["messenger"]);
    expect(parseAny(ig).map((e) => e.channelKind)).toEqual(["instagram"]);
    for (const junk of [null, undefined, 42, "x", [], { object: "page" }, { object: "page", entry: "x" }, { object: "page", entry: [{ id: PAGE, messaging: [null, 1, { sender: { id: "1" } }] }] }]) {
      expect(parseMessenger(junk)).toEqual([]);
    }
  });
});

describe("Instagram webhooks", () => {
  const IG = "17841400000000001";
  const events = parseInstagram(
    body("instagram", IG, [
      from("3001", IG, { message: { mid: "ig_1", text: "¡Qué buena historia!", reply_to: { story: { url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x", id: "st1" } } } }),
      from("3001", IG, { message: { mid: "ig_2", attachments: [{ type: "story_mention", payload: { url: "https://scontent.cdninstagram.com/v/clip.mp4?x=1" } }] } }),
      from("3001", IG, { message: { mid: "ig_3", attachments: [{ type: "share", payload: { url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=2" } }] } }),
      from("3001", IG, { message: { mid: "ig_4", attachments: [{ type: "ig_reel", payload: { url: "https://lookaside.fbsbx.com/r", title: "Reel", reel_video_id: 99 } }] } }),
      from("3001", IG, { message: { mid: "ig_5", is_unsupported: true } }),
      from("3001", IG, { message: { mid: "ig_6", is_deleted: true } }),
      from("3001", IG, { message: { mid: "ig_7", attachments: [{ type: "ephemeral" }] } }),
      from("3001", IG, { reaction: { mid: "ig_out1", action: "unreact" } }, T + 9),
      from("3001", IG, { read: { mid: "ig_out1" } }, T + 7),
      from("3001", IG, { postback: { mid: "ig_8", title: "Ver precios", payload: "PRICES" } }),
      from(IG, "3001", { message: { mid: "ig_echo", text: "eco", is_echo: true } }),
    ])
  );

  it("story replies and mentions carry their (expiring) media", () => {
    const m = messages(events);
    expect(m.map((e) => `${e.externalMessageId}:${e.kind}`)).toEqual(["ig_1:story_reply", "ig_2:story_mention", "ig_3:share", "ig_4:share", "ig_5:unsupported", "ig_7:unsupported", `reaction:ig_out1:3001:${T + 9}:reaction`, "ig_8:postback"]);
    expect(m[0]).toMatchObject({ channelKind: "instagram", channelExternalId: IG, body: "¡Qué buena historia!", payload: { storyId: "st1" }, media: { kind: "image", expiring: true } });
    expect(m[1]).toMatchObject({ media: { ref: "https://scontent.cdninstagram.com/v/clip.mp4?x=1", kind: "video", expiring: true } });
    expect(m[3]).toMatchObject({ payload: { type: "ig_reel", title: "Reel", id: "99" } });
    expect(m[5]).toMatchObject({ payload: { type: "ephemeral" } });
    expect(m[6]).toMatchObject({ kind: "reaction", payload: { messageExternalId: "ig_out1", emoji: null, action: "unreact" } });
  });

  it("a read receipt names a message, so the event's time is the watermark", () => {
    expect(events.find((e) => e.type === "seen")).toEqual({ type: "seen", channelKind: "instagram", channelExternalId: IG, contactExternalId: "3001", watermark: new Date(T + 7) });
  });
});

describe("outbound payloads", () => {
  const buttons = { type: "buttons" as const, header: "Pago", body: "¿Pagas hoy?", buttons: [1, 2, 3, 4].map((n) => ({ id: `b${n}`, title: `Opción número ${n} muy larga` })) };
  const list = { type: "list" as const, body: "Elige", button: "Ver", sections: [{ title: "A", rows: Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, title: `Fila ${i}` })) }, { rows: Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, title: `Otra ${i}` })) }] };
  const url = { type: "url" as const, body: "Tu recibo", text: "Ver recibo", url: "https://pay.test/r/1" };

  it("text inside the window, the human-agent tag outside it, replies by mid", () => {
    expect(messagingPayloads(MESSENGER, { to: "2001", kind: "text", body: "hola" })).toEqual([{ recipient: { id: "2001" }, messaging_type: "RESPONSE", message: { text: "hola" } }]);
    expect(messagingPayloads(INSTAGRAM, { to: "3001", kind: "text", body: "hola", tag: "HUMAN_AGENT", replyToExternalId: "ig_1" })).toEqual([
      { recipient: { id: "3001" }, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT", reply_to: { mid: "ig_1" }, message: { text: "hola" } },
    ]);
  });

  it("attachments by id or URL; a voice note is audio; the caption follows as text", () => {
    expect(messagingPayloads(MESSENGER, { to: "2001", kind: "image", media: { channelMediaId: "att1", mime: "image/png" } })).toEqual([
      { recipient: { id: "2001" }, messaging_type: "RESPONSE", message: { attachment: { type: "image", payload: { attachment_id: "att1" } } } },
    ]);
    const voice = messagingPayloads(INSTAGRAM, { to: "3001", kind: "voice", media: { link: "https://files.test/v.m4a?signed=1", mime: "audio/mp4" } });
    expect(voice).toHaveLength(1);
    expect(voice[0]).toMatchObject({ message: { attachment: { type: "audio", payload: { url: "https://files.test/v.m4a?signed=1" } } } });
    const doc = messagingPayloads(MESSENGER, { to: "2001", kind: "document", media: { channelMediaId: "att2", mime: "application/pdf", caption: "Tu factura" }, tag: "HUMAN_AGENT", replyToExternalId: "m_1" });
    expect(doc).toEqual([
      { recipient: { id: "2001" }, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT", reply_to: { mid: "m_1" }, message: { attachment: { type: "file", payload: { attachment_id: "att2" } } } },
      { recipient: { id: "2001" }, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT", message: { text: "Tu factura" } },
    ]);
    expect(() => messagingPayloads(MESSENGER, { to: "2001", kind: "image" })).toThrow(/needs media/);
  });

  it("buttons: the button template on Messenger, quick replies on Instagram", () => {
    const [fb] = messagingPayloads(MESSENGER, { to: "2001", kind: "interactive", interactive: buttons }) as any[];
    expect(fb.message.attachment).toMatchObject({ type: "template", payload: { template_type: "button", text: "Pago\n\n¿Pagas hoy?" } });
    expect(fb.message.attachment.payload.buttons).toHaveLength(3);
    expect(fb.message.attachment.payload.buttons[0]).toEqual({ type: "postback", title: "Opción número 1 muy ", payload: "b1" });
    const [ig] = messagingPayloads(INSTAGRAM, { to: "3001", kind: "interactive", interactive: buttons }) as any[];
    expect(ig.message.text).toBe("Pago\n\n¿Pagas hoy?");
    expect(ig.message.quick_replies).toHaveLength(4);
    expect(ig.message.quick_replies[0]).toEqual({ content_type: "text", title: "Opción número 1 muy ", payload: "b1" });
    // Text longer than the button template allows: quick replies on Messenger too.
    const [long] = messagingPayloads(MESSENGER, { to: "2001", kind: "interactive", interactive: { ...buttons, header: undefined, body: "x".repeat(700) } }) as any[];
    expect(long.message.quick_replies).toHaveLength(4);
  });

  it("a list becomes up to 13 quick replies; a link a web_url button (Messenger) or the link itself (Instagram)", () => {
    for (const f of [MESSENGER, INSTAGRAM]) {
      const [p] = messagingPayloads(f, { to: "1", kind: "interactive", interactive: list }) as any[];
      expect(p.message.text).toBe("Elige");
      expect(p.message.quick_replies).toHaveLength(13);
      expect(p.message.quick_replies[12]).toMatchObject({ payload: "b2", title: "Otra 2" });
    }
    const [fb] = messagingPayloads(MESSENGER, { to: "2001", kind: "interactive", interactive: url }) as any[];
    expect(fb.message.attachment.payload).toEqual({ template_type: "button", text: "Tu recibo", buttons: [{ type: "web_url", url: "https://pay.test/r/1", title: "Ver recibo" }] });
    const [ig] = messagingPayloads(INSTAGRAM, { to: "3001", kind: "interactive", interactive: url }) as any[];
    expect(ig.message).toEqual({ text: "Tu recibo\n\nhttps://pay.test/r/1" });
  });

  it("offers only what the channels carry", () => {
    for (const a of [messenger, instagram]) {
      for (const kind of ["template", "location", "contacts", "sticker", "reaction"] as const) {
        expect(a.capabilities.kinds).not.toContain(kind);
        expect(() => messagingPayloads(a === messenger ? MESSENGER : INSTAGRAM, { to: "1", kind })).toThrow(/cannot send/);
      }
      expect(a.capabilities.templates).toBe(false);
    }
    expect(messenger.capabilities.maxBytes.image).toBe(25 * 1024 * 1024);
    expect(instagram.capabilities.maxBytes.image).toBe(8 * 1024 * 1024);
    expect(messenger.uploadMedia).toBeTypeOf("function");
    // Instagram media goes out as a signed URL (deliver() does that when there is no uploadMedia).
    expect(instagram.uploadMedia).toBeUndefined();
  });
});

describe("adapter calls", () => {
  const calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string>; redirect?: string }> = [];
  let respond: (url: string) => Response = () => new Response("{}");
  beforeAll(() => {
    setGraphFetch(async (input, init) => {
      const url = String(input);
      let b: unknown = init?.body;
      if (typeof b === "string") b = JSON.parse(b);
      calls.push({ method: String(init?.method ?? "GET"), url, body: b, headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect });
      return respond(url);
    });
  });
  afterEach(() => {
    calls.length = 0;
  });
  afterAll(() => setGraphFetch(null));

  const fb: ChannelAuth = { externalId: "1001", accountId: null, accessToken: "page-token", graphVersion: "v23.0" };
  const ig: ChannelAuth = { externalId: "17841400000000001", accountId: "1001", accessToken: "page-token", graphVersion: "v23.0" };

  it("sends to the page (Messenger) or the account's page (Instagram), token in a header", async () => {
    respond = () => Response.json({ recipient_id: "2001", message_id: "m_out9" });
    expect(await messenger.send(fb, { to: "2001", kind: "text", body: "hola" })).toEqual({ externalId: "m_out9" });
    expect(await instagram.send(ig, { to: "3001", kind: "text", body: "hola" })).toEqual({ externalId: "m_out9" });
    expect(await instagram.send({ ...ig, accountId: null }, { to: "3001", kind: "text", body: "hola" })).toEqual({ externalId: "m_out9" });
    expect(calls.map((c) => c.url)).toEqual(["https://graph.facebook.com/v23.0/1001/messages", "https://graph.facebook.com/v23.0/1001/messages", "https://graph.facebook.com/v23.0/me/messages"]);
    expect(calls[0]!.headers.authorization).toBe("Bearer page-token");
    expect(calls.some((c) => c.url.includes("page-token"))).toBe(false);
  });

  it("a caption that fails does not resend the attachment", async () => {
    respond = () => (calls.length === 1 ? Response.json({ message_id: "m_att" }) : Response.json({ error: { code: 100, message: "bad" } }, { status: 400 }));
    expect(await messenger.send(fb, { to: "2001", kind: "image", media: { channelMediaId: "a1", mime: "image/png", caption: "mira" } })).toEqual({ externalId: "m_att" });
    expect(calls).toHaveLength(2);
  });

  it("uploads to message_attachments and re-sends by attachment_id", async () => {
    respond = () => Response.json({ attachment_id: "att-77" });
    const up = await messenger.uploadMedia!(fb, Buffer.from("png"), "image/png", "a.png");
    expect(up.id).toBe("att-77");
    expect(up.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 20 * 24 * HOUR);
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/1001/message_attachments");
    const form = calls[0]!.body as FormData;
    expect(JSON.parse(String(form.get("message")))).toEqual({ attachment: { type: "image", payload: { is_reusable: true } } });
    expect(form.get("filedata")).toBeInstanceOf(Blob);
  });

  it("read receipts and typing are sender actions", async () => {
    respond = () => Response.json({ recipient_id: "2001" });
    await messenger.markRead!(fb, "2001", "m_1");
    await instagram.typing!(ig, "3001");
    expect(calls.map((c) => c.body)).toEqual([
      { recipient: { id: "2001" }, sender_action: "mark_seen" },
      { recipient: { id: "3001" }, sender_action: "typing_on" },
    ]);
  });

  it("the profile: name, username and picture; nothing for an id that is not one", async () => {
    respond = () => Response.json({ name: "Lucía", username: "lu.cia", profile_pic: "https://scontent.cdninstagram.com/p.jpg" });
    expect(await instagram.profile!(ig, "3001")).toEqual({ name: "Lucía", username: "lu.cia", picture: "https://scontent.cdninstagram.com/p.jpg" });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/3001?fields=name%2Cusername%2Cprofile_pic");
    expect(await messenger.profile!(fb, "../1001/messages")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("downloads only from Meta's hosts, without the token, following redirects that stay there", async () => {
    respond = (url) =>
      url.startsWith("https://lookaside.fbsbx.com/")
        ? new Response(null, { status: 302, headers: { location: "https://scontent.xx.fbcdn.net/v/a.jpg" } })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    const got = await messenger.fetchMedia!(fb, { ref: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1", kind: "image", expiring: true });
    expect(got).toEqual({ bytes: Buffer.from([1, 2, 3]), mime: "image/jpeg" });
    expect(calls.map((c) => c.url)).toEqual(["https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1", "https://scontent.xx.fbcdn.net/v/a.jpg"]);
    expect(calls.every((c) => !c.headers.authorization && c.redirect === "manual")).toBe(true);

    calls.length = 0;
    await expect(fetchAttachment({ ref: "https://evil.test/a.jpg", kind: "image" })).rejects.toThrow(/not a Meta host/);
    expect(calls).toHaveLength(0);
    respond = () => new Response(null, { status: 302, headers: { location: "https://evil.test/a.jpg" } });
    await expect(fetchAttachment({ ref: "https://lookaside.fbsbx.com/x", kind: "image" })).rejects.toThrow(/not a Meta host/);
    respond = () => new Response("gone", { status: 404 });
    await expect(fetchAttachment({ ref: "https://lookaside.fbsbx.com/x", kind: "image" })).rejects.toMatchObject({ retryable: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The kon on a real database
// ════════════════════════════════════════════════════════════════════════════

describe("Messenger and Instagram end to end", () => {
  let k: Awaited<ReturnType<typeof koeBench>>;
  const json = async (res: Response): Promise<any> => res.json();
  const PAGE = "1001";
  const PSID = "2001";
  const IG = "17841400000000001";
  const IGSID = "3001";
  let out = 0;

  beforeAll(async () => {
    k = await koeBench();
    for (const [actor, role] of [["a", "agent"], ["member", "supervisor"]] as const) {
      const res = await k.request("admin", "PUT", `/members/${ACTORS[actor].id}`, { role, displayName: ACTORS[actor].name });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    k.respondGraph((call) => {
      if (call.url.endsWith("/messages")) return { body: { recipient_id: "x", message_id: `m_out${++out}` } };
      if (call.url.includes(`/${PSID}?`)) return { body: { name: "Lucía Pérez", profile_pic: "https://scontent.xx.fbcdn.net/p.jpg" } };
      if (call.url.includes(`/${IGSID}?`)) return { body: { username: "lu.cia" } };
      return { body: {} };
    });
  });

  afterAll(async () => {
    await k?.close();
  });

  async function connect(kind: "messenger" | "instagram", externalId: string, accountId?: string) {
    const res = await k.request("admin", "POST", "/channels", { kind, name: kind, externalId, accountId, accessToken: `EAAG-${kind}-token`, appSecret: APP_SECRET });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await json(res)).data as { id: string };
  }

  const sendAsBot = async (conversationId: string, text: string) => {
    const { send } = await import("../../kons/kon-koe/koe.send");
    return send({ ctx: k.ctx, db: k.ctx.db.instance }, { conversationId, author: { kind: "bot" }, kind: "text", body: text });
  };

  it("Messenger: a signed page webhook becomes a conversation with the contact's name", async () => {
    const ch = await connect("messenger", PAGE);
    const hook = body("page", PAGE, [from(PSID, PAGE, { message: { mid: "m_in1", text: "Hola, ¿tienen envíos?", referral: { source: "ADS", ad_id: "ad9", type: "OPEN_THREAD" } } }, Date.now())]);
    expect((await k.webhook(hook, "not-the-secret")).status).toBe(401);
    expect((await k.webhook(hook)).status).toBe(200);
    await k.drain();
    const [conv] = await k.rows<any>("SELECT * FROM koe_conversations WHERE channel_id = $1", [ch.id]);
    expect(conv).toMatchObject({ state: "queued", unread_count: 1 });
    expect(conv.metadata).toMatchObject({ referral: { ad_id: "ad9" } });
    expect(await k.rows("SELECT kind, body, external_id, direction FROM koe_messages WHERE conversation_id = $1", [conv.id])).toEqual([{ kind: "text", body: "Hola, ¿tienen envíos?", external_id: "m_in1", direction: "in" }]);
    // No name in the webhook: asked once to the User Profile API.
    const [contact] = await k.rows<any>("SELECT c.display_name, i.profile FROM koe_contacts c JOIN koe_identities i ON i.contact_id = c.id WHERE i.external_id = $1", [PSID]);
    expect(contact).toMatchObject({ display_name: "Lucía Pérez", profile: { picture: "https://scontent.xx.fbcdn.net/p.jpg" } });
    expect(k.opened).toContain("contact-profile");
  });

  it("Messenger: a person's answer goes to the page's messages, then delivery and read move it forward", async () => {
    const [conv] = await k.rows<any>("SELECT c.id FROM koe_conversations c JOIN koe_channels ch ON ch.id = c.channel_id WHERE ch.kind = 'messenger'");
    k.graphCalls.length = 0;
    const res = await k.request("a", "POST", `/conversations/${conv.id}/messages`, { body: "¡Sí, a todo el país!" });
    expect(res.status, await res.clone().text()).toBe(201);
    await k.drain();
    const sent = k.graphCalls.filter((c) => c.url.endsWith(`/${PAGE}/messages`));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ recipient: { id: PSID }, messaging_type: "RESPONSE", message: { text: "¡Sí, a todo el país!" } });
    const [msg] = await k.rows<any>("SELECT id, status, external_id FROM koe_messages WHERE conversation_id = $1 AND direction = 'out'", [conv.id]);
    expect(msg.status).toBe("sent");

    await k.webhook(body("page", PAGE, [from(PSID, PAGE, { delivery: { mids: [msg.external_id], watermark: Date.now() } })]));
    await k.drain();
    expect((await k.rows<any>("SELECT status FROM koe_messages WHERE id = $1", [msg.id]))[0].status).toBe("delivered");
    await k.webhook(body("page", PAGE, [from(PSID, PAGE, { read: { watermark: Date.now() + 1000 } }, Date.now() + 1000)]));
    await k.drain();
    expect((await k.rows<any>("SELECT status FROM koe_messages WHERE id = $1", [msg.id]))[0].status).toBe("read");
  });

  it("Messenger after 48 h: a person writes with the human-agent tag, the bot may not", async () => {
    const [conv] = await k.rows<any>("SELECT c.id FROM koe_conversations c JOIN koe_channels ch ON ch.id = c.channel_id WHERE ch.kind = 'messenger'");
    await k.rows("UPDATE koe_conversations SET last_inbound_at = now() - interval '48 hours' WHERE id = $1", [conv.id]);
    k.graphCalls.length = 0;
    const res = await k.request("a", "POST", `/conversations/${conv.id}/messages`, { body: "Perdona la demora, ya está tu envío." });
    expect(res.status, await res.clone().text()).toBe(201);
    await k.drain();
    expect(k.graphCalls.find((c) => c.url.endsWith(`/${PAGE}/messages`))!.body).toEqual({
      recipient: { id: PSID },
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
      message: { text: "Perdona la demora, ya está tu envío." },
    });

    // Hand it to the bot: the bot cannot use the tag.
    await k.rows("UPDATE koe_conversations SET state = 'bot', assignee_id = NULL WHERE id = $1", [conv.id]);
    await expect(sendAsBot(conv.id, "¿Algo más?")).rejects.toThrow(/Only a person may still answer/);
  });

  it("Messenger after 8 days: nobody may write", async () => {
    const [conv] = await k.rows<any>("SELECT c.id FROM koe_conversations c JOIN koe_channels ch ON ch.id = c.channel_id WHERE ch.kind = 'messenger'");
    await k.rows("UPDATE koe_conversations SET last_inbound_at = now() - interval '8 days' WHERE id = $1", [conv.id]);
    await expect(sendAsBot(conv.id, "¿Sigues ahí?")).rejects.toThrow(/window to answer this contact is closed/);
    await k.rows("UPDATE koe_conversations SET state = 'human', assignee_id = $2 WHERE id = $1", [conv.id, ACTORS.a.id]);
    const closed = await k.request("a", "POST", `/conversations/${conv.id}/messages`, { body: "¿Sigues ahí?" });
    expect(closed.status).toBe(409);
    expect(JSON.stringify(await json(closed))).toMatch(/WINDOW_CLOSED/);
  });

  it("Instagram: a story reply comes in, the answer goes out with quick replies and the tag after 24 h", async () => {
    const ch = await connect("instagram", IG, PAGE);
    const now = Date.now();
    await k.webhook(
      body("instagram", IG, [
        from(IGSID, IG, { message: { mid: "ig_in1", text: "¿Cuánto cuesta?", reply_to: { story: { url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1", id: "st1" } } } }, now),
        from(IG, IGSID, { message: { mid: "ig_echo", text: "eco", is_echo: true } }, now),
      ])
    );
    await k.drain();
    const [conv] = await k.rows<any>("SELECT * FROM koe_conversations WHERE channel_id = $1", [ch.id]);
    expect(await k.rows("SELECT kind, body, external_id FROM koe_messages WHERE conversation_id = $1", [conv.id])).toEqual([{ kind: "story_reply", body: "¿Cuánto cuesta?", external_id: "ig_in1" }]);
    expect((await k.rows<any>("SELECT kind, status FROM koe_media WHERE conversation_id = $1", [conv.id]))[0]).toMatchObject({ kind: "image" });
    expect((await k.rows<any>("SELECT display_name FROM koe_contacts c JOIN koe_identities i ON i.contact_id = c.id WHERE i.external_id = $1", [IGSID]))[0].display_name).toBe("lu.cia");

    k.graphCalls.length = 0;
    const res = await k.request("a", "POST", `/conversations/${conv.id}/messages`, {
      kind: "interactive",
      interactive: { type: "buttons", body: "Elige talla", buttons: [{ id: "s", title: "S" }, { id: "m", title: "M" }] },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    await k.drain();
    // The account's page sends it (accountId), with quick replies: Instagram has no button template here.
    expect(k.graphCalls.find((c) => c.url.endsWith(`/${PAGE}/messages`))!.body).toEqual({
      recipient: { id: IGSID },
      messaging_type: "RESPONSE",
      message: { text: "Elige talla", quick_replies: [{ content_type: "text", title: "S", payload: "s" }, { content_type: "text", title: "M", payload: "m" }] },
    });

    // The contact's quick reply comes back as a button reply with the id.
    await k.webhook(body("instagram", IG, [from(IGSID, IG, { message: { mid: "ig_in2", text: "M", quick_reply: { payload: "m" } } }, Date.now())]));
    await k.drain();
    expect((await k.rows<any>("SELECT kind, payload FROM koe_messages WHERE external_id = 'ig_in2'"))[0]).toMatchObject({ kind: "button_reply", payload: { id: "m", title: "M" } });

    await k.rows("UPDATE koe_conversations SET last_inbound_at = now() - interval '30 hours' WHERE id = $1", [conv.id]);
    k.graphCalls.length = 0;
    expect((await k.request("a", "POST", `/conversations/${conv.id}/messages`, { body: "Ya tenemos la M." })).status).toBe(201);
    await k.drain();
    expect(k.graphCalls.find((c) => c.url.endsWith(`/${PAGE}/messages`))!.body).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
    await k.rows("UPDATE koe_conversations SET state = 'bot', assignee_id = NULL WHERE id = $1", [conv.id]);
    await expect(sendAsBot(conv.id, "¿Algo más?")).rejects.toThrow(/Only a person may still answer/);
  });

  it("a failing profile lookup never drops the message", async () => {
    k.respondGraph((call) => (call.url.includes("/4001?") ? { status: 500, body: { error: { code: 2, message: "down" } } } : { body: {} }));
    await k.webhook(body("page", PAGE, [from("4001", PAGE, { message: { mid: "m_lost?", text: "¿hay alguien?" } }, Date.now())]));
    await k.drain();
    expect(await k.rows("SELECT body FROM koe_messages WHERE external_id = 'm_lost?'")).toEqual([{ body: "¿hay alguien?" }]);
    expect((await k.rows<any>("SELECT display_name FROM koe_contacts c JOIN koe_identities i ON i.contact_id = c.id WHERE i.external_id = '4001'"))[0].display_name).toBeNull();
  });
});
