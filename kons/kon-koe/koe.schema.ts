import { bigint, boolean, date, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp } from "drizzle-orm/pg-core";

/**
 * kon-koe — omnichannel conversations
 * ============================================================================
 *
 * The tables of migrations/0000_initial.sql, for Drizzle. Row-level security lives in the migration.
 * Sealed credentials (`access_token`, `app_secret`, `private_secret`) are `jsonb` objects from
 * `ctx.secrets.seal`; they are never returned by an operation.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true });

export type ChannelKind = "whatsapp" | "messenger" | "instagram" | "webchat";
export type ConversationState = "bot" | "queued" | "human" | "snoozed" | "resolved";
export type MemberRole = "agent" | "supervisor" | "admin";
export type AuthorKind = "contact" | "bot" | "ai" | "agent" | "rule" | "campaign" | "system";
export type MessageStatus = "received" | "queued" | "sent" | "delivered" | "read" | "failed";
export type MediaKind = "image" | "audio" | "voice" | "video" | "document" | "sticker";

export interface ChannelSettings {
  greeting?: string;
  /** Inactivity after which an open conversation resolves itself (hours). */
  autoResolveHours?: number;
  /** Words that opt a contact out ("STOP", "BAJA"). */
  optOutKeywords?: string[];
  optInKeywords?: string[];
  /** Messages per second the channel may send (Meta's per-number throughput). */
  ratePerSecond?: number;
  /** Graph API version pinned for this channel. */
  graphVersion?: string;
  /** Web chat: sites that may embed it. Empty = any. */
  allowedOrigins?: string[];
  /** Web chat: ask for name and email before the first message. */
  preChatForm?: boolean;
  /** What a resolved conversation becomes when the contact writes again. */
  reopenAs?: "bot" | "queued";
  /** Bot flow to run in the `bot` state when there is no AI bot (koe_flows.id). */
  flowId?: string;
  /** Failures (fallbacks) after which the bot asks for a person. */
  maxBotFailures?: number;
  /** Words that ask for a person ("agente", "humano"). */
  handoffKeywords?: string[];
}

export const koeMembers = pgTable("koe_members", {
  userId: text("user_id").primaryKey(),
  role: text("role").$type<MemberRole>().notNull().default("agent"),
  displayName: text("display_name").notNull(),
  maxConcurrent: integer("max_concurrent").notNull().default(10),
  available: boolean("available").notNull().default(true),
  lastSeenAt: ts("last_seen_at"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const koeTeams = pgTable("koe_teams", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  purpose: text("purpose").$type<"support" | "sales" | "collections">().notNull().default("support"),
  timezone: text("timezone").notNull().default("UTC"),
  businessHours: jsonb("business_hours").$type<Record<string, Array<[string, string]>>>().notNull().default({}),
  assignment: text("assignment").$type<"round_robin" | "load" | "manual">().notNull().default("round_robin"),
  slaFirstResponseS: integer("sla_first_response_s"),
  slaResolutionS: integer("sla_resolution_s"),
  lastAssignedUserId: text("last_assigned_user_id"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const koeTeamMembers = pgTable(
  "koe_team_members",
  {
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })]
);

export const koeChannels = pgTable("koe_channels", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<ChannelKind>().notNull(),
  name: text("name").notNull(),
  externalId: text("external_id").notNull(),
  accountId: text("account_id"),
  display: text("display"),
  accessToken: jsonb("access_token"),
  appSecret: jsonb("app_secret"),
  status: text("status").$type<"active" | "disabled" | "error">().notNull().default("active"),
  statusDetail: text("status_detail"),
  quality: text("quality"),
  messagingLimit: text("messaging_limit"),
  botSlug: text("bot_slug"),
  defaultTeamId: text("default_team_id"),
  settings: jsonb("settings").$type<ChannelSettings>().notNull().default({}),
  createdAt: ts("created_at").defaultNow().notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

export const koeContacts = pgTable("koe_contacts", {
  id: text("id").primaryKey(),
  displayName: text("display_name"),
  phone: text("phone"),
  email: text("email"),
  locale: text("locale"),
  crmContactId: text("crm_contact_id"),
  attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
  blocked: boolean("blocked").notNull().default(false),
  createdAt: ts("created_at").defaultNow().notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

export const koeIdentities = pgTable("koe_identities", {
  id: text("id").primaryKey(),
  contactId: text("contact_id").notNull(),
  channelId: text("channel_id").notNull(),
  externalId: text("external_id").notNull(),
  profile: jsonb("profile").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export interface ConversationMetadata {
  referral?: Record<string, unknown>;
  handoffSummary?: string;
  flow?: { flowId: string; node: string; vars: Record<string, string> };
  [key: string]: unknown;
}

export const koeConversations = pgTable("koe_conversations", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  identityId: text("identity_id").notNull(),
  contactId: text("contact_id").notNull(),
  state: text("state").$type<ConversationState>().notNull().default("bot"),
  assigneeId: text("assignee_id"),
  teamId: text("team_id"),
  priority: text("priority").$type<"low" | "normal" | "high" | "urgent">().notNull().default("normal"),
  labels: jsonb("labels").$type<string[]>().notNull().default([]),
  lastInboundAt: ts("last_inbound_at"),
  lastOutboundAt: ts("last_outbound_at"),
  lastMessageAt: ts("last_message_at"),
  lastMessagePreview: text("last_message_preview"),
  windowExpiresAt: ts("window_expires_at"),
  freeEntryUntil: ts("free_entry_until"),
  windowWarnedAt: ts("window_warned_at"),
  unreadCount: integer("unread_count").notNull().default(0),
  snoozedUntil: ts("snoozed_until"),
  firstResponseDueAt: ts("first_response_due_at"),
  resolutionDueAt: ts("resolution_due_at"),
  firstRespondedAt: ts("first_responded_at"),
  slaBreached: boolean("sla_breached").notNull().default(false),
  resolvedAt: ts("resolved_at"),
  crmDealId: text("crm_deal_id"),
  botFailures: integer("bot_failures").notNull().default(0),
  metadata: jsonb("metadata").$type<ConversationMetadata>().notNull().default({}),
  createdAt: ts("created_at").defaultNow().notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

export const koeMedia = pgTable("koe_media", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id"),
  kind: text("kind").$type<MediaKind>().notNull(),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes"),
  durationMs: integer("duration_ms"),
  filename: text("filename"),
  sha256: text("sha256"),
  storageKey: text("storage_key"),
  metaMediaId: text("meta_media_id"),
  metaMediaChannelId: text("meta_media_channel_id"),
  metaMediaExpiresAt: ts("meta_media_expires_at"),
  playableKey: text("playable_key"),
  waveform: jsonb("waveform").$type<number[] | null>(),
  transcript: text("transcript"),
  animated: boolean("animated").notNull().default(false),
  status: text("status").$type<"pending" | "ready" | "failed">().notNull().default("pending"),
  error: text("error"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const koeMessages = pgTable("koe_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  channelId: text("channel_id").notNull(),
  direction: text("direction").$type<"in" | "out">().notNull(),
  authorKind: text("author_kind").$type<AuthorKind>().notNull(),
  authorId: text("author_id"),
  kind: text("kind").notNull(),
  body: text("body"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  mediaId: text("media_id"),
  replyToId: text("reply_to_id"),
  externalId: text("external_id"),
  status: text("status").$type<MessageStatus>().notNull(),
  statusRank: smallint("status_rank").notNull().default(0),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  templateId: text("template_id"),
  idempotencyKey: text("idempotency_key").unique(),
  sentAt: ts("sent_at"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const koeConversationEvents = pgTable("koe_conversation_events", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  type: text("type").notNull(),
  fromState: text("from_state"),
  toState: text("to_state"),
  actorKind: text("actor_kind").notNull(),
  actorId: text("actor_id"),
  reason: text("reason"),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const koeNotes = pgTable("koe_notes", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  authorKind: text("author_kind").$type<"agent" | "ai" | "system" | "rule">().notNull().default("agent"),
  authorId: text("author_id"),
  body: text("body").notNull(),
  mentions: jsonb("mentions").$type<string[]>().notNull().default([]),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export interface TemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
  text?: string;
  buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string; example?: unknown }>;
  example?: unknown;
}

export const koeTemplates = pgTable("koe_templates", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  externalId: text("external_id"),
  name: text("name").notNull(),
  language: text("language").notNull(),
  category: text("category").$type<"marketing" | "utility" | "authentication">().notNull(),
  status: text("status").$type<"approved" | "pending" | "rejected" | "paused" | "disabled" | "in_appeal" | "deleted">().notNull(),
  components: jsonb("components").$type<TemplateComponent[]>().notNull().default([]),
  quality: text("quality"),
  rejectedReason: text("rejected_reason"),
  syncedAt: ts("synced_at"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const koeQuickReplies = pgTable("koe_quick_replies", {
  id: text("id").primaryKey(),
  shortcut: text("shortcut").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  attachments: jsonb("attachments").$type<Array<{ mediaId: string }>>().notNull().default([]),
  scope: text("scope").$type<"personal" | "team" | "global">().notNull().default("global"),
  ownerId: text("owner_id"),
  teamId: text("team_id"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const koeStickers = pgTable("koe_stickers", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  name: text("name"),
  createdBy: text("created_by"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const koeConsents = pgTable("koe_consents", {
  id: text("id").primaryKey(),
  contactId: text("contact_id").notNull(),
  channelId: text("channel_id").notNull(),
  status: text("status").$type<"opted_in" | "opted_out">().notNull(),
  source: text("source").notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

export const koeWebhookEvents = pgTable("koe_webhook_events", {
  id: text("id").primaryKey(),
  channelKind: text("channel_kind").notNull(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  payload: jsonb("payload").$type<unknown>().notNull(),
  receivedAt: ts("received_at").defaultNow().notNull(),
  processedAt: ts("processed_at"),
  error: text("error"),
});

export const koePushSubscriptions = pgTable("koe_push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh"),
  authSecret: text("auth_secret"),
  userAgent: text("user_agent"),
  createdAt: ts("created_at").defaultNow().notNull(),
  lastUsedAt: ts("last_used_at"),
});

export const koeNotices = pgTable("koe_notices", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),
  conversationId: text("conversation_id"),
  title: text("title").notNull(),
  body: text("body"),
  readAt: ts("read_at"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const koeConfig = pgTable("koe_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  privateSecret: jsonb("private_secret"),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

export interface CampaignSegment {
  contactIds?: string[];
  labels?: string[];
  attributes?: Record<string, string | number | boolean>;
}

export const koeCampaigns = pgTable("koe_campaigns", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  name: text("name").notNull(),
  templateId: text("template_id").notNull(),
  variables: jsonb("variables").$type<Record<string, string>>().notNull().default({}),
  segment: jsonb("segment").$type<CampaignSegment>().notNull().default({}),
  status: text("status").$type<"draft" | "scheduled" | "running" | "paused" | "done" | "cancelled">().notNull().default("draft"),
  scheduledAt: ts("scheduled_at"),
  ratePerMinute: integer("rate_per_minute").notNull().default(60),
  quietHours: jsonb("quiet_hours").$type<{ from: string; to: string; timezone: string } | null>(),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 4 }),
  createdBy: text("created_by"),
  approvedBy: text("approved_by"),
  stats: jsonb("stats").$type<Record<string, number>>().notNull().default({}),
  createdAt: ts("created_at").defaultNow().notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

export const koeCampaignRecipients = pgTable("koe_campaign_recipients", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  contactId: text("contact_id").notNull(),
  variables: jsonb("variables").$type<Record<string, string>>().notNull().default({}),
  status: text("status").$type<"pending" | "sent" | "failed" | "skipped">().notNull().default("pending"),
  messageId: text("message_id"),
  error: text("error"),
  sentAt: ts("sent_at"),
});

export type SequenceStep = { delayMinutes: number } & ({ templateId: string; variables?: Record<string, string> } | { text: string });

export const koeSequences = pgTable("koe_sequences", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  channelId: text("channel_id").notNull(),
  steps: jsonb("steps").$type<SequenceStep[]>().notNull().default([]),
  stopOnReply: boolean("stop_on_reply").notNull().default(true),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const koeSequenceRuns = pgTable("koe_sequence_runs", {
  id: text("id").primaryKey(),
  sequenceId: text("sequence_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  step: integer("step").notNull().default(0),
  nextAt: ts("next_at"),
  status: text("status").$type<"running" | "stopped" | "done">().notNull().default("running"),
  startedAt: ts("started_at").defaultNow().notNull(),
});

export const koeFlows = pgTable("koe_flows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  channelId: text("channel_id"),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").defaultNow().notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

export const koePromises = pgTable("koe_promises", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id"),
  contactId: text("contact_id").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  dueDate: date("due_date").notNull(),
  status: text("status").$type<"pending" | "kept" | "broken" | "cancelled">().notNull().default("pending"),
  reference: text("reference"),
  note: text("note"),
  remindedAt: ts("reminded_at"),
  createdBy: text("created_by"),
  createdAt: ts("created_at").defaultNow().notNull(),
  resolvedAt: ts("resolved_at"),
});

export const koeOutcomes = pgTable("koe_outcomes", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  kind: text("kind")
    .$type<"contacted" | "no_answer" | "promise" | "paid" | "refused" | "wrong_number" | "won" | "lost" | "follow_up">()
    .notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }),
  currency: text("currency"),
  note: text("note"),
  authorId: text("author_id"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export type Channel = typeof koeChannels.$inferSelect;
export type Conversation = typeof koeConversations.$inferSelect;
export type Message = typeof koeMessages.$inferSelect;
export type Contact = typeof koeContacts.$inferSelect;
export type Template = typeof koeTemplates.$inferSelect;
export type Media = typeof koeMedia.$inferSelect;
