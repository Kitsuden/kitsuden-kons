/**
 * Messenger and Instagram: one wire format, two channels
 * ============================================================================
 *
 * Facebook Pages (Messenger) and Instagram professional accounts speak the same Messenger Platform:
 *
 *   In   a webhook with `object: "page"` or `object: "instagram"`, where each `entry[].messaging[]` item is
 *        one thing that happened: a message (text, attachments, quick reply, story reply), a postback (a
 *        button of ours was pressed), a reaction, a read receipt, a delivery receipt. `entry.id` is the
 *        page id (Messenger) or the Instagram account id; `sender.id` is the contact's PSID or IGSID.
 *        Timestamps are milliseconds (WhatsApp's are seconds).
 *   Out  `POST /{id}/messages` with `recipient.id`, a `messaging_type` (RESPONSE inside the 24 h window,
 *        MESSAGE_TAG + `tag: "HUMAN_AGENT"` after it, which koe.window.ts allows only for a person), and a
 *        `message`. Typing and read receipts are a `sender_action` on the same endpoint.
 *
 * What differs is kept in `Flavor`: which `object` value is ours, which endpoint sends, and how buttons
 * and links are drawn (Messenger has the button template; on Instagram koe uses quick replies and a plain
 * link, which every Instagram client shows).
 *
 * Things neither channel has, and koe does not fake: templates, location and contact cards, stickers by
 * id. A caption does not exist either: the text goes as a second message right after the attachment.
 *
 * Attachment URLs from Meta are signed and expire, so koe.media.ts downloads them at once. They are only
 * fetched from Meta's hosts, following redirects only while they stay on those hosts.
 *
 * Verify the field names and limits against Meta's current docs before each release; the uncertain ones
 * are marked "verify".
 */

import { downloadMedia, graph, graphFetch, GraphError, isMetaMediaUrl, MAX_DOWNLOAD_BYTES } from "./graph";
import type {
  ChannelAuth,
  FetchedMedia,
  InboundKind,
  InboundMedia,
  InboundMessageEvent,
  Interactive,
  NormalizedEvent,
  OutboundMessage,
  SendResult,
} from "./types";

export type MessagingKind = "messenger" | "instagram";

export interface Flavor {
  kind: MessagingKind;
  /** The webhook's `object` value this channel answers to. */
  object: "page" | "instagram";
  /** Button template (Messenger) or quick replies (Instagram) for `buttons`. */
  buttonTemplate: boolean;
}

export const MESSENGER: Flavor = { kind: "messenger", object: "page", buttonTemplate: true };
export const INSTAGRAM: Flavor = { kind: "instagram", object: "instagram", buttonTemplate: false };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
/** Messenger Platform timestamps are milliseconds. */
const whenMs = (v: unknown): Date => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n) : new Date();
};

// ── In ──────────────────────────────────────────────────────────────────────

/** A story or a mention can be a photo or a clip; the CDN URL is the only hint before the download. */
function guessVisual(url: string): "image" | "video" {
  try {
    return /\.(mp4|mov|webm)$/i.test(new URL(url).pathname) ? "video" : "image";
  } catch {
    return "image";
  }
}

function filenameOf(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split("/").pop();
    return last && /\.[a-z0-9]{2,5}$/i.test(last) ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

interface Part {
  kind: InboundKind;
  body?: string;
  payload?: Obj;
  media?: InboundMedia;
}

/** One attachment → what koe stores. Unknown types become `unsupported` with their type kept. */
function partOf(a: Obj): Part {
  const type = str(a.type) ?? "unknown";
  const p = obj(a.payload);
  const url = str(p.url);
  const media = (kind: InboundMedia["kind"]): InboundMedia | undefined => (url ? { ref: url, kind, expiring: true, ...(kind === "document" ? { filename: filenameOf(url) } : {}) } : undefined);
  switch (type) {
    case "image":
      // Until 2026-08-30 Messenger also sent stickers as images with a `sticker_id` (verify).
      if (p.sticker_id !== undefined) return { kind: "sticker", media: media("sticker"), payload: { stickerId: str(p.sticker_id) } };
      return { kind: "image", media: media("image") };
    case "sticker":
      return { kind: "sticker", media: media("sticker"), payload: { stickerId: str(p.sticker_id) } };
    case "video":
      return { kind: "video", media: media("video") };
    case "audio":
      // Voice clips recorded in the apps arrive as `audio` too; nothing on the wire tells them apart.
      return { kind: "audio", media: media("audio") };
    case "file":
      return { kind: "document", media: media("document") };
    case "story_mention":
      return { kind: "story_mention", media: url ? { ref: url, kind: guessVisual(url), expiring: true } : undefined, payload: { url } };
    case "share":
    case "reel":
    case "ig_reel":
    case "post":
    case "ig_post":
    case "fallback":
      // A shared post, reel or link: kept as a link, not downloaded (it is someone else's content).
      return {
        kind: "share",
        body: str(p.title) ?? str(a.title),
        payload: { type, url: url ?? str(a.url), title: str(p.title) ?? str(a.title), id: str(p.id) ?? str(p.reel_video_id) },
      };
    case "location": {
      const c = obj(p.coordinates);
      return { kind: "location", payload: { latitude: c.lat, longitude: c.long }, body: str(a.title) };
    }
    default:
      // `ephemeral` (view-once media, no URL), product templates, bookings…
      return { kind: "unsupported", payload: { type } };
  }
}

function messageEvents(f: Flavor, channelId: string, contactId: string, at: Date, m: Obj, referral: Obj | undefined): InboundMessageEvent[] {
  const mid = str(m.mid);
  if (!mid) return [];
  const base = { type: "message" as const, channelKind: f.kind, channelExternalId: channelId, contactExternalId: contactId, timestamp: at, ...(referral ? { referral } : {}) };
  const text = str(m.text);
  const replyTo = obj(m.reply_to);
  const story = obj(replyTo.story);

  if (m.is_unsupported === true) return [{ ...base, externalMessageId: mid, kind: "unsupported", body: text, payload: { reason: "unsupported" } }];

  // An answer to the business's story: the story (expiring) comes with it.
  if (replyTo.story !== undefined) {
    const url = str(story.url);
    return [
      {
        ...base,
        externalMessageId: mid,
        kind: "story_reply",
        body: text,
        payload: { storyId: str(story.id), storyUrl: url },
        media: url ? { ref: url, kind: guessVisual(url), expiring: true } : undefined,
      },
    ];
  }

  const quick = obj(m.quick_reply);
  if (str(quick.payload)) {
    return [{ ...base, externalMessageId: mid, kind: "button_reply", body: text, payload: { id: str(quick.payload), title: text }, replyToExternalId: str(replyTo.mid) }];
  }

  const attachments = arr(m.attachments).map(obj);
  if (!attachments.length) {
    return [{ ...base, externalMessageId: mid, kind: text ? "text" : "unsupported", body: text, payload: text ? {} : { reason: "empty" }, replyToExternalId: str(replyTo.mid) }];
  }
  // Several photos in one message: one line each. The first keeps the message id (statuses and replies
  // point at it), the others get `<mid>#<n>`, so a resent webhook is still a duplicate.
  // Messenger also sends a sticker both as `sticker` and as `image` for a while: one is enough.
  const seenSticker = attachments.some((a) => a.type === "sticker");
  const parts = attachments.filter((a) => !(seenSticker && a.type === "image" && obj(a.payload).sticker_id !== undefined)).map(partOf);
  return parts.map((part, i) => ({
    ...base,
    externalMessageId: i === 0 ? mid : `${mid}#${i + 1}`,
    kind: part.kind,
    // The text of a shared link, or the words sent along with the attachment.
    body: i === 0 ? (text ?? part.body) : part.body,
    payload: part.payload ?? {},
    media: part.media,
    replyToExternalId: i === 0 ? str(replyTo.mid) : undefined,
  }));
}

/** Webhook body → events, for one flavor. Never throws; skips what it does not know. */
export function parseMessaging(f: Flavor, body: unknown): NormalizedEvent[] {
  const root = obj(body);
  if (root.object !== f.object) return [];
  const out: NormalizedEvent[] = [];
  for (const entry of arr(root.entry).map(obj)) {
    for (const item of arr(entry.messaging).map(obj)) {
      try {
        const sender = str(obj(item.sender).id);
        const channelId = str(entry.id) ?? str(obj(item.recipient).id);
        if (!sender || !channelId) continue;
        const at = whenMs(item.timestamp);
        const message = item.message === undefined ? undefined : obj(item.message);

        if (message) {
          // What the page or account itself sent (from koe, or from Meta's own inbox): not the contact's.
          // A deleted message has no deletion event in koe yet: skipped (verify `is_deleted` on Messenger).
          if (message.is_echo === true || sender === channelId || message.is_deleted === true) continue;
          const referral = message.referral === undefined ? undefined : obj(message.referral);
          out.push(...messageEvents(f, channelId, sender, at, message, referral));
          continue;
        }

        if (item.postback !== undefined) {
          const p = obj(item.postback);
          const payload = str(p.payload);
          out.push({
            type: "message",
            channelKind: f.kind,
            channelExternalId: channelId,
            contactExternalId: sender,
            // `mid` on postbacks since v11; older ones get a stable id from who and when.
            externalMessageId: str(p.mid) ?? `postback:${sender}:${at.getTime()}`,
            timestamp: at,
            kind: "postback",
            body: str(p.title),
            // `id` like a button reply, so a bot reads both the same way.
            payload: { id: payload, payload, title: str(p.title) },
            ...(p.referral !== undefined ? { referral: obj(p.referral) } : {}),
          });
          continue;
        }

        if (item.reaction !== undefined) {
          const r = obj(item.reaction);
          const target = str(r.mid);
          if (!target) continue;
          const action = str(r.action) ?? "react";
          const emoji = action === "unreact" ? null : (str(r.emoji) ?? null);
          out.push({
            type: "message",
            channelKind: f.kind,
            channelExternalId: channelId,
            contactExternalId: sender,
            // A reaction has no id of its own: who, on what, when.
            externalMessageId: `reaction:${target}:${sender}:${at.getTime()}`,
            timestamp: at,
            kind: "reaction",
            body: emoji ?? undefined,
            payload: { messageExternalId: target, emoji, reaction: str(r.reaction) ?? null, action },
          });
          continue;
        }

        if (item.read !== undefined) {
          // Messenger sends a watermark (everything before it was read); Instagram the `mid` of the last one
          // read, so the event's own time stands in for the watermark.
          const r = obj(item.read);
          out.push({ type: "seen", channelKind: f.kind, channelExternalId: channelId, contactExternalId: sender, watermark: r.watermark !== undefined ? whenMs(r.watermark) : at });
          continue;
        }

        if (item.delivery !== undefined) {
          const d = obj(item.delivery);
          const ts = d.watermark !== undefined ? whenMs(d.watermark) : at;
          for (const mid of arr(d.mids)) {
            const id = str(mid);
            if (id) out.push({ type: "status", channelKind: f.kind, channelExternalId: channelId, externalMessageId: id, status: "delivered", timestamp: ts });
          }
          continue;
        }

        // A referral on its own (an m.me / ig.me link or an ad opened in an existing thread) has no message
        // to hang on; the next message of the contact carries its own. Opt-ins, handovers, edits: skipped.
      } catch {
        // One odd item never loses the others.
      }
    }
  }
  return out;
}

// ── Out ─────────────────────────────────────────────────────────────────────

/** Meta's limits: button template text 640 chars, 3 buttons, titles 20; up to 13 quick replies (verify). */
export const LIMITS = { buttonText: 640, buttons: 3, buttonTitle: 20, quickReplies: 13, quickReplyTitle: 20, payload: 1000 };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function textOf(i: Interactive): string {
  const header = "header" in i ? i.header : undefined;
  const footer = "footer" in i ? i.footer : undefined;
  return [header, i.body, footer].filter((s): s is string => !!s && s.trim().length > 0).join("\n\n");
}

function quickReplies(text: string, options: Array<{ id: string; title: string }>): Obj {
  return {
    text,
    quick_replies: options.slice(0, LIMITS.quickReplies).map((o) => ({ content_type: "text", title: clip(o.title, LIMITS.quickReplyTitle), payload: clip(o.id, LIMITS.payload) })),
  };
}

function buttonTemplate(text: string, buttons: Obj[]): Obj {
  return { attachment: { type: "template", payload: { template_type: "button", text, buttons } } };
}

function interactiveMessage(f: Flavor, i: Interactive): Obj {
  const text = textOf(i);
  if (i.type === "buttons") {
    // The button template caps its text at 640 characters; longer ones go as quick replies.
    if (f.buttonTemplate && text.length <= LIMITS.buttonText) {
      return buttonTemplate(
        text,
        i.buttons.slice(0, LIMITS.buttons).map((b) => ({ type: "postback", title: clip(b.title, LIMITS.buttonTitle), payload: clip(b.id, LIMITS.payload) }))
      );
    }
    return quickReplies(text, i.buttons);
  }
  if (i.type === "list") return quickReplies(text, i.sections.flatMap((s) => s.rows).map((r) => ({ id: r.id, title: r.title })));
  // A link with a button on Messenger; on Instagram the link itself, which the app previews (verify:
  // Instagram's generic template could carry a web_url button, but caps its title at 80 characters).
  if (f.buttonTemplate && text.length <= LIMITS.buttonText) {
    return buttonTemplate(text, [{ type: "web_url", url: i.url, title: clip(i.text, LIMITS.buttonTitle) }]);
  }
  return { text: `${text}\n\n${i.url}` };
}

const ATTACHMENT_TYPE: Record<string, "image" | "audio" | "video" | "file"> = { image: "image", audio: "audio", voice: "audio", video: "video", document: "file" };

/**
 * The `messages` bodies for one outbound message, in order: the message itself, then its caption as a
 * separate text (neither channel has captions). Exported for tests.
 */
export function messagingPayloads(f: Flavor, m: OutboundMessage): Obj[] {
  const base: Obj = {
    recipient: { id: m.to },
    ...(m.tag ? { messaging_type: "MESSAGE_TAG", tag: m.tag } : { messaging_type: "RESPONSE" }),
  };
  const first: Obj = { ...base, ...(m.replyToExternalId ? { reply_to: { mid: m.replyToExternalId } } : {}) };
  switch (m.kind) {
    case "text":
      return [{ ...first, message: { text: m.body ?? "" } }];
    case "image":
    case "audio":
    case "voice":
    case "video":
    case "document": {
      if (!m.media) throw new Error(`A ${m.kind} needs media`);
      const payload = m.media.channelMediaId ? { attachment_id: m.media.channelMediaId } : { url: m.media.link, is_reusable: false };
      const caption = (m.media.caption ?? m.body)?.trim();
      return [
        { ...first, message: { attachment: { type: ATTACHMENT_TYPE[m.kind], payload } } },
        ...(caption ? [{ ...base, message: { text: caption } }] : []),
      ];
    }
    case "interactive":
      if (!m.interactive) throw new Error("An interactive message needs its content");
      return [{ ...first, message: interactiveMessage(f, m.interactive) }];
    default:
      throw new Error(`${f.kind} cannot send ${m.kind} messages`);
  }
}

/** Where messages go: the page (Messenger) or, for Instagram, the page that holds the account when koe
 * knows it (`accountId`), else `me` — both resolve with the page token (verify for Instagram Login tokens,
 * which live on graph.instagram.com). */
function endpointOf(f: Flavor, auth: ChannelAuth): string {
  if (f.kind === "messenger") return `${auth.externalId}/messages`;
  return `${auth.accountId || "me"}/messages`;
}

export async function sendMessaging(f: Flavor, auth: ChannelAuth, message: OutboundMessage): Promise<SendResult> {
  const [main, ...rest] = messagingPayloads(f, message);
  const res = await graph<{ message_id?: string }>({ path: endpointOf(f, auth), token: auth.accessToken, version: auth.graphVersion, json: main });
  const id = res.message_id;
  if (!id) throw new Error(`${f.kind} answered without a message id`);
  // The caption follows the attachment. If it fails, the attachment is already with the contact: throwing
  // would make the queue send it twice, so the caption is given up instead.
  for (const extra of rest) {
    await graph({ path: endpointOf(f, auth), token: auth.accessToken, version: auth.graphVersion, json: extra }).catch(() => undefined);
  }
  return { externalId: id };
}

export async function senderAction(f: Flavor, auth: ChannelAuth, contactExternalId: string, action: "mark_seen" | "typing_on" | "typing_off"): Promise<void> {
  await graph({ path: endpointOf(f, auth), token: auth.accessToken, version: auth.graphVersion, json: { recipient: { id: contactExternalId }, sender_action: action } });
}

/** Messenger's Attachment Upload API: upload once, send by `attachment_id` (verify the form fields). */
export async function uploadAttachment(auth: ChannelAuth, bytes: Buffer, mime: string, filename?: string): Promise<{ id: string; expiresAt: Date | null }> {
  const type = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "file";
  const form = new FormData();
  form.set("message", JSON.stringify({ attachment: { type, payload: { is_reusable: true } } }));
  form.set("filedata", new Blob([new Uint8Array(bytes)], { type: mime }), filename ?? "file");
  const res = await graph<{ attachment_id?: string }>({ path: `${auth.externalId}/message_attachments`, token: auth.accessToken, version: auth.graphVersion, form });
  if (!res.attachment_id) throw new Error("Messenger answered without an attachment id");
  // Meta documents no expiry for reusable attachments; koe uploads again after 30 days to be safe.
  return { id: res.attachment_id, expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000) };
}

/**
 * Downloads an attachment URL. The URLs are signed (no token needed, and none is sent: a CDN never sees the
 * page token). Meta's lookaside URLs may redirect to its CDN: each hop must stay on Meta's hosts.
 */
export async function fetchAttachment(media: InboundMedia): Promise<FetchedMedia> {
  let url = media.ref;
  for (let hop = 0; hop < 4; hop++) {
    if (!isMetaMediaUrl(url)) throw new GraphError("Media URL is not a Meta host", 0, "media_host", false, false);
    let res: Response;
    try {
      res = await graphFetch()(url, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new GraphError(`Media download failed: ${err instanceof Error ? err.name : "error"}`, 0, "network", true, false);
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!next) throw new GraphError("Media redirect without a location", res.status, "redirect", false, false);
      url = new URL(next, url).toString();
      continue;
    }
    // An expired story or attachment answers 403/404: permanent, nobody can fetch it any more.
    if (!res.ok) throw new GraphError(`Media download answered ${res.status}`, res.status, String(res.status), res.status >= 500 || res.status === 429, false);
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_DOWNLOAD_BYTES) throw new GraphError("Media too large", res.status, "too_large", false, false);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) throw new GraphError("Media too large", res.status, "too_large", false, false);
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || media.mime || "application/octet-stream";
    return { bytes, mime };
  }
  // Too many hops: let graph.ts's own downloader give the final answer on the last URL.
  const got = await downloadMedia(url, null);
  return { bytes: got.bytes, mime: got.mime };
}

/**
 * The contact's public profile: Messenger's User Profile API (`name`, `profile_pic`) or Instagram's
 * (`name`, `username`, `profile_pic`). Needs the contact to have written first, which is when koe asks.
 */
export async function fetchProfile(f: Flavor, auth: ChannelAuth, contactExternalId: string): Promise<{ name?: string; username?: string; picture?: string } | null> {
  if (!/^\d+$/.test(contactExternalId)) return null;
  const fields = f.kind === "instagram" ? "name,username,profile_pic" : "name,profile_pic";
  const res = await graph<{ name?: string; username?: string; profile_pic?: string }>({ path: contactExternalId, token: auth.accessToken, version: auth.graphVersion, query: { fields } });
  const out = { name: str(res?.name), username: str(res?.username), picture: str(res?.profile_pic) };
  return out.name || out.username || out.picture ? out : null;
}
