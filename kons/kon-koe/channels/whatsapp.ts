/**
 * WhatsApp Cloud API
 * ============================================================================
 *
 * In: the `whatsapp_business_account` webhook — messages, delivery statuses, template status and quality,
 * phone number quality and messaging limit. Out: `POST /{phone_number_id}/messages`.
 *
 * Media arrives as an id; its download URL expires in minutes and needs the token, so koe.media.ts fetches
 * it as soon as the message is stored. Outbound media is uploaded once and re-sent by id (valid ~30 days).
 *
 * A voice note is an `audio` with `voice: true`: it must be OGG with the Opus codec, mono, or WhatsApp shows
 * it as an audio file. A sticker is WebP 512×512, up to 100 KB static or 500 KB animated.
 * Verify sizes and codecs against Meta's current docs before relying on them.
 */

import { downloadMedia, graph } from "./graph";
import type {
  ChannelAdapter,
  ChannelAuth,
  InboundKind,
  InboundMedia,
  NormalizedEvent,
  OutboundMessage,
  SendResult,
} from "./types";

const MB = 1024 * 1024;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const when = (v: unknown): Date => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
};

function mediaOf(kind: InboundMedia["kind"], m: Obj): InboundMedia | undefined {
  const id = str(m.id);
  if (!id) return undefined;
  return {
    ref: id,
    kind,
    mime: str(m.mime_type),
    filename: str(m.filename),
    sha256: str(m.sha256),
    animated: m.animated === true,
  };
}

function parseMessage(phoneNumberId: string, m: Obj, contacts: Obj[]): NormalizedEvent | null {
  const from = str(m.from);
  const id = str(m.id);
  if (!from || !id) return null;
  const type = str(m.type) ?? "unsupported";
  const profileName = str(obj(contacts.find((c) => str(obj(c).wa_id) === from)?.profile).name);
  const context = obj(m.context);
  const referral = m.referral ? obj(m.referral) : undefined;

  let kind: InboundKind = "unsupported";
  let body: string | undefined;
  let media: InboundMedia | undefined;
  let payload: Obj = {};

  switch (type) {
    case "text":
      kind = "text";
      body = str(obj(m.text).body);
      break;
    case "image":
    case "video":
    case "document": {
      kind = type;
      const part = obj(m[type]);
      media = mediaOf(type, part);
      body = str(part.caption);
      break;
    }
    case "audio": {
      const part = obj(m.audio);
      kind = part.voice === true ? "voice" : "audio";
      media = mediaOf(kind, part);
      break;
    }
    case "sticker":
      kind = "sticker";
      media = mediaOf("sticker", obj(m.sticker));
      break;
    case "location": {
      kind = "location";
      const l = obj(m.location);
      payload = { latitude: l.latitude, longitude: l.longitude, name: l.name, address: l.address, url: l.url };
      body = [str(l.name), str(l.address)].filter(Boolean).join(", ") || undefined;
      break;
    }
    case "contacts":
      kind = "contacts";
      payload = { contacts: arr(m.contacts) };
      body = arr(m.contacts)
        .map((c) => str(obj(obj(c).name).formatted_name))
        .filter(Boolean)
        .join(", ");
      break;
    case "reaction": {
      kind = "reaction";
      const r = obj(m.reaction);
      payload = { messageExternalId: r.message_id, emoji: r.emoji ?? null };
      body = str(r.emoji);
      break;
    }
    case "interactive": {
      const i = obj(m.interactive);
      if (i.type === "button_reply") {
        kind = "button_reply";
        const b = obj(i.button_reply);
        payload = { id: b.id, title: b.title };
        body = str(b.title);
      } else if (i.type === "list_reply") {
        kind = "list_reply";
        const l = obj(i.list_reply);
        payload = { id: l.id, title: l.title, description: l.description };
        body = str(l.title);
      } else if (i.type === "nfm_reply") {
        // A WhatsApp Flow submitted: the answers come as a JSON string.
        kind = "button_reply";
        const n = obj(i.nfm_reply);
        let answers: unknown = null;
        try {
          answers = JSON.parse(String(n.response_json ?? "null"));
        } catch {
          answers = null;
        }
        payload = { flow: true, name: n.name, answers };
        body = str(n.body) ?? "Form sent";
      }
      break;
    }
    case "button": {
      // A quick-reply button of a template.
      kind = "button_reply";
      const b = obj(m.button);
      payload = { id: b.payload, title: b.text, template: true };
      body = str(b.text);
      break;
    }
    case "order":
      kind = "order";
      payload = obj(m.order);
      body = str(payload.text);
      break;
    default:
      kind = "unsupported";
      payload = { type, errors: arr(m.errors) };
  }

  return {
    type: "message",
    channelKind: "whatsapp",
    channelExternalId: phoneNumberId,
    contactExternalId: from,
    profile: { name: profileName, phone: from },
    externalMessageId: id,
    timestamp: when(m.timestamp),
    kind,
    body,
    payload,
    media,
    replyToExternalId: str(context.id),
    referral,
    // A conversation that starts from a click-to-WhatsApp ad opens the free-entry window.
    freeEntry: !!referral && str(referral.source_type) === "ad",
  };
}

export function parseWhatsApp(body: unknown): NormalizedEvent[] {
  const root = obj(body);
  if (root.object !== "whatsapp_business_account") return [];
  const out: NormalizedEvent[] = [];
  for (const entry of arr(root.entry)) {
    const accountId = str(obj(entry).id) ?? "";
    for (const change of arr(obj(entry).changes)) {
      const field = str(obj(change).field);
      const value = obj(obj(change).value);
      if (field === "messages") {
        const phoneNumberId = str(obj(value.metadata).phone_number_id);
        if (!phoneNumberId) continue;
        const contacts = arr(value.contacts).map(obj);
        for (const m of arr(value.messages)) {
          const e = parseMessage(phoneNumberId, obj(m), contacts);
          if (e) out.push(e);
        }
        for (const s of arr(value.statuses).map(obj)) {
          const status = str(s.status);
          const id = str(s.id);
          if (!id || (status !== "sent" && status !== "delivered" && status !== "read" && status !== "failed")) continue;
          const err = obj(arr(s.errors)[0]);
          const pricing = obj(s.pricing);
          out.push({
            type: "status",
            channelKind: "whatsapp",
            channelExternalId: phoneNumberId,
            externalMessageId: id,
            status,
            timestamp: when(s.timestamp),
            ...(status === "failed"
              ? { error: { code: String(err.code ?? "unknown"), message: String(obj(err.error_data).details ?? err.title ?? err.message ?? "Failed") } }
              : {}),
            ...(s.pricing ? { pricing: { category: str(pricing.category), billable: pricing.billable !== false } } : {}),
          });
        }
      } else if (field === "message_template_status_update") {
        out.push({
          type: "template_status",
          channelKind: "whatsapp",
          accountId,
          templateExternalId: value.message_template_id !== undefined ? String(value.message_template_id) : undefined,
          name: String(value.message_template_name ?? ""),
          language: str(value.message_template_language),
          status: String(value.event ?? "").toLowerCase(),
          reason: str(value.reason) ?? str(value.other_info && obj(value.other_info).description),
        });
      } else if (field === "message_template_quality_update") {
        out.push({
          type: "template_quality",
          channelKind: "whatsapp",
          accountId,
          templateExternalId: value.message_template_id !== undefined ? String(value.message_template_id) : undefined,
          name: String(value.message_template_name ?? ""),
          language: str(value.message_template_language),
          quality: String(value.new_quality_score ?? "UNKNOWN").toLowerCase(),
        });
      } else if (field === "phone_number_quality_update") {
        out.push({
          type: "account_update",
          channelKind: "whatsapp",
          accountId,
          detail: str(value.display_phone_number),
          quality: str(value.event)?.toLowerCase(),
          messagingLimit: str(value.current_limit),
        });
      } else if (field === "account_update" || field === "business_capability_update") {
        out.push({ type: "account_update", channelKind: "whatsapp", accountId, detail: str(value.event) ?? field });
      }
    }
  }
  return out;
}

/** The `messages` body for one outbound message. Exported for tests. */
export function whatsappPayload(m: OutboundMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { messaging_product: "whatsapp", recipient_type: "individual", to: m.to };
  if (m.replyToExternalId) base.context = { message_id: m.replyToExternalId };
  const media = (extra: Record<string, unknown> = {}) => {
    if (!m.media) throw new Error(`A ${m.kind} needs media`);
    return {
      ...(m.media.channelMediaId ? { id: m.media.channelMediaId } : { link: m.media.link }),
      ...extra,
    };
  };
  switch (m.kind) {
    case "text":
      return { ...base, type: "text", text: { body: m.body ?? "", preview_url: /https?:\/\//.test(m.body ?? "") } };
    case "image":
    case "video":
      return { ...base, type: m.kind, [m.kind]: media(m.media?.caption ?? m.body ? { caption: m.media?.caption ?? m.body } : {}) };
    case "document":
      return {
        ...base,
        type: "document",
        document: media({ ...(m.media?.filename ? { filename: m.media.filename } : {}), ...(m.media?.caption ?? m.body ? { caption: m.media?.caption ?? m.body } : {}) }),
      };
    case "audio":
    case "voice":
      // A voice note is an OGG/Opus audio; WhatsApp decides how to show it from the file.
      return { ...base, type: "audio", audio: media() };
    case "sticker":
      return { ...base, type: "sticker", sticker: media() };
    case "location":
      return { ...base, type: "location", location: m.location };
    case "contacts":
      return { ...base, type: "contacts", contacts: m.contacts ?? [] };
    case "reaction":
      return { ...base, type: "reaction", reaction: { message_id: m.reaction?.messageExternalId, emoji: m.reaction?.emoji ?? "" } };
    case "template":
      if (!m.template) throw new Error("A template message needs its template");
      return {
        ...base,
        type: "template",
        template: { name: m.template.name, language: { code: m.template.language }, components: m.template.components },
      };
    case "interactive": {
      const i = m.interactive;
      if (!i) throw new Error("An interactive message needs its content");
      const common = {
        body: { text: i.body },
        ...("header" in i && i.header ? { header: { type: "text", text: i.header } } : {}),
        ...("footer" in i && i.footer ? { footer: { text: i.footer } } : {}),
      };
      if (i.type === "buttons") {
        return {
          ...base,
          type: "interactive",
          interactive: { type: "button", ...common, action: { buttons: i.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) } },
        };
      }
      if (i.type === "list") {
        return { ...base, type: "interactive", interactive: { type: "list", ...common, action: { button: i.button.slice(0, 20), sections: i.sections } } };
      }
      return {
        ...base,
        type: "interactive",
        interactive: { type: "cta_url", body: { text: i.body }, action: { name: "cta_url", parameters: { display_text: i.text, url: i.url } } },
      };
    }
  }
}

export const whatsapp: ChannelAdapter = {
  kind: "whatsapp",
  capabilities: {
    kinds: ["text", "image", "audio", "voice", "video", "document", "sticker", "template", "interactive", "location", "contacts", "reaction"],
    maxBytes: { image: 5 * MB, audio: 16 * MB, voice: 16 * MB, video: 16 * MB, document: 100 * MB, sticker: 500 * 1024 },
    templates: true,
    interactive: true,
    readReceipts: true,
    typing: true,
  },
  parse: parseWhatsApp,

  async send(auth: ChannelAuth, message: OutboundMessage): Promise<SendResult> {
    const res = await graph<{ messages?: Array<{ id?: string }> }>({
      path: `${auth.externalId}/messages`,
      token: auth.accessToken,
      version: auth.graphVersion,
      json: whatsappPayload(message),
    });
    const id = res.messages?.[0]?.id;
    if (!id) throw new Error("WhatsApp answered without a message id");
    return { externalId: id };
  },

  async fetchMedia(auth: ChannelAuth, media: InboundMedia) {
    const info = await graph<{ url?: string; mime_type?: string; sha256?: string }>({
      path: media.ref,
      token: auth.accessToken,
      version: auth.graphVersion,
      query: { phone_number_id: auth.externalId },
    });
    if (!info.url) throw new Error("WhatsApp gave no URL for this media");
    const got = await downloadMedia(info.url, auth.accessToken);
    return { bytes: got.bytes, mime: info.mime_type ?? media.mime ?? got.mime, sha256: info.sha256 };
  },

  async uploadMedia(auth: ChannelAuth, bytes: Buffer, mime: string, filename?: string) {
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", mime);
    form.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename ?? "file");
    const res = await graph<{ id?: string }>({ path: `${auth.externalId}/media`, token: auth.accessToken, version: auth.graphVersion, form });
    if (!res.id) throw new Error("WhatsApp answered without a media id");
    // Uploaded media lives about 30 days; renew a little earlier.
    return { id: res.id, expiresAt: new Date(Date.now() + 29 * 24 * 3_600_000) };
  },

  async markRead(auth: ChannelAuth, _contact: string, messageExternalId: string) {
    await graph({
      path: `${auth.externalId}/messages`,
      token: auth.accessToken,
      version: auth.graphVersion,
      json: { messaging_product: "whatsapp", status: "read", message_id: messageExternalId },
    });
  },

  async typing(auth: ChannelAuth, _contact: string, messageExternalId?: string) {
    // WhatsApp's typing indicator rides on marking the contact's last message as read.
    if (!messageExternalId) return;
    await graph({
      path: `${auth.externalId}/messages`,
      token: auth.accessToken,
      version: auth.graphVersion,
      json: { messaging_product: "whatsapp", status: "read", message_id: messageExternalId, typing_indicator: { type: "text" } },
    });
  },
};

/** Templates of a WABA, every page. */
export async function listWhatsAppTemplates(token: string, wabaId: string, version: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await graph<{ data?: Array<Record<string, unknown>>; paging?: { cursors?: { after?: string }; next?: string } }>({
      path: `${wabaId}/message_templates`,
      token,
      version,
      query: { limit: 100, after, fields: "id,name,language,status,category,components,quality_score,rejected_reason" },
    });
    out.push(...(res.data ?? []));
    after = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

export async function createWhatsAppTemplate(
  token: string,
  wabaId: string,
  version: string,
  template: { name: string; language: string; category: string; components: unknown[] }
): Promise<{ id: string; status: string; category?: string }> {
  return graph<{ id: string; status: string; category?: string }>({
    path: `${wabaId}/message_templates`,
    token,
    version,
    json: { name: template.name, language: template.language, category: template.category.toUpperCase(), components: template.components },
  });
}

export async function deleteWhatsAppTemplate(token: string, wabaId: string, version: string, name: string): Promise<void> {
  await graph({ method: "DELETE", path: `${wabaId}/message_templates`, token, version, query: { name } });
}
