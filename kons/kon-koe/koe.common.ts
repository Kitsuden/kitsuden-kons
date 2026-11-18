/**
 * What every koe module shares: the kon's id, its queues, the context and small helpers
 * ============================================================================
 */

import type { KonContext } from "@kitsuden/shared";
import { createId } from "@paralleldrive/cuid2";

export const KON_ID = "kon-koe";
/** Event and channel prefix: `koe:conversation.created`, `kon:koe:inbox`. */
export const SHORT = "koe";

/** Queues (Postgres outbox, at least once: every handler is idempotent). */
export const QUEUES = {
  /** One webhook body to normalize and apply. */
  inbound: "koe-inbound",
  /** One outbound message to deliver. */
  outbound: "koe-outbound",
  /** Download an inbound media file before its URL expires; convert outbound media. */
  media: "koe-media",
  /** One bot turn (flow or AI) for one inbound message. */
  bot: "koe-bot",
  /** Replies kon-chat sends back for channel bots. */
  botReplies: "koe-bot-replies",
  /** Notices and web push for people. */
  notify: "koe-notify",
  /** Campaign batches, sequence steps, reminders. */
  automation: "koe-automation",
} as const;

/** The queue kon-chat listens to for channel turns (see kon-chat's chat.channel.ts). */
export const CHAT_CHANNEL_QUEUE = "chat-channel-turns";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the host's Drizzle instance
export type Db = any;

export const newId = (): string => createId();

/** The context, kept by index.ts at mount so queue handlers and startup hooks reach the same one. */
let current: KonContext | null = null;
export function setKoeContext(ctx: KonContext): void {
  current = ctx;
}
export function koeContext(): KonContext {
  if (!current) throw new Error("kon-koe is not mounted");
  return current;
}

export function dbOf(ctx: KonContext): Db {
  return ctx.db.instance;
}

/** Emits a koe event after the request commits (docs/kons/events.md). Never throws. */
export function emit(ctx: KonContext, event: string, data: Record<string, unknown>): void {
  try {
    ctx.events.emit(`${SHORT}:${event}`, data);
  } catch (err) {
    ctx.logger.warn(`koe: event ${event} not emitted`, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Preview line for the inbox list. */
export function previewOf(kind: string, body: string | null | undefined): string {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  const label: Record<string, string> = {
    image: "📷 Image",
    video: "🎬 Video",
    audio: "🎵 Audio",
    voice: "🎤 Voice note",
    document: "📄 Document",
    sticker: "Sticker",
    location: "📍 Location",
    contacts: "👤 Contact",
    template: "Template",
    reaction: "Reaction",
  };
  if (text) return text.slice(0, 160);
  return label[kind] ?? kind;
}

/** Status ranks: a status only replaces a lower one (they arrive out of order). `failed` wins over `sent`. */
export const STATUS_RANK: Record<string, number> = { received: 0, queued: 1, sent: 2, delivered: 3, read: 4, failed: 5 };

export const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
