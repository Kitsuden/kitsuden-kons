/**
 * @kitsuden/kon-inbox
 * ============================================================================
 *
 * A person's mailbox and calendar, synced from an account they connected in kon-connections, matched to
 * the CRM's contacts by email (kon-crm listens to this kon's events and links each message and meeting to
 * the contacts on it).
 *
 * ── PRIVACY ────────────────────────────────────────────────────────────────
 *
 *   which mailboxes   only the ones their owner adds here, one by one, choosing mail and/or calendar;
 *                     a connection alone reads nothing
 *   what is kept      sender, recipients, subject, the provider's short preview, dates. Never a body or an
 *                     attachment
 *   who sees it       the owner. A thread (or the whole mailbox, by default) marked `team` is also READ by
 *                     admins and editors. Row security enforces it (migrations/0001_inbox.sql)
 *   deleting          removing a mailbox deletes everything synced from it and its links; revoking its
 *                     connection in kon-connections does the same, by itself
 *
 * ── SYNC ───────────────────────────────────────────────────────────────────
 *
 * Through Kitsuden's queue (`kon-inbox` / `sync`), one mailbox per job, a bounded step per job: a long
 * backfill re-queues itself. Every five minutes the mailboxes not synced in the last five are queued. A host
 * without a queue runs the same step inline.
 */

import { AppError, defineKonSdk, operationsRouter, queue, unlinkAll, type AnyOperation, type AuthzUser } from "@kitsuden/engine";
import { connectedClient, ConnectionError, covers, providerOf, visibleConnection } from "@kitsuden/kon-connections";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, desc, eq, gte, inArray, lt, lte, or, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "@kitsuden/engine/zod";

import "./inbox.policy";
import {
  inboxEvents,
  inboxMailboxes,
  inboxMessages,
  inboxThreads,
  publicMailbox,
  type Mailbox,
} from "./inbox.schema";
import { isAddress, sourceOf, SourceError } from "./inbox.sources";
import { fetchChanges, storeChanges, type SyncResult } from "./inbox.sync";
import manifest from "./kon.json" with { type: "json" };
import { KON_ID, OWN, SEND, registry } from "./operations";

export * from "./inbox.schema";
export { syncMailbox } from "./inbox.sync";
export { parseAddressList, buildMime, sourceOf } from "./inbox.sources";

const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));
const QUEUE = "kon-inbox";
const SYNC_EVERY_MS = 5 * 60_000;

// ── Schemas ─────────────────────────────────────────────────────────────────

const Visibility = z.enum(["private", "team"]);
const AddMailbox = z
  .object({
    connectionId: z.string().uuid().describe("Your Google or Microsoft connection (kon-connections)"),
    syncMail: z.boolean().default(true),
    syncCalendar: z.boolean().default(true),
    defaultVisibility: Visibility.default("private").describe("`team`: admins and editors read what it brings"),
    backfillDays: z.number().int().min(0).max(365).default(30).describe("How far back the first sync reads"),
  })
  .strict();
const UpdateMailbox = z
  .object({
    syncMail: z.boolean().optional(),
    syncCalendar: z.boolean().optional(),
    defaultVisibility: Visibility.optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict();
const ParamId = z.object({ id: z.string().uuid() });
const ThreadsQuery = z.object({
  mailboxId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const EventsQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const SetVisibility = z.object({ visibility: Visibility }).strict();
const Send = z
  .object({
    to: z.array(z.string().max(320)).min(1).max(50),
    cc: z.array(z.string().max(320)).max(50).default([]),
    subject: z.string().min(1).max(500),
    text: z.string().min(1).max(100_000),
    threadId: z.string().uuid().optional().describe("Reply in this thread"),
  })
  .strict();
const Out = z.object({}).passthrough();

const who = (c: { get: (k: string) => unknown }) => (c.get("user") ?? null) as AuthzUser | null;

// ── Running a sync ──────────────────────────────────────────────────────────

const asSystemOf =
  (ctx: KonContext) =>
  <T>(fn: () => Promise<T>): Promise<T> =>
    ctx.db.asSystem ? ctx.db.asSystem(fn) : fn();

/** One step of one mailbox, as the system, in one transaction; the events go out after it commits. */
export async function runSync(ctx: KonContext, mailboxId: string, now = new Date()): Promise<SyncResult | null> {
  const asSystem = asSystemOf(ctx);
  const db = ctx.db.instance;
  const [mailbox] = (await asSystem(() => db.select().from(inboxMailboxes).where(eq(inboxMailboxes.id, mailboxId)).limit(1))) as Mailbox[];
  if (!mailbox || mailbox.status === "paused") return null;
  const source = sourceOf(mailbox.provider);
  if (!source) return null;
  const announced: Array<[string, Record<string, unknown>]> = [];
  try {
    const client = await connectedClient(ctx, {
      provider: mailbox.provider,
      connectionId: mailbox.connectionId,
      ownerId: mailbox.ownerId,
      purpose: `kon-inbox: sync ${mailbox.address}`,
      actorUserId: mailbox.ownerId,
    });
    const changes = await fetchChanges(mailbox, source, client, now);
    const result: SyncResult = (await asSystem(() =>
      db.transaction((tx: unknown) => storeChanges(tx, mailbox, changes, (name, data) => announced.push([name, data]), now))
    )) as SyncResult;
    for (const [name, data] of announced) ctx.events?.emit?.(name, data);
    return result;
  } catch (err) {
    const message =
      err instanceof ConnectionError || err instanceof SourceError ? err.message : "The sync failed; it will be retried";
    await asSystem(() =>
      db
        .update(inboxMailboxes)
        .set({ status: "error", lastError: message.slice(0, 500), lastSyncedAt: now, updatedAt: now })
        .where(eq(inboxMailboxes.id, mailboxId))
    );
    ctx.logger.warn("[inbox] sync failed", { mailboxId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Through the queue when there is one; inline otherwise. */
async function requestSync(ctx: KonContext, mailboxId: string): Promise<"queued" | "ran"> {
  if (queue.configured()) {
    await queue.dispatch(QUEUE, "sync", { mailboxId }, { reason: "kon-inbox: sync a mailbox", attempts: 3, cost: 0 });
    return "queued";
  }
  const r = await runSync(ctx, mailboxId);
  if (r?.more) void runSync(ctx, mailboxId);
  return "ran";
}

/** Deletes a mailbox, everything synced from it, and the links other kons made to it. */
export async function removeMailbox(db: unknown, mailboxId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Drizzle instance
  const d = db as any;
  const messages = await d.select({ id: inboxMessages.id }).from(inboxMessages).where(eq(inboxMessages.mailboxId, mailboxId));
  const events = await d.select({ id: inboxEvents.id }).from(inboxEvents).where(eq(inboxEvents.mailboxId, mailboxId));
  for (const m of messages) await unlinkAll({ type: "inbox_messages", id: m.id }, d);
  for (const e of events) await unlinkAll({ type: "inbox_events", id: e.id }, d);
  // Threads, messages and events go with it (ON DELETE CASCADE).
  await d.delete(inboxMailboxes).where(eq(inboxMailboxes.id, mailboxId));
}

// ── Operations ──────────────────────────────────────────────────────────────

export function inboxOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const db = () => ctx.db.instance;

  const myMailbox = async (id: string): Promise<Mailbox> => {
    const [m] = await db().select().from(inboxMailboxes).where(eq(inboxMailboxes.id, id)).limit(1);
    if (!m) throw AppError.notFound("Mailbox not found");
    return m as Mailbox;
  };

  app.get(
    "/mailboxes",
    {
      id: "list-mailboxes",
      summary: "Your synced mailboxes",
      description: "The mailboxes you added: address, what is synced (mail, calendar), default visibility, status and last sync. Only yours.",
      access: "session",
      permission: OWN,
      output: { schema: z.object({ data: z.array(Out) }) },
    },
    async (c) => {
      const rows = await db().select().from(inboxMailboxes).orderBy(asc(inboxMailboxes.createdAt));
      return c.json({ data: (rows as Mailbox[]).map(publicMailbox) });
    }
  );

  app.post(
    "/mailboxes",
    {
      id: "add-mailbox",
      summary: "Start syncing one of your connected accounts",
      description:
        "Adds the mailbox and/or calendar of `connectionId`, which must be YOUR active Google or Microsoft connection and cover `mail.read` (for mail) and `calendar.read` (for the calendar). Nothing is read until this. The first sync reads `backfillDays` back (30). 404 for a connection that is not yours, 409 when it is not active or already added, 422 when it does not cover what is asked. A person only.",
      access: "session",
      permission: OWN,
      input: { body: AddMailbox },
      output: { schema: z.object({ data: Out, sync: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const user = who(c);
      if (!user?.id || user.role === "agent") throw AppError.forbidden("Adding a mailbox to sync is a person's decision");
      const body = input.body as z.infer<typeof AddMailbox>;
      // As the caller: row security in kon-connections shows only their own.
      const connection = await visibleConnection(db(), body.connectionId);
      if (!connection || connection.scope !== "user" || connection.ownerId !== user.id) throw AppError.notFound("Connection not found");
      if (connection.status !== "active") throw AppError.conflict("That connection is not active: connect it again");
      const provider = providerOf(connection.provider);
      if (!provider || !sourceOf(connection.provider)) throw AppError.validation(`${connection.provider} has no mailbox to sync`);
      const needed = [...(body.syncMail ? ["mail.read"] : []), ...(body.syncCalendar ? ["calendar.read"] : [])];
      if (needed.length === 0) throw AppError.validation("Sync mail, calendar or both");
      if (!covers(provider, connection.grantedScopes, needed)) {
        throw AppError.validation(`The connection does not allow ${needed.join(" and ")}: connect it again asking for it`);
      }
      if (!connection.accountEmail) throw AppError.validation("The connection does not say which address it is");
      const [existing] = await db()
        .select({ id: inboxMailboxes.id })
        .from(inboxMailboxes)
        .where(and(eq(inboxMailboxes.ownerId, user.id), eq(inboxMailboxes.connectionId, connection.id)));
      if (existing) throw AppError.conflict("That mailbox is already synced");
      const [row] = await db()
        .insert(inboxMailboxes)
        .values({
          ownerId: user.id,
          connectionId: connection.id,
          provider: connection.provider,
          address: connection.accountEmail,
          syncMail: body.syncMail,
          syncCalendar: body.syncCalendar,
          defaultVisibility: body.defaultVisibility,
          backfillDays: body.backfillDays,
        })
        .returning();
      // The first sync runs after this request commits, from the queue or the worker's next pass.
      const sync = queue.configured() ? await requestSync(ctx, row.id) : "scheduled";
      return c.json({ data: publicMailbox(row), sync }, 201);
    }
  );

  app.patch(
    "/mailboxes/:id",
    {
      id: "update-mailbox",
      summary: "Change what a mailbox syncs or who sees it",
      description:
        "`syncMail`, `syncCalendar`, `defaultVisibility` (for what arrives from now on; existing threads keep theirs) and `status` (`paused` stops syncing, `active` resumes). 404 if it is not yours.",
      access: "session",
      permission: OWN,
      input: { params: ParamId, body: UpdateMailbox },
      output: { schema: z.object({ data: Out }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const current = await myMailbox(c.req.param("id"));
      const body = input.body as z.infer<typeof UpdateMailbox>;
      const [row] = await db()
        .update(inboxMailboxes)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(inboxMailboxes.id, current.id))
        .returning();
      return c.json({ data: publicMailbox(row) });
    }
  );

  app.delete(
    "/mailboxes/:id",
    {
      id: "remove-mailbox",
      summary: "Stop syncing a mailbox and delete what it brought",
      description:
        "Deletes the mailbox, every thread, message and calendar event synced from it, and the links other kons (the CRM) made to them. The connection itself stays in kon-connections. Cannot be undone. 404 if it is not yours.",
      access: "session",
      permission: OWN,
      input: { params: ParamId },
      output: { schema: z.object({ data: z.object({ id: z.string(), removed: z.boolean() }) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const m = await myMailbox(c.req.param("id"));
      await removeMailbox(db(), m.id);
      return c.json({ data: { id: m.id, removed: true } });
    }
  );

  app.post(
    "/mailboxes/:id/sync",
    {
      id: "sync-mailbox",
      summary: "Sync a mailbox now",
      description: "Queues a sync of the mailbox now (or runs it, on a Kitsuden without a queue). 404 if it is not yours.",
      access: "session",
      permission: OWN,
      input: { params: ParamId },
      output: { schema: z.object({ data: z.object({ sync: z.string() }) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const m = await myMailbox(c.req.param("id"));
      return c.json({ data: { sync: await requestSync(ctx, m.id) } });
    }
  );

  app.get(
    "/threads",
    {
      id: "list-threads",
      summary: "Email threads you may read",
      description:
        "Your threads, newest first, and for admins and editors the threads others marked `team`: subject, visibility, message count, last message. Filter by `mailboxId`. Never a message body (none is stored).",
      access: "session",
      permission: OWN,
      input: { query: ThreadsQuery },
      output: { schema: z.object({ data: z.array(Out) }) },
    },
    async (c, input) => {
      const q = input.query as z.infer<typeof ThreadsQuery>;
      const rows = await db()
        .select()
        .from(inboxThreads)
        .where(q.mailboxId ? eq(inboxThreads.mailboxId, q.mailboxId) : undefined)
        .orderBy(desc(inboxThreads.lastMessageAt))
        .limit(q.limit ?? 50);
      return c.json({ data: rows });
    }
  );

  app.get(
    "/threads/:id",
    {
      id: "get-thread",
      summary: "One thread and its messages",
      description: "The thread and its messages (sender, recipients, subject, preview, date), oldest first. 404 when you may not read it.",
      access: "session",
      permission: OWN,
      input: { params: ParamId },
      output: { schema: z.object({ data: Out }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const [thread] = await db().select().from(inboxThreads).where(eq(inboxThreads.id, c.req.param("id"))).limit(1);
      if (!thread) throw AppError.notFound("Thread not found");
      const messages = await db().select().from(inboxMessages).where(eq(inboxMessages.threadId, thread.id)).orderBy(asc(inboxMessages.sentAt)).limit(500);
      return c.json({ data: { ...thread, messages } });
    }
  );

  app.patch(
    "/threads/:id",
    {
      id: "set-thread-visibility",
      summary: "Share a thread with the team, or make it private",
      description: "`visibility: team` lets admins and editors read the thread and its messages; `private` keeps it yours. Only the mailbox's owner. 404 otherwise.",
      access: "session",
      permission: OWN,
      input: { params: ParamId, body: SetVisibility },
      output: { schema: z.object({ data: Out }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const user = who(c);
      const { visibility } = input.body as z.infer<typeof SetVisibility>;
      // The owner's own rows: an editor who READS a team thread cannot change it.
      const [thread] = await db()
        .update(inboxThreads)
        .set({ visibility })
        .where(and(eq(inboxThreads.id, c.req.param("id")), eq(inboxThreads.ownerId, user?.id ?? "")))
        .returning();
      if (!thread) throw AppError.notFound("Thread not found");
      await db().update(inboxMessages).set({ visibility }).where(eq(inboxMessages.threadId, thread.id));
      return c.json({ data: thread });
    }
  );

  app.get(
    "/events",
    {
      id: "list-events",
      summary: "Calendar events you may read",
      description: "Synced calendar events between `from` and `to` (ISO dates; default: the next 30 days), yours and those marked `team` for admins and editors.",
      access: "session",
      permission: OWN,
      input: { query: EventsQuery },
      output: { schema: z.object({ data: z.array(Out) }) },
    },
    async (c, input) => {
      const q = input.query as z.infer<typeof EventsQuery>;
      const from = q.from ? new Date(q.from) : new Date();
      const to = q.to ? new Date(q.to) : new Date(from.getTime() + 30 * 86_400_000);
      const rows = await db()
        .select()
        .from(inboxEvents)
        .where(and(or(isNull(inboxEvents.startsAt), gte(inboxEvents.startsAt, from)), or(isNull(inboxEvents.startsAt), lte(inboxEvents.startsAt, to))))
        .orderBy(asc(inboxEvents.startsAt))
        .limit(q.limit ?? 200);
      return c.json({ data: rows });
    }
  );

  app.post(
    "/mailboxes/:id/send",
    {
      id: "send-mail",
      summary: "Send an email from your mailbox",
      description:
        "Sends a plain-text email from the mailbox's own account (it shows in the provider's Sent folder and comes back with the next sync). The connection must cover `mail.send`. `threadId` replies in that thread. 404 if the mailbox is not yours, 422 for an invalid address or a connection without `mail.send`, 502 when the provider refuses. An agent's request becomes a proposal for a person.",
      access: "session",
      permission: SEND,
      sensitive: true,
      input: { params: ParamId, body: Send },
      output: { schema: z.object({ data: Out }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const m = await myMailbox(c.req.param("id"));
      const body = input.body as z.infer<typeof Send>;
      const bad = [...body.to, ...body.cc].filter((a) => !isAddress(a));
      if (bad.length) throw AppError.validation(`Not an email address: ${bad.join(", ")}`);
      let threadExternalId: string | null = null;
      if (body.threadId) {
        const [t] = await db().select().from(inboxThreads).where(and(eq(inboxThreads.id, body.threadId), eq(inboxThreads.mailboxId, m.id))).limit(1);
        if (!t) throw AppError.notFound("Thread not found");
        threadExternalId = t.externalId;
      }
      const source = sourceOf(m.provider)!;
      try {
        const client = await connectedClient(ctx, {
          provider: m.provider,
          connectionId: m.connectionId,
          ownerId: m.ownerId,
          scopeSets: ["mail.send"],
          purpose: `kon-inbox: send from ${m.address}`,
          actorUserId: who(c)?.id ?? null,
        });
        const sent = await source.send(client, {
          from: m.address,
          to: body.to.map((a) => a.trim().toLowerCase()),
          cc: body.cc.map((a) => a.trim().toLowerCase()),
          subject: body.subject,
          text: body.text,
          threadExternalId,
        });
        return c.json({ data: { sent: true, externalId: sent.externalId } }, 201);
      } catch (err) {
        if (err instanceof ConnectionError && err.code === "NO_CONNECTION") {
          throw AppError.validation("This mailbox's connection does not allow sending: connect it again asking for mail.send");
        }
        if (err instanceof ConnectionError || err instanceof SourceError) {
          throw new AppError("INTERNAL", `The provider did not send it: ${err.message}`, { status: 502, expose: true });
        }
        throw err;
      }
    }
  );

  return app.ops;
}

// ── Worker and listeners ────────────────────────────────────────────────────

/** Mailboxes not synced in the last five minutes, queued (or run). Exported for tests. */
export async function syncDue(ctx: KonContext, now = new Date()): Promise<number> {
  const asSystem = asSystemOf(ctx);
  const due = (await asSystem(() =>
    ctx.db.instance
      .select({ id: inboxMailboxes.id })
      .from(inboxMailboxes)
      .where(
        and(
          inArray(inboxMailboxes.status, ["active", "error"]),
          or(isNull(inboxMailboxes.lastSyncedAt), lt(inboxMailboxes.lastSyncedAt, new Date(now.getTime() - SYNC_EVERY_MS)))
        )
      )
      .limit(100)
  )) as Array<{ id: string }>;
  for (const m of due) await requestSync(ctx, m.id).catch(() => undefined);
  return due.length;
}

const listening = new WeakSet<object>();

/** A revoked connection takes its mailboxes and everything synced from them; an expired one pauses them. */
export function listenToConnections(ctx: KonContext): void {
  if (!ctx.events?.on || listening.has(ctx.events)) return;
  listening.add(ctx.events);
  const asSystem = asSystemOf(ctx);
  const mailboxesOf = (connectionId: string) =>
    asSystem(() => ctx.db.instance.select({ id: inboxMailboxes.id }).from(inboxMailboxes).where(eq(inboxMailboxes.connectionId, connectionId))) as Promise<
      Array<{ id: string }>
    >;
  ctx.events.on("connections:connection.revoked", (data: unknown) => {
    const id = (data as { connectionId?: string } | null)?.connectionId;
    if (!id) return;
    void (async () => {
      for (const m of await mailboxesOf(id)) await asSystem(() => ctx.db.instance.transaction((tx: unknown) => removeMailbox(tx, m.id)));
    })().catch((err) => ctx.logger.warn("[inbox] could not delete a revoked connection's mailbox", { error: String(err) }));
  });
  ctx.events.on("connections:connection.expired", (data: unknown) => {
    const id = (data as { connectionId?: string } | null)?.connectionId;
    if (!id) return;
    void asSystem(() =>
      ctx.db.instance
        .update(inboxMailboxes)
        .set({ status: "error", lastError: "The connection expired: connect it again in Connections", updatedAt: new Date() })
        .where(eq(inboxMailboxes.connectionId, id))
    ).catch(() => undefined);
  });
}

let timer: ReturnType<typeof setInterval> | null = null;

export function createKonInbox(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, inboxOperations(ctx), ctx);
}

const events = {
  emits: {
    "inbox:message.received": {
      description: "A new email was synced from a mailbox (received or sent).",
      payload: {
        messageId: "id in inbox_messages",
        mailboxId: "id",
        ownerId: "the mailbox's owner",
        from: "sender address",
        to: "list of addresses",
        cc: "list of addresses",
        subject: "subject",
        direction: "in or out",
        at: "ISO date",
        mailboxAddresses: "the mailbox's own addresses",
      },
    },
    "inbox:event.synced": {
      description: "A calendar event was synced (new or changed).",
      payload: {
        eventId: "id in inbox_events",
        mailboxId: "id",
        ownerId: "the mailbox's owner",
        title: "title",
        startsAt: "ISO date",
        endsAt: "ISO date",
        attendees: "list of addresses",
        cancelled: "true when cancelled",
        mailboxAddresses: "the mailbox's own addresses",
      },
    },
  },
  listens: ["connections:connection.revoked", "connections:connection.expired"],
};

const definition = defineKonSdk({
  id: KON_ID,
  name: "Inbox",
  version: manifest.version,
  description: "A person's mailbox and calendar, synced from a connected account and matched to CRM contacts",
  icon: "Inbox",
  mountPath: manifest.mount.path,
  operations: (ctx: KonContext) => inboxOperations(ctx),
  tables: konTables,
  admin: {
    category: manifest.admin.category as "tools",
    views: manifest.admin.views.map((v) => ({ id: v.id, type: v.type as "grid", title: v.title, table: v.table })),
  },
  dependencies: { kons: manifest.dependencies.kons, core: ["auth"] },
  hooks: {
    onStartup: async (ctx) => {
      for (const table of konTables) {
        if (!(await ctx.db.tableExists(table))) {
          ctx.logger.warn("[inbox] tables missing: run the kon's migrations", { table });
          return;
        }
      }
      queue.handle<{ mailboxId: string }>(
        QUEUE,
        async (job) => {
          const r = await runSync(ctx, job.payload.mailboxId);
          // A long backfill goes on in another job, so one mailbox never holds the queue.
          if (r?.more) await queue.dispatch(QUEUE, "sync", { mailboxId: job.payload.mailboxId }, { reason: "kon-inbox: continue a sync", cost: 0 });
        },
        { concurrency: 2 }
      );
      listenToConnections(ctx);
      if (!timer) {
        timer = setInterval(() => void syncDue(ctx).catch(() => undefined), SYNC_EVERY_MS);
        timer.unref?.();
      }
      ctx.logger.info("[inbox] ready");
    },
    onDisable: async () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  },
});

export const kon = { ...definition, ...({ events } as object) } as typeof definition;
export default kon;
