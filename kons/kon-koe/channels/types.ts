/**
 * What every channel speaks: normalized events in, outbound messages out
 * ============================================================================
 *
 * An adapter knows its channel's wire format and nothing else: no database, no state machine, no window.
 * It turns a webhook body into NormalizedEvents and an OutboundMessage into an API call. Everything else
 * (who the contact is, which conversation, whether the message may go out) lives in koe.inbound.ts and
 * koe.send.ts, the same for every channel.
 */

import type { ChannelKind, MediaKind } from "../koe.schema";

export interface InboundMedia {
  /** The channel's handle to fetch it: a WhatsApp media id, or a URL (Messenger, Instagram). */
  ref: string;
  kind: MediaKind;
  mime?: string;
  filename?: string;
  sha256?: string;
  animated?: boolean;
  /** The URL expires soon (Instagram story, Messenger attachment): fetch it at once. */
  expiring?: boolean;
}

export type InboundKind =
  | "text"
  | "image"
  | "audio"
  | "voice"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "contacts"
  | "reaction"
  | "button_reply"
  | "list_reply"
  | "postback"
  | "story_reply"
  | "story_mention"
  | "share"
  | "order"
  | "unsupported";

export interface InboundMessageEvent {
  type: "message";
  channelKind: ChannelKind;
  /** phone_number_id, page id, IG account id, web chat key. */
  channelExternalId: string;
  /** wa_id, PSID, IGSID, visitor hash. */
  contactExternalId: string;
  profile?: { name?: string; phone?: string; email?: string };
  externalMessageId: string;
  timestamp: Date;
  kind: InboundKind;
  body?: string;
  payload?: Record<string, unknown>;
  media?: InboundMedia;
  replyToExternalId?: string;
  /** Ad or link the conversation came from (click-to-WhatsApp, m.me ref). */
  referral?: Record<string, unknown>;
  /** The message opens a free-entry window (WhatsApp, 72 h). */
  freeEntry?: boolean;
}

export interface StatusEvent {
  type: "status";
  channelKind: ChannelKind;
  channelExternalId: string;
  externalMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: Date;
  error?: { code: string; message: string };
  /** Pricing category Meta charged (WhatsApp), for the cost reports. */
  pricing?: { category?: string; billable?: boolean };
}

export interface TemplateStatusEvent {
  type: "template_status";
  channelKind: "whatsapp";
  /** WABA id. */
  accountId: string;
  templateExternalId?: string;
  name: string;
  language?: string;
  status: string;
  reason?: string;
}

export interface TemplateQualityEvent {
  type: "template_quality";
  channelKind: "whatsapp";
  accountId: string;
  templateExternalId?: string;
  name: string;
  language?: string;
  quality: string;
}

export interface AccountUpdateEvent {
  type: "account_update";
  channelKind: ChannelKind;
  channelExternalId?: string;
  accountId?: string;
  quality?: string;
  messagingLimit?: string;
  detail?: string;
}

/** A read receipt or "typing" from the contact (Messenger, Instagram, web chat). */
export interface SeenEvent {
  type: "seen";
  channelKind: ChannelKind;
  channelExternalId: string;
  contactExternalId: string;
  watermark: Date;
}

export type NormalizedEvent =
  | InboundMessageEvent
  | StatusEvent
  | TemplateStatusEvent
  | TemplateQualityEvent
  | AccountUpdateEvent
  | SeenEvent;

export type OutboundKind =
  | "text"
  | "image"
  | "audio"
  | "voice"
  | "video"
  | "document"
  | "sticker"
  | "template"
  | "interactive"
  | "location"
  | "contacts"
  | "reaction";

export interface OutboundMedia {
  /** The id the channel already has (WhatsApp media id, Messenger attachment id). */
  channelMediaId?: string;
  /** A signed URL the channel can download from. */
  link?: string;
  mime: string;
  filename?: string;
  caption?: string;
}

export interface InteractiveButtons {
  type: "buttons";
  body: string;
  header?: string;
  footer?: string;
  /** At most 3 (WhatsApp), titles up to 20 characters. */
  buttons: Array<{ id: string; title: string }>;
}

export interface InteractiveList {
  type: "list";
  body: string;
  header?: string;
  footer?: string;
  button: string;
  /** At most 10 rows in total. */
  sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }>;
}

export interface InteractiveUrl {
  type: "url";
  body: string;
  text: string;
  url: string;
}

export type Interactive = InteractiveButtons | InteractiveList | InteractiveUrl;

export interface OutboundTemplate {
  name: string;
  language: string;
  /** Already rendered for the channel (koe.templates.ts builds them). */
  components: unknown[];
}

export interface OutboundMessage {
  /** The contact's external id on this channel. */
  to: string;
  kind: OutboundKind;
  body?: string;
  media?: OutboundMedia;
  template?: OutboundTemplate;
  interactive?: Interactive;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: unknown[];
  reaction?: { messageExternalId: string; emoji: string };
  replyToExternalId?: string;
  /** Messenger/Instagram outside the 24 h window: only for a person's message. */
  tag?: "HUMAN_AGENT";
}

export interface SendResult {
  externalId: string;
}

/** The channel's credentials and settings, already opened, for one call. */
export interface ChannelAuth {
  externalId: string;
  accountId: string | null;
  accessToken: string;
  graphVersion: string;
}

export interface FetchedMedia {
  bytes: Buffer;
  mime: string;
  sha256?: string;
}

export interface ChannelCapabilities {
  kinds: OutboundKind[];
  /** Bytes per media kind the channel accepts (verify against the current docs). */
  maxBytes: Partial<Record<OutboundKind, number>>;
  templates: boolean;
  interactive: boolean;
  readReceipts: boolean;
  typing: boolean;
}

export interface ChannelAdapter {
  kind: ChannelKind;
  capabilities: ChannelCapabilities;
  /** Webhook body (already signature-checked) → events. Never throws on unknown shapes: skips them. */
  parse(body: unknown): NormalizedEvent[];
  send(auth: ChannelAuth, message: OutboundMessage): Promise<SendResult>;
  fetchMedia?(auth: ChannelAuth, media: InboundMedia): Promise<FetchedMedia>;
  /** Upload once, re-send by id. */
  uploadMedia?(auth: ChannelAuth, bytes: Buffer, mime: string, filename?: string): Promise<{ id: string; expiresAt: Date | null }>;
  markRead?(auth: ChannelAuth, contactExternalId: string, messageExternalId: string): Promise<void>;
  typing?(auth: ChannelAuth, contactExternalId: string, messageExternalId?: string): Promise<void>;
  /** The contact's public profile, for channels whose webhooks carry no name (Messenger, Instagram). */
  profile?(auth: ChannelAuth, contactExternalId: string): Promise<{ name?: string; username?: string; picture?: string } | null>;
}
