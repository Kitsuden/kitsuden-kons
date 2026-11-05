/**
 * Emails the team copies to the CRM
 * ============================================================================
 *
 * The cheapest way to get email into a CRM without reading anyone's mailbox: whoever writes to a client puts the
 * CRM's address in Bcc, or forwards the client's email to it. The email provider receives it and posts it to
 * `POST /api/crm/public/inbound/<provider>`; each contact on it gets the email as an `email` activity, linked to
 * its deal when the contact has exactly one open deal. Nothing else of anyone's mailbox is ever read.
 *
 * Three locks, all closed by default:
 *
 *   1. The provider's signature: Mailgun's HMAC over timestamp + token, Postmark's token (it signs nothing, so the
 *      URL carries a secret), or, for a relay of your own, an HMAC over timestamp and body. Older than 15 minutes
 *      is refused, so a captured post cannot be replayed later.
 *   2. The sender must be on `CRM_INBOUND_ALLOWED_SENDERS` (addresses or domains). With the list empty, every email
 *      is turned away: anyone can write to an address.
 *   3. The sender's domain must have vouched for it (SPF or DKIM passed), or a From header could be anyone's.
 *
 * It never creates contacts: an address with no contact is listed as unmatched on the receipt, for a person to
 * decide. It never reads a signature into the record either: the email is stored as it came, and an agent that
 * reads it records what it saw through `record-observation`, where the evidence is weighed.
 *
 * Configuration:
 *   CRM_INBOUND_ALLOWED_SENDERS   "acme.com, partner@gmail.com"
 *   MAILGUN_WEBHOOK_SIGNING_KEY   Mailgun's account signing key (the one kon-newsletter uses)
 *   CRM_INBOUND_POSTMARK_TOKEN    the password in the inbound webhook URL (https://crm:<token>@…)
 *   CRM_INBOUND_SECRET            for a relay of your own (`generic`)
 */

import { createHmac, randomUUID, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

import { AppError, asSystem } from "@kitsuden/engine";
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import { dbDe } from "./crm.context";
import { emitCrm } from "./crm.events";
import type { CrmDb } from "./crm.db";
import { crmActivities, crmContacts, crmDealContacts, crmDeals, crmInboundEmails } from "./crm.schema";
import { CONFIGURE, requiresEdit, type registry } from "./operations";

interface Address {
  email: string;
  name?: string;
}

export interface InboundEmail {
  messageId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  recipients: string[];
  subject: string;
  text: string;
  date: Date;
  /** Whether the sender's domain vouched for it (SPF or DKIM passed). */
  authenticated: boolean;
}

type Env = Record<string, string | undefined>;
type Verified = { mail: InboundEmail } | { error: 400 | 401 };

const WINDOW_SECONDS = 900;
const MAX_TEXT = 10_000;

function timingSafeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && nodeTimingSafeEqual(x, y);
}

function fresh(timestamp: string | null | undefined): boolean {
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  return Number.isFinite(age) && age <= WINDOW_SECONDS;
}

/** `Ana Ortega <ana@acme.com>, "Paz, Bruno" <bruno@x.com>, c@y.com` → addresses, lowercased. */
export function parseAddresses(value: string | null | undefined): Address[] {
  if (!value) return [];
  const out: Address[] = [];
  // A quoted name may hold commas ("Paz, Bruno"); an unquoted one may not.
  const re = /(?:(?:"([^"]*)"|([^"<,]*?))\s*<([^<>\s]+@[^<>\s]+)>)|([^\s<>,;"]+@[^\s<>,;"]+)/g;
  for (const m of value.matchAll(re)) {
    const email = (m[3] ?? m[4] ?? "").toLowerCase();
    const name = (m[1] ?? m[2] ?? "").trim();
    if (email) out.push({ email, ...(name ? { name } : {}) });
  }
  return out;
}

function dateOr(value: unknown): Date {
  const d = new Date(String(value ?? ""));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

async function mailgun(body: ArrayBuffer, headers: Headers, env: Env): Promise<Verified | null> {
  const key = env.MAILGUN_WEBHOOK_SIGNING_KEY;
  if (!key) return null;
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": headers.get("content-type") ?? "" } }).formData();
  } catch {
    return { error: 400 };
  }
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };
  const expected = createHmac("sha256", key).update(field("timestamp") + field("token")).digest("hex");
  if (!field("signature") || !timingSafeEqual(expected, field("signature")) || !fresh(field("timestamp"))) return { error: 401 };
  const from = parseAddresses(field("from"))[0];
  if (!from) return { error: 400 };
  return {
    mail: {
      messageId: field("Message-Id") || `mailgun:${field("token")}`,
      from,
      to: parseAddresses(field("To")),
      cc: parseAddresses(field("Cc")),
      recipients: parseAddresses(field("recipient")).map((a) => a.email),
      subject: field("subject"),
      text: field("stripped-text") || field("body-plain"),
      date: dateOr(field("Date")),
      authenticated: field("X-Mailgun-Spf").toLowerCase() === "pass" || field("X-Mailgun-Dkim-Check-Result").toLowerCase() === "pass",
    },
  };
}

interface PostmarkAddress {
  Email?: string;
  Name?: string;
}
interface PostmarkInbound {
  FromFull?: PostmarkAddress;
  ToFull?: PostmarkAddress[];
  CcFull?: PostmarkAddress[];
  OriginalRecipient?: string;
  Subject?: string;
  TextBody?: string;
  StrippedTextReply?: string;
  Date?: string;
  MessageID?: string;
  Headers?: { Name?: string; Value?: string }[];
}

async function postmark(body: ArrayBuffer, headers: Headers, env: Env): Promise<Verified | null> {
  const token = env.CRM_INBOUND_POSTMARK_TOKEN;
  if (!token) return null;
  // Postmark signs nothing: the webhook URL carries a secret as its basic-auth password.
  const auth = headers.get("authorization") ?? "";
  const basic = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8") : "";
  const provided = basic.includes(":") ? basic.slice(basic.indexOf(":") + 1) : (headers.get("x-kitsuden-token") ?? "");
  if (!provided || !timingSafeEqual(provided, token)) return { error: 401 };
  let p: PostmarkInbound;
  try {
    p = JSON.parse(new TextDecoder().decode(body)) as PostmarkInbound;
  } catch {
    return { error: 400 };
  }
  const header = (name: string) => p.Headers?.find((h) => h.Name?.toLowerCase() === name.toLowerCase())?.Value ?? "";
  const addr = (a?: PostmarkAddress): Address | null => (a?.Email ? { email: a.Email.toLowerCase(), ...(a.Name ? { name: a.Name } : {}) } : null);
  const from = addr(p.FromFull);
  if (!from) return { error: 400 };
  return {
    mail: {
      messageId: header("Message-ID") || `postmark:${p.MessageID ?? randomUUID()}`,
      from,
      to: (p.ToFull ?? []).map(addr).filter((a): a is Address => !!a),
      cc: (p.CcFull ?? []).map(addr).filter((a): a is Address => !!a),
      recipients: p.OriginalRecipient ? [p.OriginalRecipient.toLowerCase()] : [],
      subject: p.Subject ?? "",
      text: p.StrippedTextReply || p.TextBody || "",
      date: dateOr(p.Date),
      authenticated: /^pass\b/i.test(header("Received-SPF").trim()) || /\bdkim=pass\b/i.test(header("Authentication-Results")),
    },
  };
}

const GenericBody = z.object({
  messageId: z.string().min(1).max(500),
  from: z.object({ email: z.string().email(), name: z.string().max(200).optional() }),
  to: z.array(z.object({ email: z.string().email(), name: z.string().max(200).optional() })).max(200).default([]),
  cc: z.array(z.object({ email: z.string().email(), name: z.string().max(200).optional() })).max(200).default([]),
  recipients: z.array(z.string().email()).max(50).default([]),
  subject: z.string().max(2000).default(""),
  text: z.string().max(200_000).default(""),
  date: z.string().optional(),
  authenticated: z.boolean().describe("Whether your relay saw SPF or DKIM pass. Only `true` is accepted"),
});

/** A relay of your own (an email worker, a script): HMAC-SHA256 over `<timestamp>.<body>` with CRM_INBOUND_SECRET. */
async function generic(body: ArrayBuffer, headers: Headers, env: Env): Promise<Verified | null> {
  const secret = env.CRM_INBOUND_SECRET;
  if (!secret) return null;
  const raw = new TextDecoder().decode(body);
  const timestamp = headers.get("x-kitsuden-timestamp") ?? "";
  const signature = (headers.get("x-kitsuden-signature") ?? "").replace(/^sha256=/, "");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  if (!signature || !timingSafeEqual(expected, signature) || !fresh(timestamp)) return { error: 401 };
  let parsed: z.infer<typeof GenericBody>;
  try {
    parsed = GenericBody.parse(JSON.parse(raw));
  } catch {
    return { error: 400 };
  }
  const lower = (a: Address) => ({ ...a, email: a.email.toLowerCase() });
  return {
    mail: {
      messageId: parsed.messageId,
      from: lower(parsed.from),
      to: parsed.to.map(lower),
      cc: parsed.cc.map(lower),
      recipients: parsed.recipients.map((r) => r.toLowerCase()),
      subject: parsed.subject,
      text: parsed.text,
      date: dateOr(parsed.date),
      authenticated: parsed.authenticated,
    },
  };
}

const PROVIDERS: Record<string, (body: ArrayBuffer, headers: Headers, env: Env) => Promise<Verified | null>> = {
  mailgun,
  postmark,
  generic,
};

/** The team's senders: `acme.com` admits any address at acme.com, `a@b.com` only that address. */
function allowedSenders(env: Env): string[] {
  return (env.CRM_INBOUND_ALLOWED_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function onTeam(email: string, allowed: string[]): boolean {
  return allowed.some((rule) => (rule.includes("@") ? email === rule : email.endsWith(`@${rule}`)));
}

const FORWARD_MARK = /^(?:-{3,}\s*(?:forwarded message|mensaje reenviado|original message|mensaje original)\s*-{3,}|begin forwarded message:|_{10,})\s*$/im;
const FROM_LINE = /^(?:from|de)\s*:\s*(.+)$/im;

/**
 * The original email inside a forwarded one, as Gmail, Outlook and Apple Mail write it (in English or Spanish):
 * its sender and its text. `null` when it is not a forward.
 */
export function forwardedOriginal(subject: string, text: string): { from: Address; text: string } | null {
  if (!/^\s*(?:fwd?|rv|reenv(?:iar)?)\s*:/i.test(subject) && !FORWARD_MARK.test(text)) return null;
  const mark = text.search(FORWARD_MARK);
  const rest = mark >= 0 ? text.slice(mark) : text;
  const line = rest.match(FROM_LINE);
  const from = line ? parseAddresses(line[1])[0] : undefined;
  if (!from) return null;
  // The original text starts after the header block (From/Sent/To/Subject…), at the first blank line.
  const afterFrom = rest.slice((line!.index ?? 0) + line![0].length);
  const blank = afterFrom.search(/\r?\n\s*\r?\n/);
  return { from, text: (blank >= 0 ? afterFrom.slice(blank) : afterFrom).trim() };
}

export interface IngestResult {
  outcome: "recorded" | "rejected" | "duplicate";
  reason?: string;
  activityIds?: string[];
  unmatched?: string[];
}

/** Records one verified email. Runs as the system: the caller is a provider, not a person. */
export async function ingestEmail(db: CrmDb, provider: string, mail: InboundEmail, env: Env): Promise<IngestResult> {
  const [seen] = await db
    .select({ id: crmInboundEmails.id })
    .from(crmInboundEmails)
    .where(and(eq(crmInboundEmails.provider, provider), eq(crmInboundEmails.messageId, mail.messageId)));
  if (seen) return { outcome: "duplicate" };

  const receipt = (status: "recorded" | "rejected", extra: { reason?: string; activityIds?: string[]; unmatched?: string[] }) =>
    db.insert(crmInboundEmails).values({
      id: createId(),
      provider,
      messageId: mail.messageId,
      sender: mail.from.email,
      subject: mail.subject.slice(0, 500),
      status,
      reason: extra.reason ?? null,
      activityIds: extra.activityIds ?? [],
      unmatched: extra.unmatched ?? [],
    });
  const reject = async (reason: string, unmatched: string[] = []): Promise<IngestResult> => {
    await receipt("rejected", { reason, unmatched });
    return { outcome: "rejected", reason, unmatched };
  };

  const allowed = allowedSenders(env);
  if (allowed.length === 0) return reject("No sender is allowed yet: set CRM_INBOUND_ALLOWED_SENDERS");
  if (!onTeam(mail.from.email, allowed)) return reject(`${mail.from.email} is not on the allowed senders`);
  if (!mail.authenticated) return reject("The sender's domain did not vouch for it (SPF and DKIM did not pass)");

  // Email bodies travel with CRLF; stored text uses plain newlines.
  const body = mail.text.replace(/\r\n?/g, "\n");
  const original = forwardedOriginal(mail.subject, body);
  const crmAddresses = new Set(mail.recipients);
  const outside = (a: Address) => !onTeam(a.email, allowed) && !crmAddresses.has(a.email);
  const participants = [...new Map((original ? [original.from] : [...mail.to, ...mail.cc]).filter(outside).map((a) => [a.email, a])).values()];
  if (participants.length === 0) return reject("Nobody outside the team is on it");

  const contacts = await db
    .select({ id: crmContacts.id, email: crmContacts.email, companyId: crmContacts.companyId })
    .from(crmContacts)
    .where(inArray(sql`lower(${crmContacts.email})`, participants.map((p) => p.email)));
  const byEmail = new Map(contacts.map((c) => [(c.email ?? "").toLowerCase(), c]));
  const unmatched = participants.filter((p) => !byEmail.has(p.email)).map((p) => p.email);
  if (contacts.length === 0) return reject("No contact in the CRM has these addresses", unmatched);

  const direction = original ? "received" : "sent";
  const text = (original?.text ?? body).slice(0, MAX_TEXT);
  const activityIds: string[] = [];
  for (const contact of contacts) {
    const linked = await db.select({ id: crmDealContacts.dealId }).from(crmDealContacts).where(eq(crmDealContacts.contactId, contact.id));
    const open = await db
      .select({ id: crmDeals.id })
      .from(crmDeals)
      .where(
        and(
          eq(crmDeals.status, "open"),
          or(eq(crmDeals.contactId, contact.id), linked.length ? inArray(crmDeals.id, linked.map((l) => l.id)) : undefined)
        )
      )
      .limit(2);
    const [row] = await db
      .insert(crmActivities)
      .values({
        type: "email",
        subject: (mail.subject || "(no subject)").slice(0, 500),
        description: text,
        contactId: contact.id,
        companyId: contact.companyId,
        // One open deal is the deal; with several it is a person's call (`update-activity`).
        dealId: open.length === 1 ? open[0]!.id : null,
        completedAt: mail.date,
        origin: "email",
        metadata: {
          messageId: mail.messageId,
          provider,
          direction,
          from: original?.from.email ?? mail.from.email,
          to: mail.to.map((a) => a.email),
          cc: mail.cc.map((a) => a.email),
          loggedBy: mail.from.email,
        },
      })
      .returning({ id: crmActivities.id });
    activityIds.push(row!.id);
  }
  await receipt("recorded", { activityIds, unmatched });
  emitCrm("email:received", { activityIds, contactIds: contacts.map((c) => c.id), direction });
  return { outcome: "recorded", activityIds, unmatched };
}

export function inboundOperations(routes: ReturnType<typeof registry>, root: () => CrmDb): void {
  routes.post(
    "/public/inbound/:provider",
    {
      id: "receive-inbound-email",
      summary: "Receive an email copied to the CRM",
      description:
        "Called by the email provider (`mailgun`, `postmark`, or `generic` for a relay of your own) when someone on the team Bccs or forwards an email to the CRM's address. Authenticated by the provider's signature, 15 minutes at most. 404 for a provider not configured, 401 for a bad or old signature, 400 for a payload it cannot read. Anything verified answers 200 with `outcome` (`recorded`, `rejected` with its `reason`, or `duplicate`), so the provider does not retry what was turned away on purpose.",
      access: "public",
      mcp: { exclude: "Called by the email provider, authenticated by its signature over the request." },
      input: { params: z.object({ provider: z.string().max(20) }) },
      output: { schema: z.object({ ok: z.literal(true), outcome: z.string() }).passthrough() },
    },
    async (c, input) => {
      const env = process.env as Env;
      const adapter = Object.prototype.hasOwnProperty.call(PROVIDERS, input.params.provider) ? PROVIDERS[input.params.provider] : undefined;
      const verified = adapter ? await adapter(await c.req.arrayBuffer(), c.req.raw.headers, env) : null;
      if (!verified) throw AppError.notFound("Unknown or unconfigured provider");
      if ("error" in verified) {
        if (verified.error === 401) throw AppError.unauthenticated("Bad or expired signature");
        throw AppError.badRequest("The email could not be read");
      }
      const db = root();
      const result = await asSystem(() => ingestEmail(db, input.params.provider, verified.mail, env));
      return c.json({ ok: true as const, ...result });
    }
  );

  routes.get(
    "/inbound-emails",
    {
      id: "list-inbound-emails",
      summary: "List the emails copied to the CRM",
      description:
        "Newest first: who sent each, whether it was `recorded` (with its activities and the addresses that matched no contact) or `rejected` and why. Also `setup`: which providers are configured and how many senders are allowed, never the secrets. Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { query: z.object({ status: z.enum(["recorded", "rejected"]).optional(), limit: z.string().optional() }) },
      output: { schema: z.object({}).passthrough() },
    },
    async (c, input) => {
      const env = process.env as Env;
      const limit = Math.min(Math.max(Number(input.query.limit) || 100, 1), 500);
      const data = await dbDe(c)
        .select()
        .from(crmInboundEmails)
        .where(input.query.status ? eq(crmInboundEmails.status, input.query.status) : undefined)
        .orderBy(desc(crmInboundEmails.receivedAt))
        .limit(limit);
      const providers = [
        ...(env.MAILGUN_WEBHOOK_SIGNING_KEY ? ["mailgun"] : []),
        ...(env.CRM_INBOUND_POSTMARK_TOKEN ? ["postmark"] : []),
        ...(env.CRM_INBOUND_SECRET ? ["generic"] : []),
      ];
      return c.json({ data, setup: { providers, allowedSenders: allowedSenders(env).length, path: "/api/crm/public/inbound/<provider>" } });
    }
  );
}
