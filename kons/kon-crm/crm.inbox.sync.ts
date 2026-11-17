/**
 * One sync of one mailbox
 * ============================================================================
 *
 * Reads what is new since the mailbox's cursors (inbox.sources.ts) WITHOUT holding a transaction (a slow
 * provider must not keep one open), then stores it, moves the cursors in one short transaction, and
 * announces each NEW message and each new or changed calendar event:
 *
 *   crm:message.received  { messageId, mailboxId, ownerId, from, fromName, visibility, to, cc, subject, direction, at, mailboxAddresses }
 *   crm:meeting.synced      { eventId, visibility, mailboxId, ownerId, title, startsAt, endsAt, attendees, organizer, cancelled, mailboxAddresses }
 *
 * `mailboxAddresses` is the mailbox's own address, so a listener (crm.connected.ts) never treats the owner as a
 * contact. A message stored twice (a retried job, an overlapping page) is one row and one announcement:
 * the insert is `ON CONFLICT DO NOTHING` and only what it returns is announced.
 *
 * It runs as the system (the sync job), and writes rows with the mailbox owner's `owner_id`, so row
 * security shows them to that person and, when marked `team`, to the team.
 */

import { and, eq, sql } from "drizzle-orm";

import { inboxEvents, inboxMailboxes, inboxMessages, inboxThreads, type Mailbox } from "./crm.inbox.schema";
import type { Batch, Fetcher, MailSource, SyncedEvent, SyncedMessage } from "./crm.inbox.sources";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Drizzle instance or transaction
type Db = any;
export type Emit = (name: string, data: Record<string, unknown>) => void;

export interface SyncResult {
  messages: number;
  events: number;
  /** Something is left for another run (a long backfill). */
  more: boolean;
}

async function storeMessage(db: Db, mailbox: Mailbox, m: SyncedMessage): Promise<{ id: string; visibility: string } | null> {
  const [thread] = await db
    .insert(inboxThreads)
    .values({
      mailboxId: mailbox.id,
      ownerId: mailbox.ownerId,
      externalId: m.threadExternalId,
      subject: m.subject,
      visibility: mailbox.defaultVisibility,
      lastMessageAt: m.sentAt,
    })
    .onConflictDoUpdate({
      target: [inboxThreads.mailboxId, inboxThreads.externalId],
      set: { lastMessageAt: sql`GREATEST(${inboxThreads.lastMessageAt}, ${m.sentAt.toISOString()}::timestamptz)` },
    })
    .returning({ id: inboxThreads.id, visibility: inboxThreads.visibility });

  const [created] = await db
    .insert(inboxMessages)
    .values({
      mailboxId: mailbox.id,
      threadId: thread.id,
      ownerId: mailbox.ownerId,
      externalId: m.externalId,
      direction: m.direction,
      fromAddress: m.fromAddress,
      fromName: m.fromName,
      toAddresses: m.to,
      ccAddresses: m.cc,
      subject: m.subject,
      snippet: m.snippet,
      visibility: thread.visibility,
      sentAt: m.sentAt,
    })
    .onConflictDoNothing()
    .returning({ id: inboxMessages.id });
  if (!created) return null;
  await db
    .update(inboxThreads)
    .set({ messageCount: sql`${inboxThreads.messageCount} + 1` })
    .where(eq(inboxThreads.id, thread.id));
  return { id: created.id, visibility: thread.visibility };
}

async function storeEvent(db: Db, mailbox: Mailbox, e: SyncedEvent): Promise<{ id: string; visibility: string }> {
  const values = {
    title: e.title,
    location: e.location,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    attendees: e.attendees,
    organizer: e.organizer,
    cancelled: e.cancelled,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(inboxEvents)
    .values({ ...values, mailboxId: mailbox.id, ownerId: mailbox.ownerId, externalId: e.externalId, visibility: mailbox.defaultVisibility })
    .onConflictDoUpdate({ target: [inboxEvents.mailboxId, inboxEvents.externalId], set: values })
    .returning({ id: inboxEvents.id, visibility: inboxEvents.visibility });
  return row;
}

export interface Changes {
  mail: Batch<SyncedMessage> | null;
  calendar: Batch<SyncedEvent> | null;
}

/** Phase 1, the network: what is new at the provider. No database transaction is held meanwhile. */
export async function fetchChanges(mailbox: Mailbox, source: MailSource, client: Fetcher, now = new Date()): Promise<Changes> {
  const since = new Date(now.getTime() - mailbox.backfillDays * 86_400_000);
  return {
    mail: mailbox.syncMail ? await source.mail(client, mailbox.mailCursor ?? null, since) : null,
    calendar: mailbox.syncCalendar ? await source.calendar(client, mailbox.calendarCursor ?? null, since) : null,
  };
}

/** Phase 2, the database: store, move the cursors, and hand back what to announce. Run it in one transaction. */
export async function storeChanges(db: Db, mailbox: Mailbox, changes: Changes, emit: Emit, now = new Date()): Promise<SyncResult> {
  const result: SyncResult = { messages: 0, events: 0, more: false };
  const own = [mailbox.address.toLowerCase()];
  const announced: Array<[string, Record<string, unknown>]> = [];

  if (changes.mail) {
    for (const m of changes.mail.items) {
      const stored = await storeMessage(db, mailbox, m);
      if (!stored) continue;
      result.messages++;
      announced.push([
        "crm:message.received",
        {
          messageId: stored.id,
          mailboxId: mailbox.id,
          ownerId: mailbox.ownerId,
          from: m.fromAddress,
          fromName: m.fromName,
          visibility: stored.visibility,
          to: m.to,
          cc: m.cc,
          subject: m.subject,
          direction: m.direction,
          at: m.sentAt.toISOString(),
          mailboxAddresses: own,
        },
      ]);
    }
    await db
      .update(inboxMailboxes)
      .set({ mailCursor: changes.mail.reset ? null : changes.mail.cursor })
      .where(eq(inboxMailboxes.id, mailbox.id));
    result.more ||= changes.mail.more;
  }

  if (changes.calendar) {
    for (const e of changes.calendar.items) {
      const stored = await storeEvent(db, mailbox, e);
      result.events++;
      announced.push([
        "crm:meeting.synced",
        {
          eventId: stored.id,
          visibility: stored.visibility,
          mailboxId: mailbox.id,
          ownerId: mailbox.ownerId,
          title: e.title,
          startsAt: e.startsAt?.toISOString() ?? null,
          endsAt: e.endsAt?.toISOString() ?? null,
          attendees: e.attendees,
          organizer: e.organizer,
          cancelled: e.cancelled,
          mailboxAddresses: own,
        },
      ]);
    }
    await db
      .update(inboxMailboxes)
      .set({ calendarCursor: changes.calendar.reset ? null : changes.calendar.cursor })
      .where(eq(inboxMailboxes.id, mailbox.id));
    result.more ||= changes.calendar.more;
  }

  await db
    .update(inboxMailboxes)
    .set({ lastSyncedAt: now, lastError: null, status: "active", updatedAt: now })
    .where(and(eq(inboxMailboxes.id, mailbox.id)));
  for (const [name, data] of announced) emit(name, data);
  return result;
}

/** Both phases, for a caller that handles its own transaction (tests, a manual run). */
export async function syncMailbox(
  db: Db,
  mailbox: Mailbox,
  source: MailSource,
  client: Fetcher,
  emit: Emit,
  now = new Date()
): Promise<SyncResult> {
  return storeChanges(db, mailbox, await fetchChanges(mailbox, source, client, now), emit, now);
}
