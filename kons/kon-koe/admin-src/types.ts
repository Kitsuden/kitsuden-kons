/** The shapes koe's operations answer (koe.ops.inbox.ts, koe.ops.setup.ts), as the views read them. */

export type ChannelKind = "whatsapp" | "messenger" | "instagram" | "webchat";
export type ConversationState = "bot" | "queued" | "human" | "snoozed" | "resolved";
export type MemberRole = "agent" | "supervisor" | "admin";
export type MessageStatus = "received" | "queued" | "sent" | "delivered" | "read" | "failed";

export interface ChannelSettings {
  greeting?: string;
  autoResolveHours?: number;
  optOutKeywords?: string[];
  optInKeywords?: string[];
  handoffKeywords?: string[];
  ratePerSecond?: number;
  graphVersion?: string;
  allowedOrigins?: string[];
  preChatForm?: boolean;
  reopenAs?: "bot" | "queued";
  flowId?: string;
  maxBotFailures?: number;
}

export interface Channel {
  id: string;
  kind: ChannelKind;
  name: string;
  externalId: string;
  accountId: string | null;
  display: string | null;
  status: "active" | "disabled" | "error";
  statusDetail: string | null;
  quality: string | null;
  messagingLimit: string | null;
  botSlug: string | null;
  defaultTeamId: string | null;
  settings: ChannelSettings;
  hasAccessToken: boolean;
  hasAppSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  userId: string;
  role: MemberRole;
  displayName: string;
  maxConcurrent: number;
  available: boolean;
  lastSeenAt: string | null;
  teamIds: string[];
}

export interface Team {
  id: string;
  slug: string;
  name: string;
  purpose: "support" | "sales" | "collections";
  timezone: string;
  businessHours: Record<string, Array<[string, string]>>;
  assignment: "round_robin" | "load" | "manual";
  slaFirstResponseS: number | null;
  slaResolutionS: number | null;
  memberIds: string[];
}

export interface TemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
  text?: string;
  buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string }>;
}

export interface Template {
  id: string;
  channelId: string;
  name: string;
  language: string;
  category: "marketing" | "utility" | "authentication";
  status: "approved" | "pending" | "rejected" | "paused" | "disabled" | "in_appeal" | "deleted";
  components: TemplateComponent[];
  quality: string | null;
  rejectedReason: string | null;
  syncedAt: string | null;
}

export interface WindowView {
  open: boolean;
  expiresAt: string | null;
  humanAgentUntil: string | null;
}

export interface Conversation {
  id: string;
  channelId: string;
  contactId: string;
  state: ConversationState;
  assigneeId: string | null;
  teamId: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  labels: string[];
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  snoozedUntil: string | null;
  firstResponseDueAt: string | null;
  slaBreached: boolean;
  resolvedAt: string | null;
  metadata: { handoffSummary?: string; [k: string]: unknown };
  createdAt: string;
  updatedAt: string;
  contact: { id: string; displayName: string | null; phone: string | null; email: string | null; blocked: boolean } | null;
  channel: { id: string; kind: ChannelKind; name: string; display: string | null } | null;
  window: WindowView | null;
}

export interface MediaView {
  id: string;
  kind: string;
  mime: string;
  filename: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  status: "pending" | "ready" | "failed";
  animated: boolean;
  waveform: number[] | null;
  transcript: string | null;
  url: string | null;
  playableUrl: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  authorKind: "contact" | "bot" | "ai" | "agent" | "rule" | "campaign" | "system";
  authorId: string | null;
  kind: string;
  body: string | null;
  payload: Record<string, unknown>;
  mediaId: string | null;
  replyToId: string | null;
  status: MessageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  templateId: string | null;
  sentAt: string | null;
  createdAt: string;
  media: MediaView | null;
}

export interface Note {
  id: string;
  conversationId: string;
  authorKind: "agent" | "ai" | "system" | "rule";
  authorId: string | null;
  body: string;
  mentions: string[];
  createdAt: string;
}

export interface ConversationEvent {
  id: string;
  conversationId: string;
  type: string;
  fromState: string | null;
  toState: string | null;
  actorKind: string;
  actorId: string | null;
  reason: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface Consent {
  id: string;
  channelId: string;
  status: "opted_in" | "opted_out";
  source: string;
  updatedAt: string;
}

export interface ContactDetail {
  id: string;
  displayName: string | null;
  phone: string | null;
  email: string | null;
  locale: string | null;
  crmContactId: string | null;
  attributes: Record<string, unknown>;
  blocked: boolean;
  identities: Array<{ id: string; channelId: string; externalId: string }>;
  consents: Consent[];
  conversations: Array<Pick<Conversation, "id" | "channelId" | "state" | "lastMessageAt" | "lastMessagePreview" | "updatedAt">>;
}

export interface Notice {
  id: string;
  kind: string;
  conversationId: string | null;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface Me {
  userId: string;
  role: MemberRole;
  lead: boolean;
  member: { available: boolean; displayName: string } | null;
  teams: Array<{ id: string; slug: string; name: string; purpose: string }>;
  pushKey: string | null;
  copilot?: boolean;
}

export interface Counts {
  mine?: number;
  unread?: number;
  queued?: number;
  unassigned?: number;
  bot?: number;
  snoozed?: number;
  slaBreached?: number;
}

export interface WindowDetail {
  open: boolean;
  expiresAt: string | null;
  humanAgentUntil: string | null;
  personMayWrite: boolean;
  botMayWrite: boolean;
  tag: string | null;
  templates: Template[];
}

export interface QuickReply {
  id: string;
  shortcut: string;
  title: string;
  body: string | null;
  attachments: Array<{ mediaId: string }>;
}

export interface Sticker {
  id: string;
  mediaId: string;
  name: string | null;
  media: MediaView | null;
}
