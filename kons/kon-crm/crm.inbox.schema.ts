import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Mailboxes, threads, messages and calendar events synced from a connected account
 * ============================================================================
 *
 * Only what a timeline needs: who, to whom, the subject, a short preview (the provider's snippet), when.
 * Never a full body, never an attachment. Row security (migrations/0015_inbox.sql): the owner sees
 * everything of theirs, admins and editors read what is marked `team`, the sync worker (the system) all.
 */

export type Visibility = "private" | "team";

export const inboxMailboxes = pgTable("crm_inbox_mailboxes", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  connectionId: text("connection_id").notNull(),
  provider: text("provider").notNull(),
  address: text("address").notNull(),
  syncMail: boolean("sync_mail").notNull().default(true),
  syncCalendar: boolean("sync_calendar").notNull().default(true),
  defaultVisibility: text("default_visibility").$type<Visibility>().notNull().default("private"),
  backfillDays: integer("backfill_days").notNull().default(30),
  status: text("status").$type<"active" | "paused" | "error">().notNull().default("active"),
  mailCursor: jsonb("mail_cursor").$type<Record<string, unknown> | null>(),
  calendarCursor: jsonb("calendar_cursor").$type<Record<string, unknown> | null>(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const inboxThreads = pgTable(
  "crm_inbox_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id").notNull(),
    ownerId: text("owner_id").notNull(),
    externalId: text("external_id").notNull(),
    subject: text("subject").notNull().default(""),
    visibility: text("visibility").$type<Visibility>().notNull().default("private"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    messageCount: integer("message_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("crm_inbox_threads_mailbox_id_external_id_key").on(t.mailboxId, t.externalId)]
);

export const inboxMessages = pgTable(
  "crm_inbox_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id").notNull(),
    threadId: uuid("thread_id"),
    ownerId: text("owner_id").notNull(),
    externalId: text("external_id").notNull(),
    direction: text("direction").$type<"in" | "out">().notNull(),
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    toAddresses: jsonb("to_addresses").$type<string[]>().notNull().default([]),
    ccAddresses: jsonb("cc_addresses").$type<string[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    visibility: text("visibility").$type<Visibility>().notNull().default("private"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("crm_inbox_messages_mailbox_id_external_id_key").on(t.mailboxId, t.externalId),
    index("crm_inbox_messages_thread_idx").on(t.threadId, t.sentAt),
  ]
);

export const inboxEvents = pgTable(
  "crm_inbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id").notNull(),
    ownerId: text("owner_id").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull().default(""),
    location: text("location"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    attendees: jsonb("attendees").$type<string[]>().notNull().default([]),
    organizer: text("organizer"),
    cancelled: boolean("cancelled").notNull().default(false),
    visibility: text("visibility").$type<Visibility>().notNull().default("private"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("crm_inbox_events_mailbox_id_external_id_key").on(t.mailboxId, t.externalId)]
);

export type Mailbox = typeof inboxMailboxes.$inferSelect;
export type InboxMessage = typeof inboxMessages.$inferSelect;
export type InboxEvent = typeof inboxEvents.$inferSelect;

/** A mailbox as it leaves the kon: the cursors are the provider's internals. */
export function publicMailbox(m: Mailbox) {
  return {
    id: m.id,
    connectionId: m.connectionId,
    provider: m.provider,
    address: m.address,
    syncMail: m.syncMail,
    syncCalendar: m.syncCalendar,
    defaultVisibility: m.defaultVisibility,
    backfillDays: m.backfillDays,
    status: m.status,
    lastSyncedAt: m.lastSyncedAt ? new Date(m.lastSyncedAt).toISOString() : null,
    lastError: m.lastError ?? null,
    createdAt: new Date(m.createdAt).toISOString(),
  };
}
