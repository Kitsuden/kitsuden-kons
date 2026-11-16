/**
 * Web chat: koe's own channel
 * ============================================================================
 *
 * No third party and no window. A visitor writes through the public operations (`/public/webchat/...`),
 * which build the same NormalizedEvent a Meta webhook would, and reads answers through the realtime
 * channel `kon:koe:visitor:<hash>` or by polling. "Sending" is storing the message and broadcasting it,
 * which koe.send.ts does; the adapter only names the message.
 */

import { createId } from "@paralleldrive/cuid2";

import type { ChannelAdapter, InboundMessageEvent } from "./types";

const MB = 1024 * 1024;

export const webchat: ChannelAdapter = {
  kind: "webchat",
  capabilities: {
    kinds: ["text", "image", "audio", "voice", "video", "document", "sticker", "interactive", "location"],
    maxBytes: { image: 10 * MB, audio: 16 * MB, voice: 16 * MB, video: 25 * MB, document: 25 * MB, sticker: 1 * MB },
    templates: false,
    interactive: true,
    readReceipts: true,
    typing: true,
  },
  // Web chat has no webhook: the public operations build the events (webchatMessage below).
  parse: () => [],
  async send() {
    return { externalId: `wc_${createId()}` };
  },
};

export function webchatMessage(
  channelKey: string,
  visitorHash: string,
  input: { text?: string; kind?: InboundMessageEvent["kind"]; payload?: Record<string, unknown>; name?: string; email?: string; clientMessageId: string }
): InboundMessageEvent {
  return {
    type: "message",
    channelKind: "webchat",
    channelExternalId: channelKey,
    contactExternalId: visitorHash,
    profile: { name: input.name, email: input.email },
    // The client's id makes a retried POST the same message.
    externalMessageId: `wcin_${visitorHash.slice(0, 16)}_${input.clientMessageId}`,
    timestamp: new Date(),
    kind: input.kind ?? "text",
    body: input.text,
    payload: input.payload,
  };
}
