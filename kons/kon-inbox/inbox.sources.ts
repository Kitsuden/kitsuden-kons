/**
 * Talking to Gmail, Google Calendar and Microsoft Graph
 * ============================================================================
 *
 * Each provider is a `MailSource`: read the mail and the calendar since a cursor, and send. The requests
 * go through kon-connections' client (it adds the credential and only reaches the provider's hosts); this
 * file only knows URLs and shapes.
 *
 * ── INCREMENTAL, IN BOUNDED STEPS ──────────────────────────────────────────
 *
 *   Gmail     first run: message ids `after:<backfill>`, page by page; then `history` from the
 *             `historyId` taken before the first page, so nothing that arrives during the backfill is lost.
 *             An expired history id (404) starts over.
 *   Graph     `messages/delta` on the inbox and on sent items, with a receivedDateTime filter on the
 *             first run; the `deltaLink` is the cursor. Calendar: `calendarView/delta`.
 *   Calendar  Google: `events` with `syncToken`; an expired token (410) starts over.
 *
 * One call returns at most `MAX_PAGES` pages. When there is more, the cursor points at the next page and
 * `more` is true: the sync job runs again instead of holding the queue for a whole mailbox.
 *
 * What is read is metadata: From, To, Cc, Subject, Date, and the provider's own short preview. Never a body.
 */

export interface Fetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface SyncedMessage {
  externalId: string;
  threadExternalId: string;
  direction: "in" | "out";
  fromAddress: string | null;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string;
  snippet: string;
  sentAt: Date;
}

export interface SyncedEvent {
  externalId: string;
  title: string;
  location: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  attendees: string[];
  organizer: string | null;
  cancelled: boolean;
}

export interface Batch<T> {
  items: T[];
  cursor: Record<string, unknown>;
  more: boolean;
  /** The cursor was refused (expired): the stored one must be dropped and the next run starts over. */
  reset?: boolean;
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  threadExternalId?: string | null;
}

export interface MailSource {
  mail(client: Fetcher, cursor: Record<string, unknown> | null, since: Date): Promise<Batch<SyncedMessage>>;
  calendar(client: Fetcher, cursor: Record<string, unknown> | null, since: Date): Promise<Batch<SyncedEvent>>;
  send(client: Fetcher, mail: OutgoingMail): Promise<{ externalId: string | null; threadExternalId: string | null }>;
}

export const MAX_PAGES = 5;
const MAX_MESSAGES = 100;

export class SourceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "SourceError";
  }
}

async function getJson(client: Fetcher, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await client.fetch(url, init);
  if (!res.ok) throw new SourceError(`${new URL(url).hostname} answered ${res.status}`, res.status);
  return (await res.json()) as Record<string, unknown>;
}

// ── Addresses ───────────────────────────────────────────────────────────────

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** `"Ana Ortega" <ana@x.com>, bruno@y.com` → [{ name, address }]. Quoted commas do not split. */
export function parseAddressList(header: string | null | undefined): Array<{ name: string | null; address: string }> {
  if (!header) return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    if (ch === "<") angle = true;
    if (ch === ">") angle = false;
    if (ch === "," && !quoted && !angle) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  const out: Array<{ name: string | null; address: string }> = [];
  for (const part of parts) {
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(part);
    const address = (m ? m[2]! : part).trim().toLowerCase();
    if (!ADDRESS.test(address)) continue;
    const name = m?.[1]?.trim() || null;
    out.push({ name, address });
  }
  return out;
}

// ── Gmail ───────────────────────────────────────────────────────────────────

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const HEADERS = ["From", "To", "Cc", "Subject", "Date"];

function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string | null {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

async function gmailMessage(client: Fetcher, id: string): Promise<SyncedMessage | null> {
  const query = HEADERS.map((h) => `metadataHeaders=${h}`).join("&");
  let m: Record<string, unknown>;
  try {
    m = await getJson(client, `${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&${query}`);
  } catch (err) {
    // Deleted between the list and the read.
    if (err instanceof SourceError && err.status === 404) return null;
    throw err;
  }
  const labels = (m.labelIds as string[] | undefined) ?? [];
  if (labels.includes("DRAFT") || labels.includes("SPAM") || labels.includes("CHAT")) return null;
  const headers = (m.payload as { headers?: Array<{ name?: string; value?: string }> } | undefined)?.headers;
  const [from] = parseAddressList(header(headers, "From"));
  const internal = Number(m.internalDate);
  return {
    externalId: String(m.id),
    threadExternalId: String(m.threadId ?? m.id),
    direction: labels.includes("SENT") ? "out" : "in",
    fromAddress: from?.address ?? null,
    fromName: from?.name ?? null,
    to: parseAddressList(header(headers, "To")).map((a) => a.address),
    cc: parseAddressList(header(headers, "Cc")).map((a) => a.address),
    subject: (header(headers, "Subject") ?? "").slice(0, 500),
    snippet: String(m.snippet ?? "").slice(0, 300),
    sentAt: Number.isFinite(internal) && internal > 0 ? new Date(internal) : new Date(header(headers, "Date") ?? Date.now()),
  };
}

async function gmailMessages(client: Fetcher, ids: string[]): Promise<SyncedMessage[]> {
  const out: SyncedMessage[] = [];
  for (const id of [...new Set(ids)].slice(0, MAX_MESSAGES)) {
    const m = await gmailMessage(client, id);
    if (m) out.push(m);
  }
  return out;
}

const google: MailSource = {
  async mail(client, cursor, since) {
    // Backfill: ids after `since`, page by page, with the history id taken BEFORE it started.
    if (!cursor || cursor.phase === "backfill") {
      const historyId = (cursor?.historyId as string | undefined) ?? String((await getJson(client, `${GMAIL}/profile`)).historyId ?? "");
      const ids: string[] = [];
      let pageToken = cursor?.pageToken as string | undefined;
      for (let page = 0; page < MAX_PAGES && ids.length < MAX_MESSAGES; page++) {
        const q = encodeURIComponent(`after:${Math.floor(since.getTime() / 1000)}`);
        const list = await getJson(client, `${GMAIL}/messages?q=${q}&maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
        for (const m of (list.messages as Array<{ id: string }> | undefined) ?? []) ids.push(m.id);
        pageToken = list.nextPageToken as string | undefined;
        if (!pageToken) break;
      }
      const items = await gmailMessages(client, ids);
      return pageToken
        ? { items, cursor: { phase: "backfill", historyId, pageToken }, more: true }
        : { items, cursor: { historyId }, more: false };
    }
    // Incremental: what was added since the history id.
    const ids: string[] = [];
    let pageToken = cursor.pageToken as string | undefined;
    let newest = String(cursor.historyId);
    try {
      for (let page = 0; page < MAX_PAGES && ids.length < MAX_MESSAGES; page++) {
        const url = `${GMAIL}/history?startHistoryId=${encodeURIComponent(String(cursor.historyId))}&historyTypes=messageAdded${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        const h = await getJson(client, url);
        for (const entry of (h.history as Array<{ messagesAdded?: Array<{ message: { id: string } }> }> | undefined) ?? []) {
          for (const added of entry.messagesAdded ?? []) ids.push(added.message.id);
        }
        if (h.historyId) newest = String(h.historyId);
        pageToken = h.nextPageToken as string | undefined;
        if (!pageToken) break;
      }
    } catch (err) {
      if (err instanceof SourceError && err.status === 404) return { items: [], cursor: {}, more: true, reset: true };
      throw err;
    }
    const items = await gmailMessages(client, ids);
    return pageToken
      ? { items, cursor: { historyId: cursor.historyId, pageToken }, more: true }
      : { items, cursor: { historyId: newest }, more: false };
  },

  async calendar(client, cursor, since) {
    const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&maxResults=250";
    const items: SyncedEvent[] = [];
    let pageToken = cursor?.pageToken as string | undefined;
    const syncToken = cursor?.syncToken as string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const window = syncToken ? `&syncToken=${encodeURIComponent(syncToken)}` : `&timeMin=${encodeURIComponent(since.toISOString())}`;
        const list = await getJson(client, `${base}${window}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
        for (const e of (list.items as Array<Record<string, unknown>> | undefined) ?? []) items.push(googleEvent(e));
        pageToken = list.nextPageToken as string | undefined;
        if (!pageToken) {
          return { items, cursor: { syncToken: String(list.nextSyncToken ?? syncToken ?? "") }, more: false };
        }
      }
    } catch (err) {
      if (err instanceof SourceError && err.status === 410) return { items: [], cursor: {}, more: true, reset: true };
      throw err;
    }
    return { items, cursor: { syncToken, pageToken }, more: true };
  },

  async send(client, mail) {
    const body: Record<string, unknown> = { raw: Buffer.from(buildMime(mail)).toString("base64url") };
    if (mail.threadExternalId) body.threadId = mail.threadExternalId;
    const sent = await getJson(client, `${GMAIL}/messages/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { externalId: String(sent.id ?? "") || null, threadExternalId: String(sent.threadId ?? "") || null };
  },
};

function googleTime(t: unknown): Date | null {
  const v = t as { dateTime?: string; date?: string } | undefined;
  const raw = v?.dateTime ?? v?.date;
  return raw ? new Date(raw) : null;
}

function googleEvent(e: Record<string, unknown>): SyncedEvent {
  return {
    externalId: String(e.id),
    title: String(e.summary ?? "").slice(0, 500),
    location: e.location ? String(e.location).slice(0, 500) : null,
    startsAt: googleTime(e.start),
    endsAt: googleTime(e.end),
    attendees: ((e.attendees as Array<{ email?: string }> | undefined) ?? [])
      .map((a) => (a.email ?? "").toLowerCase())
      .filter((a) => ADDRESS.test(a)),
    organizer: ((e.organizer as { email?: string } | undefined)?.email ?? "").toLowerCase() || null,
    cancelled: e.status === "cancelled",
  };
}

// ── Microsoft Graph ─────────────────────────────────────────────────────────

const GRAPH = "https://graph.microsoft.com/v1.0/me";
const SELECT = "$select=subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,conversationId";

function graphAddress(r: unknown): { name: string | null; address: string } | null {
  const e = (r as { emailAddress?: { address?: string; name?: string } } | undefined)?.emailAddress;
  const address = (e?.address ?? "").toLowerCase();
  return ADDRESS.test(address) ? { name: e?.name || null, address } : null;
}

function graphMessage(m: Record<string, unknown>, direction: "in" | "out"): SyncedMessage {
  const from = graphAddress(m.from);
  const list = (v: unknown) => ((v as unknown[] | undefined) ?? []).map(graphAddress).filter((a): a is NonNullable<typeof a> => !!a).map((a) => a.address);
  return {
    externalId: String(m.id),
    threadExternalId: String(m.conversationId ?? m.id),
    direction,
    fromAddress: from?.address ?? null,
    fromName: from?.name ?? null,
    to: list(m.toRecipients),
    cc: list(m.ccRecipients),
    subject: String(m.subject ?? "").slice(0, 500),
    snippet: String(m.bodyPreview ?? "").slice(0, 300),
    sentAt: new Date(String(m.sentDateTime ?? m.receivedDateTime ?? Date.now())),
  };
}

/** Follows a delta query up to MAX_PAGES pages. Returns the link to continue or the delta link. */
async function graphDelta(
  client: Fetcher,
  start: string,
  init?: RequestInit
): Promise<{ items: Array<Record<string, unknown>>; next: string | null; delta: string | null }> {
  const items: Array<Record<string, unknown>> = [];
  let url = start;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await getJson(client, url, init);
    items.push(...((body.value as Array<Record<string, unknown>> | undefined) ?? []));
    const next = body["@odata.nextLink"] as string | undefined;
    const delta = body["@odata.deltaLink"] as string | undefined;
    if (delta) return { items, next: null, delta };
    if (!next) return { items, next: null, delta: null };
    url = next;
  }
  return { items, next: url, delta: null };
}

const microsoft: MailSource = {
  async mail(client, cursor, since) {
    const folders = [
      ["inbox", "in"],
      ["sentitems", "out"],
    ] as const;
    const items: SyncedMessage[] = [];
    const nextCursor: Record<string, unknown> = { ...(cursor ?? {}) };
    let more = false;
    for (const [folder, direction] of folders) {
      const start =
        (cursor?.[folder] as string | undefined) ??
        `${GRAPH}/mailFolders/${folder}/messages/delta?${SELECT}&$filter=receivedDateTime+ge+${since.toISOString()}`;
      let page;
      try {
        page = await graphDelta(client, start);
      } catch (err) {
        // A delta token Graph no longer knows (410, or 400 "syncStateNotFound"): start over.
        if (err instanceof SourceError && (err.status === 410 || (err.status === 400 && cursor?.[folder]))) {
          return { items: [], cursor: {}, more: true, reset: true };
        }
        throw err;
      }
      for (const m of page.items) if (!m["@removed"]) items.push(graphMessage(m, direction));
      nextCursor[folder] = page.delta ?? page.next ?? start;
      if (page.next) more = true;
    }
    return { items, cursor: nextCursor, more };
  },

  async calendar(client, cursor, since) {
    const until = new Date(since.getTime() + 400 * 86_400_000);
    const start =
      (cursor?.link as string | undefined) ??
      `${GRAPH}/calendarView/delta?startDateTime=${since.toISOString()}&endDateTime=${until.toISOString()}`;
    let page;
    try {
      page = await graphDelta(client, start, { headers: { prefer: 'outlook.timezone="UTC"' } });
    } catch (err) {
      if (err instanceof SourceError && (err.status === 410 || (err.status === 400 && cursor?.link))) {
        return { items: [], cursor: {}, more: true, reset: true };
      }
      throw err;
    }
    const items = page.items.map((e): SyncedEvent => {
      const time = (t: unknown) => {
        const v = t as { dateTime?: string } | undefined;
        return v?.dateTime ? new Date(v.dateTime.endsWith("Z") ? v.dateTime : `${v.dateTime}Z`) : null;
      };
      return {
        externalId: String(e.id),
        title: String(e.subject ?? "").slice(0, 500),
        location: ((e.location as { displayName?: string } | undefined)?.displayName ?? "").slice(0, 500) || null,
        startsAt: time(e.start),
        endsAt: time(e.end),
        attendees: ((e.attendees as unknown[] | undefined) ?? []).map(graphAddress).filter((a): a is NonNullable<typeof a> => !!a).map((a) => a.address),
        organizer: graphAddress(e.organizer)?.address ?? null,
        cancelled: Boolean(e["@removed"]) || e.isCancelled === true,
      };
    });
    return { items, cursor: { link: page.delta ?? page.next ?? start }, more: page.next !== null };
  },

  async send(client, mail) {
    const res = await client.fetch(`${GRAPH}/sendMail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: "Text", content: mail.text },
          toRecipients: mail.to.map((address) => ({ emailAddress: { address } })),
          ccRecipients: mail.cc.map((address) => ({ emailAddress: { address } })),
        },
        saveToSentItems: true,
      }),
    });
    if (!res.ok) throw new SourceError(`graph.microsoft.com answered ${res.status}`, res.status);
    // Graph accepts it (202) without an id: the sent copy arrives with the next sync of Sent Items.
    return { externalId: null, threadExternalId: null };
  },
};

// ── Sending: an RFC 5322 message with no room for header injection ─────────

function encodeHeader(value: string): string {
  // A header value never carries a line break: that is how a header is injected.
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export function buildMime(mail: OutgoingMail): string {
  const lines = [
    `From: ${encodeHeader(mail.from)}`,
    `To: ${mail.to.map(encodeHeader).join(", ")}`,
    ...(mail.cc.length ? [`Cc: ${mail.cc.map(encodeHeader).join(", ")}`] : []),
    `Subject: ${encodeHeader(mail.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(mail.text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  return lines.join("\r\n");
}

export function isAddress(value: string): boolean {
  return ADDRESS.test(value.trim().toLowerCase());
}

const SOURCES: Record<string, MailSource> = { google, microsoft };

export function sourceOf(provider: string): MailSource | null {
  return SOURCES[provider] ?? null;
}
