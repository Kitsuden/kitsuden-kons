/**
 * The one way out: send() and its delivery
 * ============================================================================
 *
 * Every outbound message — a person's reply, a bot's answer, a rule, a campaign — goes through `send()`.
 * There is no other path to Meta, so the rules hold for everyone:
 *
 *   1. the conversation is one the caller may see (row-level security);
 *   2. a bot or AI never writes in a conversation that is not in `bot` (a person has it, or it is queued);
 *   3. the contact is not blocked, and has not opted out of business-initiated messages;
 *   4. the channel supports the kind of message, and the media fits its limits;
 *   5. the window is open, or it is an approved template (WhatsApp), or a person writes with the
 *      human-agent tag (Messenger, Instagram, up to 7 days);
 *   6. the same idempotency key never sends twice.
 *
 * send() stores the message as `queued` and queues its delivery in the same transaction. The delivery job
 * checks rules 2 and 5 again (time passed, a person may have taken the conversation), uploads media the
 * channel does not have yet, calls the adapter at the channel's pace and records the result. Meta errors
 * are classified: retryable ones throw (the queue retries with backoff), permanent ones mark the message
 * `failed`, and an invalid token marks the channel `error` and tells the admins.
 *
 * Known limit: Meta has no idempotency key. If the process dies after Meta accepted a message and before
 * koe recorded it, the retry sends it again. The window is milliseconds; the queue's lease makes it rare.
 */

import { AppError, asSystem, PermanentError, queue, type QueueJob } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq } from "drizzle-orm";

import { adapterOf } from "./channels";
import { GraphError } from "./channels/graph";
import type { OutboundKind, OutboundMessage } from "./channels/types";
import type { Interactive } from "./channels/types";
import { authOf, channelById } from "./koe.channels";
import { dbOf, emit, newId, previewOf, QUEUES, STATUS_RANK, type Db } from "./koe.common";
import { changeState, type Actor } from "./koe.conversations";
import { channelOf, conversationChanged, publish } from "./koe.realtime";
import {
  koeChannels,
  koeConsents,
  koeContacts,
  koeConversations,
  koeIdentities,
  koeMedia,
  koeMembers,
  koeMessages,
  koeTemplates,
  type Channel,
  type Contact,
  type Conversation,
  type Media,
  type Message,
  type Template,
} from "./koe.schema";
import { botMaySpeak } from "./koe.states";
import { channelFileOf } from "./koe.media";
import { fillTemplate } from "./koe.templates";
import { checkWindow } from "./koe.window";

export interface SendInput {
  conversationId: string;
  author: Actor & { kind: "agent" | "bot" | "ai" | "rule" | "campaign" | "system" };
  kind: OutboundKind;
  body?: string;
  /** A koe_media id (uploaded through the media operations). */
  mediaId?: string;
  template?: { templateId: string; values?: Record<string, string>; headerMediaId?: string };
  interactive?: Interactive;
  location?: OutboundMessage["location"];
  contacts?: unknown[];
  reaction?: { messageId: string; emoji: string };
  replyToMessageId?: string;
  idempotencyKey?: string;
  /** A person replying to an unassigned conversation takes it (default true). */
  take?: boolean;
}

export type SendErrorCode = "BOT_SILENCED" | "WINDOW_CLOSED" | "TAG_NOT_ALLOWED" | "TEMPLATE_NOT_SUPPORTED" | "OPTED_OUT" | "BLOCKED" | "UNSUPPORTED" | "TOO_LARGE" | "TEMPLATE_NOT_APPROVED" | "NOT_YOURS";

function refuse(code: SendErrorCode, message: string, extra: Record<string, unknown> = {}): AppError {
  return AppError.conflict(message, { koe: code, ...extra });
}

async function one<T>(db: Db, q: Promise<T[]>): Promise<T | undefined> {
  const rows = await q;
  return rows[0];
}

/** The member's koe role inside a request (row security already limits what they see). */
async function roleOf(db: Db, userId: string | null | undefined, kitsudenRole?: string | null): Promise<string | null> {
  if (kitsudenRole === "admin") return "admin";
  if (!userId) return null;
  const m = await one<{ role: string }>(db, db.select({ role: koeMembers.role }).from(koeMembers).where(eq(koeMembers.userId, userId)).limit(1));
  return m?.role ?? null;
}

const baseMime = (m: string) => m.split(";")[0]!.trim().toLowerCase();

/** Media kinds each message kind may carry. */
const MEDIA_FOR: Record<string, string[]> = {
  image: ["image"],
  video: ["video"],
  document: ["document", "image", "video", "audio", "voice"],
  audio: ["audio", "voice"],
  voice: ["voice"],
  sticker: ["sticker"],
};
/** What WhatsApp plays as audio (verify against Meta's current docs). A browser's audio/webm is not one. */
const WHATSAPP_AUDIO = ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr"];

/** Why this media cannot go out as this kind on this channel, or null. */
export function mediaProblem(channel: Channel["kind"], kind: OutboundKind, media: Pick<Media, "kind" | "mime" | "playableKey">): string | null {
  const allowed = MEDIA_FOR[kind];
  if (allowed && !allowed.includes(media.kind)) return `A ${media.kind} cannot be sent as ${kind}`;
  const mime = baseMime(media.mime);
  if (channel === "whatsapp") {
    if (kind === "voice" && mime !== "audio/ogg") return "A WhatsApp voice note must be OGG/Opus: configure the media converter to send recordings";
    if (kind === "audio" && !WHATSAPP_AUDIO.includes(mime)) return `WhatsApp does not play ${mime}: configure the media converter or send it as a document`;
    if (kind === "sticker" && mime !== "image/webp") return "A WhatsApp sticker must be WebP";
  }
  if ((channel === "instagram" || channel === "messenger") && (kind === "voice" || kind === "audio") && mime === "audio/ogg" && !media.playableKey) {
    return `${channel} does not play OGG audio: configure the media converter so a playable copy exists`;
  }
  return null;
}

export interface SendContext {
  ctx: KonContext;
  db: Db;
  /** The Kitsuden role of the person, when a person sends. */
  userRole?: string | null;
}

export async function send(sc: SendContext, input: SendInput): Promise<Message> {
  const { ctx, db } = sc;
  if (input.idempotencyKey) {
    const existing = await one<Message>(db, db.select().from(koeMessages).where(eq(koeMessages.idempotencyKey, input.idempotencyKey)).limit(1));
    if (existing) {
      if (existing.conversationId !== input.conversationId) throw AppError.conflict("That idempotency key was used for another conversation");
      return existing;
    }
  }

  let conversation = await one<Conversation>(db, db.select().from(koeConversations).where(eq(koeConversations.id, input.conversationId)).limit(1));
  if (!conversation) throw AppError.notFound("Conversation not found");
  const channel = await one<Channel>(db, db.select().from(koeChannels).where(eq(koeChannels.id, conversation.channelId)).limit(1));
  if (!channel) throw AppError.notFound("Channel not found");
  if (channel.status === "disabled") throw refuse("UNSUPPORTED", "This channel is disabled");
  const contact = await one<Contact>(db, db.select().from(koeContacts).where(eq(koeContacts.id, conversation.contactId)).limit(1));
  if (contact?.blocked) throw refuse("BLOCKED", "This contact is blocked");

  // 2. Who may speak now.
  const author = input.author;
  if (author.kind === "bot" || author.kind === "ai") {
    if (!botMaySpeak(conversation.state)) throw refuse("BOT_SILENCED", `The bot does not write in a conversation that is ${conversation.state}`);
  } else if (author.kind === "agent") {
    const role = await roleOf(db, author.id, sc.userRole);
    if (!role) throw AppError.forbidden("You are not a koe member");
    const lead = role === "admin" || role === "supervisor";
    if (conversation.state === "human" && conversation.assigneeId !== author.id && !lead) {
      throw refuse("NOT_YOURS", "Someone else is answering this conversation");
    }
    if (conversation.state !== "human" && input.take !== false && author.id) {
      conversation = await changeState(ctx, db, conversation.id, { trigger: "assign", assigneeId: author.id, reason: "replied" }, author);
    }
  }

  // 4. The channel can carry it.
  const adapter = adapterOf(channel.kind);
  if (!adapter.capabilities.kinds.includes(input.kind)) throw refuse("UNSUPPORTED", `${channel.kind} cannot send ${input.kind} messages`);
  let media: Media | undefined;
  if (input.mediaId) {
    media = await one<Media>(db, db.select().from(koeMedia).where(eq(koeMedia.id, input.mediaId)).limit(1));
    if (!media) throw AppError.validation("Media not found");
    if (media.status !== "ready") throw AppError.validation("That media is still being prepared");
    const problem = mediaProblem(channel.kind, input.kind, media);
    if (problem) throw refuse("UNSUPPORTED", problem);
    const max = adapter.capabilities.maxBytes[input.kind];
    if (max && media.sizeBytes && media.sizeBytes > max) throw refuse("TOO_LARGE", `${channel.kind} accepts ${input.kind} up to ${Math.round(max / 1024)} KB`);
  } else if (["image", "audio", "voice", "video", "document", "sticker"].includes(input.kind)) {
    throw AppError.validation(`A ${input.kind} message needs mediaId`);
  }
  if (input.kind === "text" && !input.body?.trim()) throw AppError.validation("Write a message");
  if (input.kind === "interactive" && !input.interactive) throw AppError.validation("An interactive message needs `interactive`");

  // Templates: approved, of this channel, filled.
  let template: Template | undefined;
  let body = input.body ?? null;
  let payload: Record<string, unknown> = {};
  if (input.kind === "template") {
    if (!input.template) throw AppError.validation("A template message needs `template`");
    template = await one<Template>(db, db.select().from(koeTemplates).where(and(eq(koeTemplates.id, input.template.templateId), eq(koeTemplates.channelId, channel.id))).limit(1));
    if (!template) throw AppError.validation("Template not found on this channel");
    if (template.status !== "approved") throw refuse("TEMPLATE_NOT_APPROVED", `The template "${template.name}" is ${template.status}, not approved`);
    // Validates now (422 names what is missing); the delivery fills it again with the channel's media id.
    const filled = fillTemplate(template, { values: input.template.values ?? {}, headerMedia: input.template.headerMediaId ? { link: "pending" } : undefined }, contact ?? null);
    body = filled.preview;
    payload = { template: { name: template.name, language: template.language, category: template.category, values: input.template.values ?? {}, headerMediaId: input.template.headerMediaId ?? null } };
  }

  // 3. Consent: business-initiated messages need it.
  const consent = await one<{ status: string }>(
    db,
    db.select({ status: koeConsents.status }).from(koeConsents).where(and(eq(koeConsents.contactId, conversation.contactId), eq(koeConsents.channelId, channel.id))).limit(1)
  );
  if (author.kind === "campaign" && consent?.status !== "opted_in") throw refuse("OPTED_OUT", "This contact has not agreed to receive these messages");
  if (consent?.status === "opted_out" && (author.kind === "campaign" || author.kind === "rule" || template?.category === "marketing")) {
    throw refuse("OPTED_OUT", "This contact opted out");
  }

  // 5. The window.
  const decision = checkWindow(channel.kind, input.kind === "template" ? "template" : "free", author.kind, conversation.lastInboundAt, conversation.freeEntryUntil);
  if (!decision.ok) throw refuse(decision.code, decision.message);

  if (input.interactive) payload.interactive = input.interactive;
  if (input.location) payload.location = input.location;
  if (input.contacts) payload.contacts = input.contacts;
  if (input.reaction) payload.reaction = input.reaction;
  if (decision.tag) payload.tag = decision.tag;

  let replyToId: string | null = null;
  if (input.replyToMessageId) {
    const replied = await one<Message>(db, db.select().from(koeMessages).where(and(eq(koeMessages.id, input.replyToMessageId), eq(koeMessages.conversationId, conversation.id))).limit(1));
    if (!replied) throw AppError.validation("The message to reply to is not in this conversation");
    replyToId = replied.id;
  }

  const now = new Date();
  const [message] = (await db
    .insert(koeMessages)
    .values({
      id: newId(),
      conversationId: conversation.id,
      channelId: channel.id,
      direction: "out",
      authorKind: author.kind,
      authorId: author.id ?? null,
      kind: input.kind,
      body,
      payload,
      mediaId: media?.id ?? null,
      replyToId,
      status: "queued",
      statusRank: STATUS_RANK.queued,
      templateId: template?.id ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
    })
    .returning()) as Message[];

  const patch: Record<string, unknown> = { lastMessageAt: now, lastMessagePreview: previewOf(input.kind, body), updatedAt: now };
  if (author.kind === "agent") {
    patch.unreadCount = 0;
    if (!conversation.firstRespondedAt) patch.firstRespondedAt = now;
  }
  await db.update(koeConversations).set(patch).where(eq(koeConversations.id, conversation.id));

  await queue.dispatch(QUEUES.outbound, "deliver", { messageId: message!.id }, { attempts: 8, reason: `koe ${channel.kind} ${input.kind}` });
  publish(ctx, channelOf.conversation(conversation.id), { type: "message", conversationId: conversation.id, messageId: message!.id, direction: "out", status: "queued" });
  conversationChanged(ctx, conversation, "message");
  return message!;
}

// ── Delivery ────────────────────────────────────────────────────────────────

/** One message at a time per channel, at the channel's pace (Meta's per-number throughput). */
const paces = new Map<string, Promise<void>>();
async function paced<T>(channel: Channel, fn: () => Promise<T>): Promise<T> {
  const perSecond = Math.max(1, Math.min(500, channel.settings?.ratePerSecond ?? 20));
  const gap = 1000 / perSecond;
  const prior = paces.get(channel.id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  paces.set(channel.id, prior.then(() => mine));
  await prior;
  try {
    return await fn();
  } finally {
    setTimeout(release, gap);
  }
}

async function ensureChannelMedia(ctx: KonContext, db: Db, channel: Channel, media: Media): Promise<string> {
  if (media.metaMediaId && media.metaMediaChannelId === channel.id && media.metaMediaExpiresAt && media.metaMediaExpiresAt > new Date(Date.now() + 3_600_000)) {
    return media.metaMediaId;
  }
  const adapter = adapterOf(channel.kind);
  // The file this channel can play: Messenger gets the M4A copy of a voice note.
  const file = channelFileOf(media, channel.kind);
  if (!file) throw new PermanentError("The media has no stored file");
  if (!adapter.uploadMedia) throw new PermanentError(`${channel.kind} cannot upload media`);
  const bytes = await ctx.storage.get(file.key);
  if (!bytes) throw new PermanentError("The media file is gone from storage");
  const auth = await authOf(ctx, channel, "upload-media");
  const up = await adapter.uploadMedia(auth, bytes, file.mime, media.filename ?? undefined);
  await db.update(koeMedia).set({ metaMediaId: up.id, metaMediaChannelId: channel.id, metaMediaExpiresAt: up.expiresAt }).where(eq(koeMedia.id, media.id));
  return up.id;
}

async function fail(ctx: KonContext, db: Db, message: Message, code: string, error: string): Promise<void> {
  await db.update(koeMessages).set({ status: "failed", statusRank: STATUS_RANK.failed, errorCode: code, errorMessage: error.slice(0, 1000) }).where(eq(koeMessages.id, message.id));
  emit(ctx, "message.failed", { messageId: message.id, conversationId: message.conversationId, channelId: message.channelId, code, error: error.slice(0, 300), authorKind: message.authorKind });
  publish(ctx, channelOf.conversation(message.conversationId), { type: "status", messageId: message.id, status: "failed", code });
}

export async function deliver(ctx: KonContext, job: QueueJob<{ messageId?: string }>): Promise<void> {
  const id = job.payload?.messageId;
  if (!id) throw new PermanentError("job without messageId");
  const db = dbOf(ctx);
  await asSystem(async () => {
    const message = await one<Message>(db, db.select().from(koeMessages).where(eq(koeMessages.id, id)).limit(1));
    if (!message || message.status !== "queued") return; // gone, or already delivered by an earlier attempt
    const conversation = await one<Conversation>(db, db.select().from(koeConversations).where(eq(koeConversations.id, message.conversationId)).limit(1));
    const channel = await channelById(db, message.channelId);
    if (!conversation || !channel) return fail(ctx, db, message, "gone", "The conversation or channel no longer exists");
    if (channel.status === "disabled") return fail(ctx, db, message, "disabled", "The channel is disabled");

    // Again, at delivery: a person may have taken it, the window may have closed while it waited.
    if ((message.authorKind === "bot" || message.authorKind === "ai") && !botMaySpeak(conversation.state)) {
      return fail(ctx, db, message, "BOT_SILENCED", `Not sent: the conversation became ${conversation.state} before it went out`);
    }
    const decision = checkWindow(channel.kind, message.kind === "template" ? "template" : "free", message.authorKind, conversation.lastInboundAt, conversation.freeEntryUntil);
    if (!decision.ok) return fail(ctx, db, message, decision.code, decision.message);

    const identity = await one<{ externalId: string }>(db, db.select({ externalId: koeIdentities.externalId }).from(koeIdentities).where(eq(koeIdentities.id, conversation.identityId)).limit(1));
    if (!identity) return fail(ctx, db, message, "gone", "The contact's identity is gone");

    const adapter = adapterOf(channel.kind);
    const out: OutboundMessage = { to: identity.externalId, kind: message.kind as OutboundKind, body: message.body ?? undefined, tag: decision.tag };
    const p = message.payload as Record<string, unknown>;
    try {
      if (message.mediaId) {
        const media = await one<Media>(db, db.select().from(koeMedia).where(eq(koeMedia.id, message.mediaId)).limit(1));
        if (!media) return fail(ctx, db, message, "gone", "The media is gone");
        if (channel.kind === "webchat" || !adapter.uploadMedia) {
          // Channels that cannot take an upload (web chat, Instagram) fetch a short-lived signed URL.
          const file = channelFileOf(media, channel.kind);
          if (!file) return fail(ctx, db, message, "gone", "The media has no stored file");
          out.media = { link: await ctx.storage.getSignedDownloadUrl(file.key, 3600), mime: file.mime, filename: media.filename ?? undefined, caption: message.body ?? undefined };
        } else {
          out.media = { channelMediaId: await ensureChannelMedia(ctx, db, channel, media), mime: media.mime, filename: media.filename ?? undefined, caption: message.body ?? undefined };
        }
      }
      if (message.kind === "template") {
        const t = p.template as { name: string; language: string; values: Record<string, string>; headerMediaId?: string | null };
        const template = await one<Template>(db, db.select().from(koeTemplates).where(eq(koeTemplates.id, message.templateId!)).limit(1));
        if (!template) return fail(ctx, db, message, "gone", "The template is gone");
        if (template.status !== "approved") return fail(ctx, db, message, "TEMPLATE_NOT_APPROVED", `The template is ${template.status}`);
        const contact = await one<Contact>(db, db.select().from(koeContacts).where(eq(koeContacts.id, conversation.contactId)).limit(1));
        let headerMedia: { id?: string } | undefined;
        if (t.headerMediaId) {
          const hm = await one<Media>(db, db.select().from(koeMedia).where(eq(koeMedia.id, t.headerMediaId)).limit(1));
          if (!hm) return fail(ctx, db, message, "gone", "The header media is gone");
          headerMedia = { id: await ensureChannelMedia(ctx, db, channel, hm) };
        }
        const filled = fillTemplate(template, { values: t.values ?? {}, headerMedia }, contact ?? null);
        out.template = { name: template.name, language: template.language, components: filled.components };
      }
      if (p.interactive) out.interactive = p.interactive as Interactive;
      if (p.location) out.location = p.location as OutboundMessage["location"];
      if (p.contacts) out.contacts = p.contacts as unknown[];
      if (p.reaction) {
        const r = p.reaction as { messageId: string; emoji: string };
        const target = await one<Message>(db, db.select({ externalId: koeMessages.externalId }).from(koeMessages).where(eq(koeMessages.id, r.messageId)).limit(1));
        if (!target?.externalId) return fail(ctx, db, message, "invalid", "The message to react to has no channel id");
        out.reaction = { messageExternalId: target.externalId, emoji: r.emoji };
      }
      if (message.replyToId) {
        const replied = await one<Message>(db, db.select({ externalId: koeMessages.externalId }).from(koeMessages).where(eq(koeMessages.id, message.replyToId)).limit(1));
        if (replied?.externalId) out.replyToExternalId = replied.externalId;
      }

      const auth = await authOf(ctx, channel, "send-message");
      const result = await paced(channel, () => adapter.send(auth, out));
      const now = new Date();
      const status = channel.kind === "webchat" ? "delivered" : "sent";
      await db
        .update(koeMessages)
        .set({ status, statusRank: STATUS_RANK[status], externalId: result.externalId, sentAt: now, errorCode: null, errorMessage: null })
        .where(and(eq(koeMessages.id, message.id), eq(koeMessages.status, "queued")));
      await db.update(koeConversations).set({ lastOutboundAt: now }).where(eq(koeConversations.id, conversation.id));
      if (channel.kind === "webchat") {
        const visitor = identity.externalId;
        publish(ctx, channelOf.visitor(visitor), {
          type: "message",
          id: message.id,
          direction: "out",
          kind: message.kind,
          body: message.body,
          media: out.media ? { url: out.media.link, mime: out.media.mime, filename: out.media.filename } : null,
          interactive: out.interactive ?? null,
          at: now.toISOString(),
        });
      }
      emit(ctx, "message.sent", { messageId: message.id, conversationId: conversation.id, channelId: channel.id, kind: message.kind, authorKind: message.authorKind, authorId: message.authorId });
      publish(ctx, channelOf.conversation(conversation.id), { type: "status", messageId: message.id, status });
    } catch (err) {
      if (err instanceof GraphError) {
        if (err.authBroken) {
          await db.update(koeChannels).set({ status: "error", statusDetail: `Meta refused the credentials (${err.code}). Reconnect the channel.`, updatedAt: new Date() }).where(eq(koeChannels.id, channel.id));
          emit(ctx, "channel.broken", { channelId: channel.id, kind: channel.kind, code: err.code });
          return fail(ctx, db, message, err.code, err.message);
        }
        if (err.retryable && job.attempt < job.maxAttempts) throw err;
        return fail(ctx, db, message, err.code, err.details ? `${err.message} — ${err.details}` : err.message);
      }
      if (err instanceof PermanentError) return fail(ctx, db, message, "permanent", err.message);
      throw err;
    }
  });
}
