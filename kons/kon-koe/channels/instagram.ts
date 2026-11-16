/**
 * Instagram messaging (professional accounts)
 * ============================================================================
 *
 * In: the `instagram` webhook (`entry.id` is the Instagram account id, `sender.id` the contact's
 * Instagram-scoped id, IGSID): messages, story replies and mentions (their media URL expires: fetched at
 * once), shared posts and reels, reactions, postbacks, read receipts.
 * Out: `POST /{page-id or me}/messages` with the token of the page linked to the account (Facebook Login).
 * The wire format is shared with Messenger and lives in meta-messaging.ts.
 *
 * Differences from Messenger: no button template (buttons and lists go as quick replies, a link as text,
 * which the app previews), smaller images (8 MB; audio, video and PDF 25 MB), and no upload-by-id that koe
 * relies on: outbound media goes as a short-lived signed URL (koe.send.ts' deliver() does that for any
 * adapter without `uploadMedia`). Instagram accepts audio as aac, m4a, wav or mp4 (verify), so an OGG voice
 * note must be converted before it is sent.
 */

import { fetchAttachment, fetchProfile, INSTAGRAM, parseMessaging, sendMessaging, senderAction } from "./meta-messaging";
import type { ChannelAdapter, NormalizedEvent } from "./types";

const MB = 1024 * 1024;

export function parseInstagram(body: unknown): NormalizedEvent[] {
  return parseMessaging(INSTAGRAM, body);
}

export const instagram: ChannelAdapter = {
  kind: "instagram",
  capabilities: {
    kinds: ["text", "image", "audio", "voice", "video", "document", "interactive"],
    maxBytes: { image: 8 * MB, audio: 25 * MB, voice: 25 * MB, video: 25 * MB, document: 25 * MB },
    templates: false,
    interactive: true,
    readReceipts: true,
    typing: true,
  },
  parse: parseInstagram,
  send: (auth, message) => sendMessaging(INSTAGRAM, auth, message),
  fetchMedia: (_auth, media) => fetchAttachment(media),
  markRead: (auth, contact) => senderAction(INSTAGRAM, auth, contact, "mark_seen"),
  typing: (auth, contact) => senderAction(INSTAGRAM, auth, contact, "typing_on"),
  profile: (auth, contact) => fetchProfile(INSTAGRAM, auth, contact),
};
