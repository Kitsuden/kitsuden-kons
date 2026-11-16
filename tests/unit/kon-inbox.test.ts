/**
 * kon-inbox: sync a mailbox through Kitsuden's connections, keep each person's mail theirs, and feed the CRM
 * ============================================================================
 *
 * One PGlite with the core's `kitsuden_links`, kon-inbox and kon-crm, as a NON-superuser role: the two
 * kons installed together, the way the CRM's timeline gets mail. Kitsuden's `ctx.connections` is a double
 * with its contract (`client`, `visible`, `covers`): the core's own suite tests the real one. The provider is a `fetch`
 * double that answers like Gmail, Google Calendar and Microsoft Graph.
 *
 * What these tests hold:
 *   - the first sync backfills, the next ones read only what is new, and a message is announced once;
 *   - an expired cursor (Gmail 404, Graph 410) starts over instead of failing forever;
 *   - only metadata is stored: no body;
 *   - a person adds only their own connection, and only when it covers what they ask for;
 *   - each person reads only their mail; admins and editors read only what was marked `team`;
 *   - removing a mailbox, or revoking its connection, deletes what it brought and the CRM's links to it;
 *   - what this kon announces is exactly what kon-crm reads: a message lands on the contact's timeline;
 *   - sending builds a message no header can be injected into.
 */

import type { PGlite } from "@electric-sql/pglite";
import { PGlite as PG } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { operationsRouter } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { onInboxMessage } from "../../kons/kon-crm/crm.connected";
import { timelineOf } from "../../kons/kon-crm/crm.timeline";
import { buildMime, parseAddressList, sourceOf } from "../../kons/kon-inbox/inbox.sources";
import { syncMailbox } from "../../kons/kon-inbox/inbox.sync";
import { inboxOperations, listenToConnections, runSync } from "../../kons/kon-inbox/index";
import { KON_ID } from "../../kons/kon-inbox/operations";
import { registerInboxPolicy } from "../../kons/kon-inbox/inbox.policy";
import { inboxMailboxes, type Mailbox } from "../../kons/kon-inbox/inbox.schema";
import { eq } from "drizzle-orm";

import { configureQueue } from "../../.kitsuden/packages/engine/src/queue";

import { ACTORS, AGENT_FUNCTIONS, APP_ROLE, dropToAppRole, requestAs, testAuth } from "./helpers/safe-kons-bench";

const A = ACTORS.a.id;
const B = ACTORS.b.id;
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

// ── The provider double ────────────────────────────────────────────────────

type Handler = (url: URL, init?: RequestInit) => Response | undefined;
const calls: Array<{ url: string; init?: RequestInit }> = [];
let handlers: Handler[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const network = async (url: string, init?: RequestInit): Promise<Response> => {
  calls.push({ url, init });
  const u = new URL(url);
  for (const h of handlers) {
    const r = h(u, init);
    if (r) return r;
  }
  return json({ error: "not found" }, 404);
};
const client = { fetch: network };

const gmailMessage = (id: string, over: { from?: string; to?: string; cc?: string; subject?: string; labels?: string[]; at?: number; thread?: string } = {}) => ({
  id,
  threadId: over.thread ?? `t-${id}`,
  labelIds: over.labels ?? ["INBOX"],
  snippet: `Preview of ${id}`,
  internalDate: String(over.at ?? Date.parse("2026-11-10T10:00:00Z")),
  payload: {
    headers: [
      { name: "From", value: over.from ?? '"Luis Paz" <luis@client.example>' },
      { name: "To", value: over.to ?? "me@firm.example" },
      ...(over.cc ? [{ name: "Cc", value: over.cc }] : []),
      { name: "Subject", value: over.subject ?? `Subject ${id}` },
    ],
  },
});

function gmail(messages: Record<string, ReturnType<typeof gmailMessage>>, history: Array<{ id: string }> = [], historyStatus = 200): Handler {
  return (u) => {
    if (u.href === `${GMAIL}/profile`) return json({ emailAddress: "me@firm.example", historyId: "100" });
    if (u.pathname.endsWith("/messages") && u.origin === "https://gmail.googleapis.com") {
      return json({ messages: Object.keys(messages).map((id) => ({ id })) });
    }
    const m = /\/messages\/([^/]+)$/.exec(u.pathname);
    if (m && messages[m[1]!]) return json(messages[m[1]!]);
    if (u.pathname.endsWith("/history")) {
      if (historyStatus !== 200) return json({ error: "gone" }, historyStatus);
      return json({ history: [{ messagesAdded: history.map((h) => ({ message: { id: h.id } })) }], historyId: "200" });
    }
    if (u.origin + u.pathname === CAL) {
      return json({
        items: [
          { id: "ev1", summary: "Kickoff", status: "confirmed", start: { dateTime: "2026-11-20T15:00:00Z" }, end: { dateTime: "2026-11-20T16:00:00Z" }, attendees: [{ email: "luis@client.example" }, { email: "me@firm.example" }] },
          { id: "ev2", summary: "Dropped", status: "cancelled" },
        ],
        nextSyncToken: "sync-1",
      });
    }
    return undefined;
  };
}

// ── Database ───────────────────────────────────────────────────────────────

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a drizzle over PGlite
let db: any;
const connA = "11111111-1111-4111-8111-111111111111";
const connB = "22222222-2222-4222-8222-222222222222";
let request: ReturnType<typeof requestAs>;
const emitted: Array<{ name: string; data: Record<string, unknown> }> = [];
const busHandlers = new Map<string, Array<(d: unknown) => void>>();
const saved: Record<string, string | undefined> = {};

async function ex(sql: string): Promise<void> {
  await pg.exec(`RESET ROLE; ${sql}; SET ROLE ${APP_ROLE};`);
}
async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  await pg.exec("RESET ROLE");
  try {
    return (await pg.query<T>(sql)).rows;
  } finally {
    await pg.exec(`SET ROLE ${APP_ROLE}`);
  }
}

/** Kitsuden's `ctx.connections`, as a double: two people's Google accounts, one able to read and send. */
const GOOGLE_SCOPES: Record<string, string[]> = {
  "mail.read": ["https://www.googleapis.com/auth/gmail.readonly"],
  "mail.send": ["https://www.googleapis.com/auth/gmail.send"],
  "calendar.read": ["https://www.googleapis.com/auth/calendar.readonly"],
};
const accounts = [
  { id: connA, provider: "google", scope: "user" as const, ownerId: A, accountEmail: "me@firm.example", status: "active" as const, grantedScopes: Object.values(GOOGLE_SCOPES).flat() },
  { id: connB, provider: "google", scope: "user" as const, ownerId: B, accountEmail: "beto@firm.example", status: "active" as const, grantedScopes: ["openid"] },
];
const asked: Array<{ konId: string; purpose: string; connectionId?: string; ownerId?: string | null }> = [];
const covers = (_provider: string, granted: string[], sets: string[]) => sets.every((set) => (GOOGLE_SCOPES[set] ?? [set]).every((x) => granted.includes(x)));
const connections = {
  async client(konId: string, req: { provider: string; ownerId?: string | null; connectionId?: string; scopeSets?: string[]; purpose: string }) {
    asked.push({ konId, purpose: req.purpose, connectionId: req.connectionId, ownerId: req.ownerId });
    const account = accounts.find((a) => a.id === req.connectionId && a.ownerId === req.ownerId && covers(a.provider, a.grantedScopes, req.scopeSets ?? []));
    if (!account) throw Object.assign(new Error("No connection covers this"), { name: "ConnectionError", status: 404, code: "NO_CONNECTION" });
    return {
      connection: account,
      fetch: (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", "Bearer tok");
        return network(url, { ...init, headers });
      },
    };
  },
  async visible(_konId: string, id: string) {
    return accounts.find((a) => a.id === id) ?? null;
  },
  covers,
};

beforeAll(async () => {
  pg = new PG();
  await pg.exec(readFileSync(AGENT_FUNCTIONS, "utf8"));
  await pg.exec(readFileSync(resolve(__dirname, "../../.kitsuden/apps/api/src/db/migrations/0032_links.sql"), "utf8"));
  const crmDir = resolve(__dirname, "../../kons/kon-crm/migrations");
  for (const f of readdirSync(crmDir).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(readFileSync(resolve(crmDir, f), "utf8"));
  await pg.exec(readFileSync(resolve(__dirname, "../../kons/kon-inbox/migrations/0001_inbox.sql"), "utf8"));
  await pg.exec(`
    CREATE ROLE ${APP_ROLE} NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    INSERT INTO crm_contacts (id, first_name, last_name, email) VALUES ('c-luis', 'Luis', 'Paz', 'luis@client.example');
  `);
  db = await dropToAppRole(pg);
  registerInboxPolicy();
  // The host's queue writes to its outbox table, which this database does not have; each test that
  // needs a queue plugs in its own.
  configureQueue(null);

  const auth = testAuth();
  const host = rlsHost(db, auth);
  const events = {
    emit: (name: string, data: Record<string, unknown>) => emitted.push({ name, data }),
    on: (name: string, h: (d: unknown) => void) => busHandlers.set(name, [...(busHandlers.get(name) ?? []), h]),
    off: () => undefined,
  };
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never, events: events as never });
  Object.assign(ctx, { connections });
  request = requestAs(host.mount(operationsRouter(KON_ID, inboxOperations(ctx), ctx)));
  listenToConnections(ctx);
  (globalThis as { __inboxCtx?: unknown }).__inboxCtx = ctx;
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  calls.length = 0;
  emitted.length = 0;
  handlers = [];
  saved.fetch = undefined;
  vi.stubGlobal("fetch", network);
  await ex("DELETE FROM inbox_mailboxes; DELETE FROM kitsuden_links");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mailboxOf(owner: string, connection: string, visibility: "private" | "team" = "private"): Promise<Mailbox> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO inbox_mailboxes (owner_id, connection_id, provider, address, default_visibility) VALUES ('${owner}', '${connection}', 'google', 'me@firm.example', '${visibility}') RETURNING id`
  );
  const [m] = await db.select().from(inboxMailboxes).where(eq(inboxMailboxes.id, row!.id));
  return m as Mailbox;
}

const collect = () => {
  const out: Array<{ name: string; data: Record<string, unknown> }> = [];
  return { out, emit: (name: string, data: Record<string, unknown>) => out.push({ name, data }) };
};

describe("addresses and sending", () => {
  it("parses address lists with names and quoted commas", () => {
    expect(parseAddressList('"Paz, Luis" <Luis@Client.example>, ana@x.example, not-an-address')).toEqual([
      { name: "Paz, Luis", address: "luis@client.example" },
      { name: null, address: "ana@x.example" },
    ]);
  });

  it("a subject or address cannot inject a header, and UTF-8 is encoded", () => {
    const mime = buildMime({ from: "me@firm.example", to: ["luis@client.example"], cc: [], subject: "Hola\r\nBcc: victim@x.example", text: "Año nuevo" });
    expect(mime).not.toMatch(/\r\nBcc:/);
    expect(mime).toContain("Subject: Hola Bcc: victim@x.example");
    const utf = buildMime({ from: "me@firm.example", to: ["a@b.example"], cc: [], subject: "Reunión", text: "x" });
    expect(utf).toContain("Subject: =?UTF-8?B?");
  });
});

describe("Gmail sync", () => {
  it("backfills, then reads only what is new, announcing each message once", async () => {
    const m = await mailboxOf(A, connA);
    handlers = [gmail({ m1: gmailMessage("m1"), m2: gmailMessage("m2", { labels: ["SENT"], from: "me@firm.example", to: "luis@client.example" }) })];
    const first = collect();
    const r1 = await syncMailbox(db, m, sourceOf("google")!, client, first.emit);
    expect(r1).toMatchObject({ messages: 2, events: 2, more: false });
    expect(first.out.filter((e) => e.name === "inbox:message.received").map((e) => e.data.direction).sort()).toEqual(["in", "out"]);
    expect(first.out[0]!.data).toMatchObject({ mailboxAddresses: ["me@firm.example"] });

    const [row] = await q<{ mail_cursor: Record<string, unknown>; calendar_cursor: Record<string, unknown> }>(`SELECT mail_cursor, calendar_cursor FROM inbox_mailboxes`);
    expect(row).toEqual({ mail_cursor: { historyId: "100" }, calendar_cursor: { syncToken: "sync-1" } });

    // Next run: history adds m3 and repeats m1.
    const [again] = await db.select().from(inboxMailboxes).where(eq(inboxMailboxes.id, m.id));
    handlers = [gmail({ m1: gmailMessage("m1"), m3: gmailMessage("m3", { thread: "t-m1" }) }, [{ id: "m3" }, { id: "m1" }])];
    const second = collect();
    const r2 = await syncMailbox(db, { ...again, syncCalendar: false }, sourceOf("google")!, client, second.emit);
    expect(r2.messages).toBe(1);
    expect(second.out.map((e) => e.data.subject)).toEqual(["Subject m3"]);
    expect(calls.some((c) => c.url.includes("startHistoryId=100"))).toBe(true);
    const [thread] = await q<{ message_count: number }>(`SELECT message_count FROM inbox_threads WHERE external_id = 't-m1'`);
    expect(thread!.message_count).toBe(2);
  });

  it("stores metadata and the provider's preview, never a body", async () => {
    const m = await mailboxOf(A, connA);
    handlers = [gmail({ m1: gmailMessage("m1") })];
    await syncMailbox(db, { ...m, syncCalendar: false }, sourceOf("google")!, client, () => undefined);
    const cols = await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'inbox_messages'`);
    expect(cols.map((c) => c.column_name)).not.toContain("body");
    expect(calls.every((c) => !c.url.includes("format=full") && !c.url.includes("format=raw"))).toBe(true);
  });

  it("an expired history id starts over instead of failing forever", async () => {
    const m = await mailboxOf(A, connA);
    await ex(`UPDATE inbox_mailboxes SET mail_cursor = '{"historyId":"5"}' WHERE id = '${m.id}'`);
    const [stale] = await db.select().from(inboxMailboxes).where(eq(inboxMailboxes.id, m.id));
    handlers = [gmail({}, [], 404)];
    const r = await syncMailbox(db, { ...stale, syncCalendar: false }, sourceOf("google")!, client, () => undefined);
    expect(r.more).toBe(true);
    expect(await q(`SELECT mail_cursor FROM inbox_mailboxes`)).toEqual([{ mail_cursor: null }]);
  });
});

describe("Microsoft Graph sync", () => {
  it("reads the inbox and sent items deltas and keeps each delta link", async () => {
    const m = { ...(await mailboxOf(A, connA)), provider: "microsoft" };
    handlers = [
      (u) => {
        if (u.pathname.includes("/mailFolders/inbox/messages/delta")) {
          return json({
            value: [{ id: "g1", conversationId: "c1", subject: "Hi", bodyPreview: "pre", from: { emailAddress: { address: "Luis@Client.example", name: "Luis" } }, toRecipients: [{ emailAddress: { address: "me@firm.example" } }], receivedDateTime: "2026-11-10T09:00:00Z" }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=in1",
          });
        }
        if (u.pathname.includes("/mailFolders/sentitems/messages/delta")) {
          return json({ value: [{ id: "g0", "@removed": { reason: "deleted" } }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/delta?$deltatoken=s1" });
        }
        if (u.pathname.includes("/calendarView/delta")) {
          return json({
            value: [{ id: "e1", subject: "Demo", start: { dateTime: "2026-11-21T10:00:00.0000000" }, end: { dateTime: "2026-11-21T11:00:00.0000000" }, attendees: [{ emailAddress: { address: "luis@client.example" } }], isCancelled: false }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=cal1",
          });
        }
        return undefined;
      },
    ];
    const out = collect();
    const r = await syncMailbox(db, m, sourceOf("microsoft")!, client, out.emit);
    expect(r).toMatchObject({ messages: 1, events: 1, more: false });
    const [row] = await q<{ mail_cursor: Record<string, string>; calendar_cursor: Record<string, string> }>(`SELECT mail_cursor, calendar_cursor FROM inbox_mailboxes`);
    expect(row!.mail_cursor.inbox).toContain("deltatoken=in1");
    expect(row!.mail_cursor.sentitems).toContain("deltatoken=s1");
    expect(row!.calendar_cursor.link).toContain("deltatoken=cal1");
    expect(out.out.find((e) => e.name === "inbox:event.synced")!.data.startsAt).toBe("2026-11-21T10:00:00.000Z");
  });
});

describe("through Kitsuden's connections, on the queue's path", () => {
  it("runSync opens the mailbox's own connection, stores, and announces after the commit", async () => {
    const m = await mailboxOf(A, connA);
    handlers = [gmail({ m1: gmailMessage("m1") })];
    const ctx = (globalThis as { __inboxCtx?: never }).__inboxCtx!;
    const r = await runSync(ctx, m.id);
    expect(r).toMatchObject({ messages: 1 });
    expect(new Headers(calls.find((c) => c.url.includes("/profile"))!.init!.headers).get("authorization")).toBe("Bearer tok");
    expect(asked.at(-1)).toEqual({ konId: "kon-inbox", purpose: "sync me@firm.example", connectionId: connA, ownerId: A });
    expect(emitted.map((e) => e.name)).toContain("inbox:message.received");
  });

  it("a provider error leaves the mailbox in error with a reason, and nothing half-written", async () => {
    const m = await mailboxOf(A, connA);
    handlers = [(u) => (u.pathname.endsWith("/profile") ? json({ error: "boom" }, 500) : undefined)];
    const ctx = (globalThis as { __inboxCtx?: never }).__inboxCtx!;
    expect(await runSync(ctx, m.id)).toBeNull();
    expect(await q(`SELECT status, last_error FROM inbox_mailboxes`)).toEqual([{ status: "error", last_error: "gmail.googleapis.com answered 500" }]);
    expect(await q(`SELECT 1 FROM inbox_messages`)).toEqual([]);
  });
});

describe("people are kept apart", () => {
  it("a person adds only their own connection, covering what they ask for", async () => {
    const queued: Array<{ queue: string; name: string; payload: unknown }> = [];
    configureQueue({ dispatch: async (queue, name, payload) => (queued.push({ queue, name, payload }), { id: "job-1" }) });
    expect((await request("a", "POST", "/mailboxes", { connectionId: connB })).status).toBe(404);
    expect((await request("b", "POST", "/mailboxes", { connectionId: connB })).status).toBe(422);
    expect((await request({ agent: ["inbox:*"] }, "POST", "/mailboxes", { connectionId: connA })).status).toBe(403);
    const ok = await request("a", "POST", "/mailboxes", { connectionId: connA, defaultVisibility: "private" });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ address: "me@firm.example", syncMail: true });
    expect(body.data).not.toHaveProperty("mailCursor");
    expect((await request("a", "POST", "/mailboxes", { connectionId: connA })).status).toBe(409);
    // The first sync goes to the queue, one job per mailbox.
    expect(queued).toEqual([{ queue: "kon-inbox", name: "sync", payload: { mailboxId: body.data.id } }]);
    configureQueue(null);
  });

  it("each person reads their own mail; the team reads only threads marked team", async () => {
    const mine = await mailboxOf(A, connA, "private");
    handlers = [gmail({ p1: gmailMessage("p1", { subject: "Private matter" }), s1: gmailMessage("s1", { subject: "Shared deal", thread: "shared" }) })];
    await syncMailbox(db, { ...mine, syncCalendar: false }, sourceOf("google")!, client, () => undefined);
    const [shared] = await q<{ id: string }>(`SELECT id FROM inbox_threads WHERE external_id = 'shared'`);

    const subjects = async (actor: "a" | "b" | "staff") =>
      ((await (await request(actor, "GET", "/threads")).json()) as { data: Array<{ subject: string }> }).data.map((t) => t.subject).sort();
    expect(await subjects("a")).toEqual(["Private matter", "Shared deal"]);
    expect(await subjects("b")).toEqual([]);
    expect(await subjects("staff")).toEqual([]);

    // Only the owner shares it.
    expect((await request("staff", "PATCH", `/threads/${shared!.id}`, { visibility: "team" })).status).toBe(404);
    expect((await request("a", "PATCH", `/threads/${shared!.id}`, { visibility: "team" })).status).toBe(200);
    expect(await subjects("staff")).toEqual(["Shared deal"]);
    expect(await subjects("b")).toEqual([]);
    const thread = (await (await request("staff", "GET", `/threads/${shared!.id}`)).json()) as { data: { messages: unknown[] } };
    expect(thread.data.messages).toHaveLength(1);
    // A team reader still cannot see the mailbox's settings.
    expect(((await (await request("staff", "GET", "/mailboxes")).json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("someone else's mailbox is a 404 for syncing, changing, sending and removing", async () => {
    const mine = await mailboxOf(A, connA);
    expect((await request("b", "POST", `/mailboxes/${mine.id}/sync`)).status).toBe(404);
    expect((await request("b", "PATCH", `/mailboxes/${mine.id}`, { status: "paused" })).status).toBe(404);
    expect((await request("b", "POST", `/mailboxes/${mine.id}/send`, { to: ["x@y.example"], subject: "s", text: "t" })).status).toBe(404);
    expect((await request("admin", "DELETE", `/mailboxes/${mine.id}`)).status).toBe(404);
  });
});

describe("with the CRM installed", () => {
  it("a synced message lands on the contact's timeline, and leaves it when the mailbox goes", async () => {
    const m = await mailboxOf(A, connA);
    handlers = [gmail({ m1: gmailMessage("m1", { subject: "Proposal v2" }) })];
    const out = collect();
    await syncMailbox(db, { ...m, syncCalendar: false }, sourceOf("google")!, client, out.emit);
    // What kon-inbox announced, given as is to kon-crm's listener.
    for (const e of out.out.filter((x) => x.name === "inbox:message.received")) await onInboxMessage(db, e.data);
    const items = await timelineOf(db, { contactId: "c-luis" });
    expect(items).toContainEqual(expect.objectContaining({ kind: "link", type: "inbox_messages", relation: "about", summary: expect.objectContaining({ subject: "Proposal v2" }) }));

    expect((await request("a", "DELETE", `/mailboxes/${m.id}`)).status).toBe(200);
    expect(await q(`SELECT 1 FROM inbox_messages`)).toEqual([]);
    expect((await timelineOf(db, { contactId: "c-luis" })).filter((i) => i.kind === "link")).toEqual([]);
  });

  it("revoking the connection deletes its mailbox and everything synced", async () => {
    const m = await mailboxOf(A, connA);
    handlers = [gmail({ m1: gmailMessage("m1") })];
    await syncMailbox(db, m, sourceOf("google")!, client, () => undefined);
    for (const h of busHandlers.get("connections:connection.revoked") ?? []) h({ connectionId: connA });
    await new Promise((r) => setTimeout(r, 50));
    expect(await q(`SELECT 1 FROM inbox_mailboxes`)).toEqual([]);
    expect(await q(`SELECT 1 FROM inbox_events`)).toEqual([]);
  });
});

describe("sending", () => {
  it("sends through the mailbox's own account, as a plain-text message", async () => {
    const m = await mailboxOf(A, connA);
    handlers = [(u, init) => (u.pathname.endsWith("/messages/send") && init?.method === "POST" ? json({ id: "sent-1", threadId: "t9" }) : undefined)];
    const res = await request("a", "POST", `/mailboxes/${m.id}/send`, { to: ["luis@client.example"], subject: "Follow-up", text: "Hello" });
    expect(res.status).toBe(201);
    const raw = JSON.parse(String(calls.at(-1)!.init!.body)).raw as string;
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("To: luis@client.example");
    expect(mime).toContain("From: me@firm.example");
    expect((await request("a", "POST", `/mailboxes/${m.id}/send`, { to: ["not an address"], subject: "x", text: "y" })).status).toBe(422);
  });
});
