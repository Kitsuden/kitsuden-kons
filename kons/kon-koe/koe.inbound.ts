/**
 * The way in: webhooks, then one job per body
 * ============================================================================
 *
 *   1. The webhook route checks the signature over the raw body, stores the body in `koe_webhook_events`
 *      with a unique key (a resent webhook is a no-op) and queues a job, in one transaction. It answers 200
 *      at once: Meta retries for days if it does not, and nothing slow happens inside the request.
 *   2. The job (`processWebhook`) parses the body with the channel's adapter and applies each event:
 *        message  → contact + identity, the open conversation (or a new / reopened one), the message
 *                   (unique per channel and external id: duplicates are skipped), the window, keywords
 *                   (opt-out, opt-in, "talk to a person"), media download, the bot, notices;
 *        status   → only a higher status replaces a lower one (sent < delivered < read; failed wins);
 *        template → the local copy's status and quality;
 *        account  → the number's quality and messaging limit, and a notice for the admins.
 *
 * Web chat builds the same message events from its public operations and calls `applyMessage` directly.
 */

import { asSystem, PermanentError, queue, type QueueJob } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq, ne, or, sql } from "drizzle-orm";

import { adapterOf } from "./channels";
import type { InboundMessageEvent, NormalizedEvent, StatusEvent } from "./channels/types";
import { authOf, channelBy } from "./koe.channels";
import { dbOf, emit, newId, previewOf, QUEUES, STATUS_RANK, type Db } from "./koe.common";
import { autoAssign, changeState, recordEvent } from "./koe.conversations";
import { channelOf, conversationChanged, publish } from "./koe.realtime";
import {
  koeChannels,
  koeConsents,
  koeContacts,
  koeConversations,
  koeIdentities,
  koeMedia,
  koeMessages,
  koeWebhookEvents,
  type Channel,
  type ChannelKind,
  type Contact,
  type Conversation,
  type ConversationState,
  type Message,
} from "./koe.schema";
import { applyTemplateStatus } from "./koe.templates";
import { FREE_ENTRY_MS, POLICIES } from "./koe.window";

/** Stores one webhook body and queues its processing. Returns false when it was already received. */
export async function receiveWebhook(db: Db, kind: ChannelKind | "meta", dedupeKey: string, payload: unknown): Promise<boolean> {
  return asSystem(async () => {
    const inserted = (await db
      .insert(koeWebhookEvents)
      .values({ id: newId(), channelKind: kind, dedupeKey, payload })
      .onConflictDoNothing({ target: koeWebhookEvents.dedupeKey })
      .returning({ id: koeWebhookEvents.id })) as Array<{ id: string }>;
    if (!inserted.length) return false;
    await queue.dispatch(QUEUES.inbound, "webhook", { eventId: inserted[0]!.id }, { attempts: 10, reason: `koe ${kind} webhook` });
    return true;
  });
}

/** Every event of every adapter that understands this body (one Meta app can serve several products). */
export function parseAny(body: unknown): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const kind of ["whatsapp", "messenger", "instagram"] as const) out.push(...adapterOf(kind).parse(body));
  return out;
}

/** Where the Meta webhook route records which channels signed a body (a key Meta never sends). */
export const SIGNED_FOR = "_koeSignedFor";

/**
 * The channel an event speaks for, as the webhook route names its signers: `<kind>:<external id>` when the
 * event names a channel (a number, a page, an Instagram account), else `account:<WABA id>`.
 */
export function signerKeyOf(e: NormalizedEvent): string {
  if ("channelExternalId" in e && e.channelExternalId) return `${e.channelKind}:${e.channelExternalId}`;
  return `account:${"accountId" in e ? (e.accountId ?? "") : ""}`;
}

/** The events of a stored body that its signers may speak for (a body without the list: all of them). */
export function signedEvents(payload: unknown): NormalizedEvent[] {
  const events = parseAny(payload);
  const list = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[SIGNED_FOR] : undefined;
  if (!Array.isArray(list)) return events;
  const signers = new Set(list.filter((x): x is string => typeof x === "string"));
  return events.filter((e) => signers.has(signerKeyOf(e)));
}

export async function processWebhook(ctx: KonContext, job: QueueJob<{ eventId?: string }>): Promise<void> {
  const id = job.payload?.eventId;
  if (!id) throw new PermanentError("job without eventId");
  const db = dbOf(ctx);
  await asSystem(async () => {
    const [row] = (await db.select().from(koeWebhookEvents).where(eq(koeWebhookEvents.id, id)).limit(1)) as Array<typeof koeWebhookEvents.$inferSelect>;
    if (!row || row.processedAt) return;
    const events = row.channelKind === "meta" ? signedEvents(row.payload) : parseAny(row.payload);
    for (const e of events) await applyEvent(ctx, db, e);
    await db.update(koeWebhookEvents).set({ processedAt: new Date(), error: null }).where(eq(koeWebhookEvents.id, id));
  });
}

export async function applyEvent(ctx: KonContext, db: Db, e: NormalizedEvent): Promise<void> {
  switch (e.type) {
    case "message":
      await applyMessage(ctx, db, e);
      return;
    case "status":
      await applyStatus(ctx, db, e);
      return;
    case "template_status":
      await applyTemplateStatus(ctx, db, { accountId: e.accountId, name: e.name, language: e.language, status: e.status, reason: e.reason, templateExternalId: e.templateExternalId });
      return;
    case "template_quality":
      await applyTemplateStatus(ctx, db, { accountId: e.accountId, name: e.name, language: e.language, quality: e.quality, templateExternalId: e.templateExternalId });
      return;
    case "account_update": {
      const where = e.channelExternalId
        ? and(eq(koeChannels.kind, e.channelKind), eq(koeChannels.externalId, e.channelExternalId))
        : and(eq(koeChannels.kind, e.channelKind), eq(koeChannels.accountId, e.accountId ?? ""));
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (e.quality) set.quality = e.quality;
      if (e.messagingLimit) set.messagingLimit = e.messagingLimit;
      if (e.detail) set.statusDetail = e.detail;
      const channels = (await db.update(koeChannels).set(set).where(where).returning({ id: koeChannels.id })) as Array<{ id: string }>;
      for (const c of channels) emit(ctx, "channel.quality_changed", { channelId: c.id, quality: e.quality ?? null, messagingLimit: e.messagingLimit ?? null, detail: e.detail ?? null });
      return;
    }
    case "seen": {
      const channel = await channelBy(db, e.channelKind, e.channelExternalId);
      if (!channel) return;
      const [identity] = (await db.select().from(koeIdentities).where(and(eq(koeIdentities.channelId, channel.id), eq(koeIdentities.externalId, e.contactExternalId))).limit(1)) as Array<{ id: string }>;
      if (!identity) return;
      const [conv] = (await db.select().from(koeConversations).where(and(eq(koeConversations.identityId, identity.id), ne(koeConversations.state, "resolved"))).limit(1)) as Conversation[];
      if (!conv) return;
      await db
        .update(koeMessages)
        .set({ status: "read", statusRank: STATUS_RANK.read })
        .where(and(eq(koeMessages.conversationId, conv.id), eq(koeMessages.direction, "out"), sql`${koeMessages.statusRank} < ${STATUS_RANK.read}`, sql`${koeMessages.sentAt} <= ${e.watermark}`));
      publish(ctx, channelOf.conversation(conv.id), { type: "seen", conversationId: conv.id, at: e.watermark.toISOString() });
      return;
    }
  }
}

async function applyStatus(ctx: KonContext, db: Db, e: StatusEvent): Promise<void> {
  const channel = await channelBy(db, e.channelKind, e.channelExternalId);
  if (!channel) return;
  const rank = STATUS_RANK[e.status]!;
  const updated = (await db
    .update(koeMessages)
    .set({
      status: e.status,
      statusRank: rank,
      ...(e.error ? { errorCode: e.error.code, errorMessage: e.error.message.slice(0, 1000) } : {}),
      ...(e.pricing ? { payload: sql`${koeMessages.payload} || ${JSON.stringify({ pricing: e.pricing })}::jsonb` } : {}),
    })
    .where(and(eq(koeMessages.channelId, channel.id), eq(koeMessages.externalId, e.externalMessageId), sql`${koeMessages.statusRank} < ${rank}`))
    .returning({ id: koeMessages.id, conversationId: koeMessages.conversationId, authorKind: koeMessages.authorKind })) as Array<{ id: string; conversationId: string; authorKind: string }>;
  for (const m of updated) {
    publish(ctx, channelOf.conversation(m.conversationId), { type: "status", messageId: m.id, status: e.status });
    if (e.status === "failed") {
      emit(ctx, "message.failed", { messageId: m.id, conversationId: m.conversationId, channelId: channel.id, code: e.error?.code ?? "unknown", error: e.error?.message ?? null, authorKind: m.authorKind });
    } else if (e.status === "read" || e.status === "delivered") {
      emit(ctx, `message.${e.status}`, { messageId: m.id, conversationId: m.conversationId, channelId: channel.id });
    }
  }
}

// ── Messages ────────────────────────────────────────────────────────────────

const words = (text: string | undefined) => (text ?? "").trim().toLowerCase();
const DEFAULT_OPT_OUT = ["stop", "baja", "unsubscribe", "cancelar suscripción"];
const DEFAULT_OPT_IN = ["start", "alta", "subscribe"];
const DEFAULT_HANDOFF = ["agente", "humano", "persona", "asesor", "agent", "human"];

/**
 * Messenger and Instagram webhooks carry no name: a new contact's public profile is asked once. A failure
 * (no permission, the call times out) only leaves the name empty; it never drops the message.
 */
async function lookupProfile(ctx: KonContext, channel: Channel, e: InboundMessageEvent): Promise<InboundMessageEvent["profile"]> {
  const adapter = adapterOf(channel.kind);
  if (e.profile?.name || !adapter.profile || (channel.kind !== "messenger" && channel.kind !== "instagram")) return e.profile;
  try {
    const found = await adapter.profile(await authOf(ctx, channel, "contact-profile"), e.contactExternalId);
    if (!found) return e.profile;
    return { ...e.profile, ...found, name: found.name ?? found.username } as InboundMessageEvent["profile"];
  } catch {
    return e.profile;
  }
}

async function contactFor(ctx: KonContext, db: Db, channel: Channel, e: InboundMessageEvent): Promise<{ contact: Contact; identityId: string }> {
  const [identity] = (await db
    .select()
    .from(koeIdentities)
    .where(and(eq(koeIdentities.channelId, channel.id), eq(koeIdentities.externalId, e.contactExternalId)))
    .limit(1)) as Array<typeof koeIdentities.$inferSelect>;
  if (identity) {
    const [contact] = (await db.select().from(koeContacts).where(eq(koeContacts.id, identity.contactId)).limit(1)) as Contact[];
    // A name the contact set later fills an empty one; never overwrites what the team wrote.
    if (contact && !contact.displayName && e.profile?.name) {
      await db.update(koeContacts).set({ displayName: e.profile.name, updatedAt: new Date() }).where(eq(koeContacts.id, contact.id));
      contact.displayName = e.profile.name;
    }
    return { contact: contact!, identityId: identity.id };
  }
  const profile = await lookupProfile(ctx, channel, e);
  // A known phone or email joins the same contact across channels.
  const phone = channel.kind === "whatsapp" ? e.contactExternalId : profile?.phone;
  let contact: Contact | undefined;
  if (phone || profile?.email) {
    [contact] = (await db
      .select()
      .from(koeContacts)
      .where(or(...(phone ? [eq(koeContacts.phone, phone)] : []), ...(profile?.email ? [sql`lower(${koeContacts.email}) = lower(${profile.email})`] : [])))
      .limit(1)) as Contact[];
  }
  if (!contact) {
    [contact] = (await db
      .insert(koeContacts)
      .values({ id: newId(), displayName: profile?.name ?? null, phone: phone ?? null, email: profile?.email ?? null })
      .returning()) as Contact[];
  }
  const identityId = newId();
  await db
    .insert(koeIdentities)
    .values({ id: identityId, contactId: contact!.id, channelId: channel.id, externalId: e.contactExternalId, profile: profile ?? {} })
    .onConflictDoNothing({ target: [koeIdentities.channelId, koeIdentities.externalId] });
  const [won] = (await db.select({ id: koeIdentities.id, contactId: koeIdentities.contactId }).from(koeIdentities).where(and(eq(koeIdentities.channelId, channel.id), eq(koeIdentities.externalId, e.contactExternalId))).limit(1)) as Array<{ id: string; contactId: string }>;
  return { contact: contact!, identityId: won!.id };
}

/** Where a new (or reopened) conversation starts: with a bot when the channel has one, else in the queue. */
function startState(channel: Channel): ConversationState {
  return channel.botSlug || channel.settings?.flowId ? "bot" : "queued";
}

async function conversationFor(ctx: KonContext, db: Db, channel: Channel, contact: Contact, identityId: string): Promise<{ conversation: Conversation; created: boolean; reopened: boolean }> {
  const [open] = (await db.select().from(koeConversations).where(and(eq(koeConversations.identityId, identityId), ne(koeConversations.state, "resolved"))).limit(1)) as Conversation[];
  if (open) return { conversation: open, created: false, reopened: false };

  // The last resolved one comes back, so its history stays in one thread.
  const [resolved] = (await db
    .select()
    .from(koeConversations)
    .where(and(eq(koeConversations.identityId, identityId), eq(koeConversations.state, "resolved")))
    .orderBy(sql`${koeConversations.resolvedAt} DESC NULLS LAST`)
    .limit(1)) as Conversation[];
  if (resolved) {
    // A channel without a bot cannot reopen to the bot, whatever its settings say.
    const preferred = channel.settings?.reopenAs ?? startState(channel);
    const to = preferred === "bot" && startState(channel) !== "bot" ? "queued" : preferred;
    const conversation = await changeState(ctx, db, resolved.id, { trigger: "reopen", to }, { kind: "contact", id: contact.id });
    return { conversation, created: false, reopened: true };
  }

  const state = startState(channel);
  const now = new Date();
  const [conversation] = (await db
    .insert(koeConversations)
    .values({ id: newId(), channelId: channel.id, identityId, contactId: contact.id, state, teamId: channel.defaultTeamId ?? null, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning()) as Conversation[];
  if (!conversation) {
    // Another message of the same contact created it a moment ago.
    const [again] = (await db.select().from(koeConversations).where(and(eq(koeConversations.identityId, identityId), ne(koeConversations.state, "resolved"))).limit(1)) as Conversation[];
    return { conversation: again!, created: false, reopened: false };
  }
  await recordEvent(db, conversation.id, "created", { kind: "contact", id: contact.id }, { to: state, data: { channelId: channel.id } });
  emit(ctx, "conversation.created", { conversationId: conversation.id, channelId: channel.id, channelKind: channel.kind, contactId: contact.id, state, teamId: conversation.teamId });
  return { conversation, created: true, reopened: false };
}

async function setConsent(db: Db, contactId: string, channelId: string, status: "opted_in" | "opted_out", source: string): Promise<void> {
  await db
    .insert(koeConsents)
    .values({ id: newId(), contactId, channelId, status, source })
    .onConflictDoUpdate({ target: [koeConsents.contactId, koeConsents.channelId], set: { status, source, updatedAt: new Date() } });
}

export interface AppliedMessage {
  message: Message;
  conversation: Conversation;
  duplicate: boolean;
}

export async function applyMessage(ctx: KonContext, db: Db, e: InboundMessageEvent): Promise<AppliedMessage | null> {
  const channel = await channelBy(db, e.channelKind, e.channelExternalId);
  if (!channel || channel.status === "disabled") return null;

  const [seen] = (await db.select().from(koeMessages).where(and(eq(koeMessages.channelId, channel.id), eq(koeMessages.externalId, e.externalMessageId))).limit(1)) as Message[];
  if (seen) {
    const [conv] = (await db.select().from(koeConversations).where(eq(koeConversations.id, seen.conversationId)).limit(1)) as Conversation[];
    return { message: seen, conversation: conv!, duplicate: true };
  }

  const { contact, identityId } = await contactFor(ctx, db, channel, e);
  if (contact.blocked) return null;
  let { conversation } = await conversationFor(ctx, db, channel, contact, identityId);

  // A reaction is about an earlier message: kept on it, not as a new line of the thread.
  let replyToId: string | null = null;
  const refExternal = e.kind === "reaction" ? String(e.payload?.messageExternalId ?? "") : e.replyToExternalId;
  if (refExternal) {
    const [ref] = (await db.select({ id: koeMessages.id }).from(koeMessages).where(and(eq(koeMessages.channelId, channel.id), eq(koeMessages.externalId, refExternal))).limit(1)) as Array<{ id: string }>;
    replyToId = ref?.id ?? null;
  }

  let mediaId: string | null = null;
  if (e.media) {
    mediaId = newId();
    await db.insert(koeMedia).values({
      id: mediaId,
      conversationId: conversation.id,
      kind: e.media.kind,
      mime: e.media.mime ?? "application/octet-stream",
      filename: e.media.filename ?? null,
      sha256: e.media.sha256 ?? null,
      animated: e.media.animated ?? false,
      metaMediaId: channel.kind === "whatsapp" ? e.media.ref : null,
      metaMediaChannelId: channel.kind === "whatsapp" ? channel.id : null,
      status: "pending",
    });
  }

  const now = new Date();
  const [message] = (await db
    .insert(koeMessages)
    .values({
      id: newId(),
      conversationId: conversation.id,
      channelId: channel.id,
      direction: "in",
      authorKind: "contact",
      authorId: contact.id,
      kind: e.kind,
      body: e.body ?? null,
      payload: { ...(e.payload ?? {}), ...(e.referral ? { referral: e.referral } : {}) },
      mediaId,
      replyToId,
      externalId: e.externalMessageId,
      status: "received",
      statusRank: STATUS_RANK.received,
      createdAt: e.timestamp > now ? now : e.timestamp,
    })
    .onConflictDoNothing()
    .returning()) as Message[];
  if (!message) {
    const [again] = (await db.select().from(koeMessages).where(and(eq(koeMessages.channelId, channel.id), eq(koeMessages.externalId, e.externalMessageId))).limit(1)) as Message[];
    return { message: again!, conversation, duplicate: true };
  }

  // The window reopens with every message of the contact.
  const policy = POLICIES[channel.kind];
  const patch: Record<string, unknown> = {
    lastInboundAt: now,
    lastMessageAt: now,
    lastMessagePreview: previewOf(e.kind, e.body),
    windowExpiresAt: policy.serviceMs ? new Date(now.getTime() + policy.serviceMs) : null,
    windowWarnedAt: null,
    unreadCount: sql`${koeConversations.unreadCount} + 1`,
    updatedAt: now,
  };
  if (e.freeEntry) patch.freeEntryUntil = new Date(now.getTime() + FREE_ENTRY_MS);
  if (e.referral) patch.metadata = sql`${koeConversations.metadata} || ${JSON.stringify({ referral: e.referral })}::jsonb`;
  [conversation] = (await db.update(koeConversations).set(patch).where(eq(koeConversations.id, conversation.id)).returning()) as Conversation[];

  if (mediaId) await queue.dispatch(QUEUES.media, "download", { mediaId, messageId: message.id, ref: e.media!.ref }, { attempts: 6, reason: `koe ${channel.kind} media` });

  // Keywords: consent and "a person, please".
  const text = words(e.body);
  const optOut = channel.settings?.optOutKeywords ?? DEFAULT_OPT_OUT;
  const optIn = channel.settings?.optInKeywords ?? DEFAULT_OPT_IN;
  if (text && optOut.includes(text)) {
    await setConsent(db, contact.id, channel.id, "opted_out", "keyword");
    emit(ctx, "contact.opted_out", { contactId: contact.id, channelId: channel.id, conversationId: conversation.id });
  } else if (text && optIn.includes(text)) {
    await setConsent(db, contact.id, channel.id, "opted_in", "keyword");
    emit(ctx, "contact.opted_in", { contactId: contact.id, channelId: channel.id, conversationId: conversation.id });
  }
  const handoffWords = channel.settings?.handoffKeywords ?? DEFAULT_HANDOFF;
  if (conversation.state === "bot" && text && handoffWords.includes(text)) {
    conversation = await changeState(ctx, db, conversation.id, { trigger: "handoff", reason: "contact asked for a person" }, { kind: "contact", id: contact.id });
  }

  // Snoozed: the contact writing wakes it (to whoever had it, else to the queue).
  if (conversation.state === "snoozed") {
    conversation = await changeState(ctx, db, conversation.id, { trigger: "wake", to: conversation.assigneeId ? "human" : "queued" }, { kind: "contact", id: contact.id });
  }
  if (conversation.state === "queued") conversation = await autoAssign(ctx, db, conversation);

  // Stop sequences that stop on reply (koe.automation.ts listens to this event too).
  emit(ctx, "message.received", {
    messageId: message.id,
    conversationId: conversation.id,
    channelId: channel.id,
    channelKind: channel.kind,
    contactId: contact.id,
    kind: e.kind,
    text: e.body ?? null,
    state: conversation.state,
    assigneeId: conversation.assigneeId,
    teamId: conversation.teamId,
  });
  publish(ctx, channelOf.conversation(conversation.id), { type: "message", conversationId: conversation.id, messageId: message.id, direction: "in" });
  conversationChanged(ctx, conversation, "message");

  if (conversation.state === "bot" && e.kind !== "reaction") {
    await queue.dispatch(QUEUES.bot, "turn", { conversationId: conversation.id, messageId: message.id }, { attempts: 3, reason: "koe bot turn" });
  } else if (conversation.state === "human" && conversation.assigneeId) {
    await queue.dispatch(QUEUES.notify, "message", { userId: conversation.assigneeId, conversationId: conversation.id, messageId: message.id }, { attempts: 3 });
  } else if (conversation.state === "queued") {
    await queue.dispatch(QUEUES.notify, "queued", { teamId: conversation.teamId, conversationId: conversation.id, messageId: message.id }, { attempts: 3 });
  }
  return { message, conversation, duplicate: false };
}
