/**
 * Messenger (Facebook Pages)
 * ============================================================================
 *
 * In: the `page` webhook (`entry.id` is the page id, `sender.id` the contact's page-scoped id, PSID).
 * Out: `POST /{page-id}/messages` with the page access token. The wire format is shared with Instagram and
 * lives in meta-messaging.ts; this file only says what Messenger can do.
 *
 * Messenger takes uploads (`/message_attachments`, re-sent by `attachment_id`), the button template for
 * buttons and links, quick replies for lists, read receipts and typing. Attachments go up to 25 MB.
 * No templates, location, contact cards or stickers by id: those kinds are not offered. Voice notes go as
 * an audio attachment. Verify sizes against Meta's current docs before relying on them.
 */

import {
  fetchAttachment,
  fetchProfile,
  MESSENGER,
  parseMessaging,
  sendMessaging,
  senderAction,
  uploadAttachment,
} from "./meta-messaging";
import type { ChannelAdapter, NormalizedEvent } from "./types";

const MB = 1024 * 1024;

export function parseMessenger(body: unknown): NormalizedEvent[] {
  return parseMessaging(MESSENGER, body);
}

export const messenger: ChannelAdapter = {
  kind: "messenger",
  capabilities: {
    kinds: ["text", "image", "audio", "voice", "video", "document", "interactive"],
    maxBytes: { image: 25 * MB, audio: 25 * MB, voice: 25 * MB, video: 25 * MB, document: 25 * MB },
    templates: false,
    interactive: true,
    readReceipts: true,
    typing: true,
  },
  parse: parseMessenger,
  send: (auth, message) => sendMessaging(MESSENGER, auth, message),
  fetchMedia: (_auth, media) => fetchAttachment(media),
  uploadMedia: uploadAttachment,
  markRead: (auth, contact) => senderAction(MESSENGER, auth, contact, "mark_seen"),
  typing: (auth, contact) => senderAction(MESSENGER, auth, contact, "typing_on"),
  profile: (auth, contact) => fetchProfile(MESSENGER, auth, contact),
};
