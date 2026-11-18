/**
 * The service window: when a business may write freely
 * ============================================================================
 *
 * Meta lets a business answer freely for 24 hours after the contact's last message. Outside it:
 *
 *   WhatsApp   only an approved template (72 h with a free-entry point: click-to-WhatsApp ad, page button)
 *   Messenger  the HUMAN_AGENT tag, up to 7 days, only for messages a person wrote
 *   Instagram  the same as Messenger
 *   Web chat   our own channel: no window
 *
 * The window is never stored as a state: it is computed from `last_inbound_at` every time. The column
 * `window_expires_at` is only an index for reminders. Every outbound message goes through
 * `checkWindow()` in send(); there is no other way out.
 *
 * Meta changes these rules (verify against the current docs before each release). They are data here,
 * not code paths: POLICIES is the one place to change them.
 */

import type { AuthorKind, ChannelKind } from "./koe.schema";

const HOUR = 3_600_000;

export interface WindowPolicy {
  /** Free window after the contact's last message (ms). `null`: no window. */
  serviceMs: number | null;
  /** Extended window with the human-agent tag (ms), for messages written by a person. */
  humanAgentMs: number | null;
  /** Whether a template may be sent outside the window. */
  templatesOutside: boolean;
}

export const POLICIES: Record<ChannelKind, WindowPolicy> = {
  whatsapp: { serviceMs: 24 * HOUR, humanAgentMs: null, templatesOutside: true },
  messenger: { serviceMs: 24 * HOUR, humanAgentMs: 7 * 24 * HOUR, templatesOutside: false },
  instagram: { serviceMs: 24 * HOUR, humanAgentMs: 7 * 24 * HOUR, templatesOutside: false },
  webchat: { serviceMs: null, humanAgentMs: null, templatesOutside: false },
};

export interface WindowState {
  open: boolean;
  /** When the free window closes (`null`: never, or already closed with no inbound). */
  expiresAt: Date | null;
  /** When the human-agent window closes (Messenger/Instagram). */
  humanAgentUntil: Date | null;
  freeEntryUntil: Date | null;
}

export function windowOf(
  kind: ChannelKind,
  lastInboundAt: Date | null,
  freeEntryUntil: Date | null = null,
  now: Date = new Date()
): WindowState {
  const p = POLICIES[kind];
  if (p.serviceMs === null) return { open: true, expiresAt: null, humanAgentUntil: null, freeEntryUntil: null };
  const service = lastInboundAt ? new Date(lastInboundAt.getTime() + p.serviceMs) : null;
  const free = kind === "whatsapp" && freeEntryUntil && freeEntryUntil > now ? freeEntryUntil : null;
  const expiresAt = free && (!service || free > service) ? free : service;
  const humanAgentUntil = p.humanAgentMs && lastInboundAt ? new Date(lastInboundAt.getTime() + p.humanAgentMs) : null;
  return { open: !!expiresAt && expiresAt > now, expiresAt, humanAgentUntil, freeEntryUntil: free };
}

export type OutboundIntent = "free" | "template";

export type WindowDecision =
  | { ok: true; tag?: "HUMAN_AGENT" }
  | { ok: false; code: "WINDOW_CLOSED" | "TEMPLATE_NOT_SUPPORTED" | "TAG_NOT_ALLOWED"; message: string };

/**
 * May this message go out now? `author` matters: the human-agent tag is only for what a person wrote,
 * never for a bot, a rule or a campaign.
 */
export function checkWindow(
  kind: ChannelKind,
  intent: OutboundIntent,
  author: AuthorKind,
  lastInboundAt: Date | null,
  freeEntryUntil: Date | null = null,
  now: Date = new Date()
): WindowDecision {
  const p = POLICIES[kind];
  if (intent === "template") {
    if (kind === "whatsapp") return { ok: true };
    return { ok: false, code: "TEMPLATE_NOT_SUPPORTED", message: `${kind} has no message templates` };
  }
  const w = windowOf(kind, lastInboundAt, freeEntryUntil, now);
  if (w.open) return { ok: true };
  if (p.humanAgentMs && w.humanAgentUntil && w.humanAgentUntil > now) {
    if (author === "agent") return { ok: true, tag: "HUMAN_AGENT" };
    return {
      ok: false,
      code: "TAG_NOT_ALLOWED",
      message: "The 24-hour window is closed. Only a person may still answer (human agent tag, up to 7 days).",
    };
  }
  return {
    ok: false,
    code: "WINDOW_CLOSED",
    message:
      kind === "whatsapp"
        ? "The 24-hour window is closed: only an approved template can be sent."
        : "The window to answer this contact is closed. Wait for them to write again.",
  };
}

/** For the inbox and the reminders sweep: how long is left (ms), or null when there is no window. */
export function remainingMs(kind: ChannelKind, lastInboundAt: Date | null, freeEntryUntil: Date | null = null, now = new Date()): number | null {
  const w = windowOf(kind, lastInboundAt, freeEntryUntil, now);
  if (POLICIES[kind].serviceMs === null) return null;
  return w.expiresAt ? Math.max(0, w.expiresAt.getTime() - now.getTime()) : 0;
}

/** WhatsApp's free-entry window (click-to-WhatsApp ads, page buttons). Verify the duration against Meta's docs. */
export const FREE_ENTRY_MS = 72 * HOUR;
