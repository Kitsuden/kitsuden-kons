/**
 * Campaigns: one approved WhatsApp template to many contacts who agreed to receive it
 * ============================================================================
 *
 *   draft ──recipients──▶ draft ──approve──▶ draft (approved) ──schedule──▶ scheduled ──time──▶ running ──▶ done
 *                                                                              │  ▲                 │  ▲
 *                                                                              ▼  │                 ▼  │
 *                                                                             paused ◀──────────── paused      (cancel from any)
 *
 * Who gets it: a segment (contact ids, conversation labels, contact attributes) or an imported list. A
 * campaign only reaches contacts with an explicit `opted_in` consent on the channel: an import records
 * that consent only when each row says where it came from (`optIn.source`), never for the whole file,
 * and never over an opt-out the contact asked for. Opted-out, blocked and unconsented recipients are
 * kept, and skipped with the reason, so the numbers add up.
 *
 * Approval is a separate, sensitive step (an agent asking gets a proposal for a human). Anything that
 * changes the recipients after it clears it.
 *
 * The runner (queue `koe-automation`, job `campaign`) sends at most `ratePerMinute` per rolling minute,
 * counted from the rows themselves, so two replicas or a retried job never double the pace. Each batch
 * claims its rows with a conditional UPDATE; the idempotency key `campaign:<id>:<contact>` makes a second
 * attempt at the same recipient return the first message. Quiet hours are read in the contact's time
 * zone (attribute `timezone`), else the campaign's. A recipient in quiet hours stays pending.
 *
 * Where the message lands: the contact's open conversation on the channel; else their last one; else a
 * new conversation created RESOLVED. A campaign is not a conversation anybody must answer: if the contact
 * replies, the inbound path reopens that thread as it would any other, with the campaign message in it.
 *
 * Cost: koe never states prices as facts. An admin keeps a price table in `koe_config` "pricing" (per
 * template category and country calling code); without it the estimate says "unknown".
 */

import { AppError, asSystem, queue, withSavepoint } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import { dbOf, emit, newId, QUEUES, type Db } from "./koe.common";
import { recordEvent } from "./koe.conversations";
import { contactTimeZone, inQuietHours, isHhMm, validTimeZone } from "./koe.hours";
import { CONFIGURE, requireLead, USE } from "./koe.policy";
import {
  koeCampaignRecipients,
  koeCampaigns,
  koeChannels,
  koeConfig,
  koeConsents,
  koeContacts,
  koeConversations,
  koeIdentities,
  koeMessages,
  koeTemplates,
  type Channel,
  type Contact,
  type Conversation,
  type Template,
} from "./koe.schema";
import { send } from "./koe.send";
import { Output, ParamId, type OperationsModule } from "./operations";

export type Campaign = typeof koeCampaigns.$inferSelect;

/** Rows of a raw `db.execute`, whatever the driver returns. */
export const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: unknown[] } | null)?.rows ?? [])) as T[];

/** koe's refusal code inside an AppError from send() (`OPTED_OUT`, `WINDOW_CLOSED`…), if any. */
export function koeCode(err: unknown): string | null {
  const d = (err as { details?: { koe?: unknown } } | null)?.details;
  return typeof d?.koe === "string" ? d.koe : null;
}

const MAX_RECIPIENTS = 50_000;
/** A claimed row not finished after this long is free again (the worker died). */
const CLAIM_MS = 10 * 60_000;

// ── Prices ─────────────────────────────────────────────────────────────────

const CATEGORIES = ["marketing", "utility", "authentication", "service"] as const;

/** `{ currency, categories: { marketing: { "51": 0.07, "*": 0.05 } } }`: price per message, by calling code. */
export interface PricingTable {
  currency: string;
  categories: Partial<Record<(typeof CATEGORIES)[number], Record<string, number>>>;
  note?: string;
}

const PricingBody = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).describe("ISO 4217, e.g. USD"),
  categories: z
    // A record keyed by an enum demands every key in zod 4: categories are checked by hand instead.
    .record(z.string(), z.record(z.string().regex(/^(\*|\d{1,4})$/), z.number().min(0).max(100)))
    .refine((c) => Object.keys(c).every((k) => (CATEGORIES as readonly string[]).includes(k)), `categories are ${CATEGORIES.join(", ")}`)
    .describe('Per template category, price per message by country calling code ("51", "1", "52"…), "*" for the rest'),
  note: z.string().max(500).optional().describe("Where the prices come from and when they were checked"),
});

export async function pricingOf(db: Db): Promise<PricingTable | null> {
  const [row] = (await asSystem(() => db.select({ value: koeConfig.value }).from(koeConfig).where(eq(koeConfig.key, "pricing")).limit(1))) as Array<{ value: unknown }>;
  const parsed = PricingBody.safeParse(row?.value);
  return parsed.success ? (parsed.data as PricingTable) : null;
}

/** The price of one message of `category` to `phone` (digits, with country code), or null when unknown. */
export function priceFor(table: PricingTable | null, category: string | null | undefined, phone: string | null | undefined): number | null {
  const rates = table?.categories[(category ?? "") as keyof PricingTable["categories"]];
  if (!rates) return null;
  const digits = (phone ?? "").replace(/[^\d]/g, "");
  for (let len = 4; len >= 1; len--) {
    const p = digits.slice(0, len);
    if (p.length === len && rates[p] !== undefined) return rates[p]!;
  }
  return rates["*"] ?? null;
}

// ── Where a campaign message lands ─────────────────────────────────────────

/**
 * The contact's conversation on the channel for a business-initiated message, WITHOUT giving it to anybody:
 * the open one, else the last one, else a new one created resolved. `skip` says why there is none.
 */
export async function conversationForOutbound(_ctx: KonContext, db: Db, contact: Contact, channel: Channel, origin: Record<string, unknown>): Promise<{ conversation: Conversation } | { skip: string }> {
  let [identity] = (await db.select().from(koeIdentities).where(and(eq(koeIdentities.contactId, contact.id), eq(koeIdentities.channelId, channel.id))).limit(1)) as Array<typeof koeIdentities.$inferSelect>;
  if (!identity) {
    if (channel.kind !== "whatsapp") return { skip: "not_on_channel" };
    const phone = contact.phone?.replace(/[^\d]/g, "");
    if (!phone) return { skip: "no_phone" };
    await db.insert(koeIdentities).values({ id: newId(), contactId: contact.id, channelId: channel.id, externalId: phone }).onConflictDoNothing();
    [identity] = (await db.select().from(koeIdentities).where(and(eq(koeIdentities.channelId, channel.id), eq(koeIdentities.externalId, phone))).limit(1)) as Array<typeof koeIdentities.$inferSelect>;
    if (!identity || identity.contactId !== contact.id) return { skip: "phone_of_another_contact" };
  }
  const [open] = (await db
    .select()
    .from(koeConversations)
    .where(and(eq(koeConversations.identityId, identity.id), sql`${koeConversations.state} <> 'resolved'`))
    .limit(1)) as Conversation[];
  if (open) return { conversation: open };
  const [last] = (await db.select().from(koeConversations).where(eq(koeConversations.identityId, identity.id)).orderBy(desc(koeConversations.updatedAt)).limit(1)) as Conversation[];
  if (last) return { conversation: last };
  const now = new Date();
  const [created] = (await db
    .insert(koeConversations)
    .values({ id: newId(), channelId: channel.id, identityId: identity.id, contactId: contact.id, state: "resolved", resolvedAt: now, teamId: channel.defaultTeamId ?? null, metadata: { origin }, createdAt: now, updatedAt: now })
    .returning()) as Conversation[];
  await recordEvent(db, created!.id, "created", { kind: "system" }, { to: "resolved", reason: "business-initiated", data: origin });
  return { conversation: created! };
}

// ── The runner ─────────────────────────────────────────────────────────────

type Recipient = typeof koeCampaignRecipients.$inferSelect;

async function finishIfEmpty(ctx: KonContext, db: Db, campaignId: string): Promise<boolean> {
  const [left] = (await db
    .select({ n: count() })
    .from(koeCampaignRecipients)
    .where(and(eq(koeCampaignRecipients.campaignId, campaignId), eq(koeCampaignRecipients.status, "pending")))) as Array<{ n: number }>;
  if (Number(left?.n ?? 0) > 0) return false;
  const stats = await recipientCounts(db, campaignId);
  const done = (await db
    .update(koeCampaigns)
    .set({ status: "done", stats, updatedAt: new Date() })
    .where(and(eq(koeCampaigns.id, campaignId), eq(koeCampaigns.status, "running")))
    .returning({ id: koeCampaigns.id })) as unknown[];
  if (done.length) emit(ctx, "campaign.finished", { campaignId, sent: stats.sent ?? 0, failed: stats.failed ?? 0, skipped: stats.skipped ?? 0 });
  return done.length > 0;
}

async function recipientCounts(db: Db, campaignId: string): Promise<Record<string, number>> {
  const rows = (await db
    .select({ status: koeCampaignRecipients.status, n: count() })
    .from(koeCampaignRecipients)
    .where(eq(koeCampaignRecipients.campaignId, campaignId))
    .groupBy(koeCampaignRecipients.status)) as Array<{ status: string; n: number }>;
  const out: Record<string, number> = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}

/** One recipient: checks, conversation, send. Returns the row's new status and why. */
async function sendTo(ctx: KonContext, db: Db, campaign: Campaign, channel: Channel, r: Recipient): Promise<{ status: "sent" | "skipped" | "failed"; error?: string; messageId?: string }> {
  const [contact] = (await db.select().from(koeContacts).where(eq(koeContacts.id, r.contactId)).limit(1)) as Contact[];
  if (!contact) return { status: "skipped", error: "contact_gone" };
  if (contact.blocked) return { status: "skipped", error: "blocked" };
  const [consent] = (await db.select({ status: koeConsents.status }).from(koeConsents).where(and(eq(koeConsents.contactId, contact.id), eq(koeConsents.channelId, channel.id))).limit(1)) as Array<{ status: string }>;
  if (consent?.status !== "opted_in") return { status: "skipped", error: consent?.status === "opted_out" ? "opted_out" : "no_consent" };
  try {
    const message = await withSavepoint(async () => {
      const place = await conversationForOutbound(ctx, db, contact, channel, { campaignId: campaign.id });
      if ("skip" in place) return place.skip;
      return send(
        { ctx, db },
        {
          conversationId: place.conversation.id,
          author: { kind: "campaign", id: campaign.id },
          kind: "template",
          template: { templateId: campaign.templateId, values: { ...(campaign.variables ?? {}), ...(r.variables ?? {}) } },
          idempotencyKey: `campaign:${campaign.id}:${contact.id}`,
        }
      );
    });
    if (typeof message === "string") return { status: "skipped", error: message };
    return { status: "sent", messageId: message.id };
  } catch (err) {
    const code = koeCode(err);
    if (code === "OPTED_OUT" || code === "BLOCKED") return { status: "skipped", error: code.toLowerCase() };
    return { status: "failed", error: (code ?? (err instanceof Error ? err.message : String(err))).slice(0, 300) };
  }
}

/**
 * One batch of a running campaign: as many recipients as the rolling minute allows, outside quiet hours.
 * Returns how many it sent. Idempotent: claimed rows and idempotency keys keep a retry from sending twice.
 */
export async function runCampaignBatch(ctx: KonContext, campaignId: string, at: Date = new Date()): Promise<{ sent: number; skipped: number; failed: number; waiting: number }> {
  const db = dbOf(ctx);
  return asSystem(async () => {
    const result = { sent: 0, skipped: 0, failed: 0, waiting: 0 };
    const [campaign] = (await db.select().from(koeCampaigns).where(eq(koeCampaigns.id, campaignId)).limit(1)) as Campaign[];
    if (!campaign || campaign.status !== "running") return result;
    const [channel] = (await db.select().from(koeChannels).where(eq(koeChannels.id, campaign.channelId)).limit(1)) as Channel[];
    if (!channel || channel.status !== "active") return result;

    // Who cannot receive it is skipped at once, with the reason, without using the pace (sendTo checks again).
    await db.execute(sql`
      UPDATE koe_campaign_recipients r
      SET status = 'skipped', sent_at = NULL,
          error = CASE WHEN c.blocked THEN 'blocked' WHEN cs.status = 'opted_out' THEN 'opted_out' ELSE 'no_consent' END
      FROM koe_contacts c LEFT JOIN koe_consents cs ON cs.contact_id = c.id AND cs.channel_id = ${campaign.channelId}
      WHERE r.campaign_id = ${campaignId} AND r.status = 'pending' AND c.id = r.contact_id
        AND (c.blocked OR cs.status IS DISTINCT FROM 'opted_in')`);

    const minuteAgo = new Date(at.getTime() - 60_000);
    const stale = new Date(at.getTime() - CLAIM_MS);
    const waitingIds = new Set<string>();
    // Skipped recipients do not use the pace, so a batch keeps going until the minute's budget is spent.
    for (let round = 0; round < 20; round++) {
      // The pace: rows touched in the last minute (claimed, sent or failed) count against the rate.
      const [recent] = (await db
        .select({ n: count() })
        .from(koeCampaignRecipients)
        .where(and(eq(koeCampaignRecipients.campaignId, campaignId), sql`${koeCampaignRecipients.status} <> 'skipped'`, sql`${koeCampaignRecipients.sentAt} > ${minuteAgo.toISOString()}`))) as Array<{ n: number }>;
      const budget = Math.max(0, campaign.ratePerMinute - Number(recent?.n ?? 0));
      if (budget === 0) break;

      const candidates = (await db
        .select({ id: koeCampaignRecipients.id, attributes: koeContacts.attributes })
        .from(koeCampaignRecipients)
        .innerJoin(koeContacts, eq(koeContacts.id, koeCampaignRecipients.contactId))
        .where(and(eq(koeCampaignRecipients.campaignId, campaignId), eq(koeCampaignRecipients.status, "pending"), or(isNull(koeCampaignRecipients.sentAt), lt(koeCampaignRecipients.sentAt, stale))))
        .orderBy(asc(koeCampaignRecipients.id))
        .limit(Math.min(5000, waitingIds.size + Math.max(200, budget * 5)))) as Array<{ id: string; attributes: Record<string, unknown> }>;
      const allowed = candidates.filter((c) => {
        if (waitingIds.has(c.id)) return false;
        if (!inQuietHours(at, campaign.quietHours, contactTimeZone(c.attributes))) return true;
        waitingIds.add(c.id);
        return false;
      });
      const ids = allowed.slice(0, budget).map((c) => c.id);
      if (ids.length === 0) break;
      // Claim: whoever wins the conditional update sends; a second worker gets the rest or nothing.
      const claimed = (await db
        .update(koeCampaignRecipients)
        .set({ sentAt: at })
        .where(and(inArray(koeCampaignRecipients.id, ids), eq(koeCampaignRecipients.status, "pending"), or(isNull(koeCampaignRecipients.sentAt), lt(koeCampaignRecipients.sentAt, stale))))
        .returning()) as Recipient[];
      if (claimed.length === 0) break;

      for (const r of claimed) {
        const outcome = await sendTo(ctx, db, campaign, channel, r);
        result[outcome.status] += 1;
        await db
          .update(koeCampaignRecipients)
          .set({ status: outcome.status, error: outcome.error ?? null, messageId: outcome.messageId ?? null, sentAt: outcome.status === "skipped" ? null : at })
          .where(eq(koeCampaignRecipients.id, r.id));
      }
    }
    result.waiting = waitingIds.size;
    await db
      .update(koeCampaigns)
      .set({ stats: await recipientCounts(db, campaignId), updatedAt: new Date() })
      .where(eq(koeCampaigns.id, campaignId));
    await finishIfEmpty(ctx, db, campaignId);
    return result;
  });
}

/** For the sweep: scheduled campaigns whose time came start, and every running one gets a batch job. */
export async function campaignTick(ctx: KonContext, db: Db, now: Date): Promise<number> {
  const started = (await db
    .update(koeCampaigns)
    .set({ status: "running", updatedAt: new Date() })
    .where(and(eq(koeCampaigns.status, "scheduled"), sql`${koeCampaigns.scheduledAt} <= ${now.toISOString()}`))
    .returning({ id: koeCampaigns.id, name: koeCampaigns.name })) as Array<{ id: string; name: string }>;
  for (const c of started) emit(ctx, "campaign.started", { campaignId: c.id, name: c.name });
  const running = (await db.select({ id: koeCampaigns.id }).from(koeCampaigns).where(eq(koeCampaigns.status, "running"))) as Array<{ id: string }>;
  for (const c of running) await queue.dispatch(QUEUES.automation, "campaign", { campaignId: c.id, at: now.toISOString() }, { attempts: 3, reason: "koe campaign batch" });
  return running.length;
}

// ── Operations ─────────────────────────────────────────────────────────────

const Segment = z
  .object({
    contactIds: z.array(z.string().min(1).max(100)).max(5000).optional(),
    labels: z.array(z.string().min(1).max(60)).max(20).optional().describe("Contacts with a conversation carrying any of these labels"),
    attributes: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/), z.union([z.string().max(200), z.number(), z.boolean()])).optional().describe("Contacts whose attributes include all of these"),
  })
  .strict();

const Quiet = z
  .object({
    from: z.string().refine(isHhMm, "HH:MM"),
    to: z.string().refine(isHhMm, "HH:MM"),
    timezone: z.string().refine(validTimeZone, "an IANA time zone such as America/Lima"),
  })
  .describe("Do NOT send between `from` and `to` (it may wrap midnight: 21:00 → 08:00), in the contact's attribute `timezone` or else this one");

const CampaignFields = z.object({
  channelId: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  templateId: z.string().min(1).max(100),
  variables: z.record(z.string(), z.string().max(1024)).optional().describe('Template slot → value; "{{contact.name}}", "{{contact.attributes.debt}}" fill each recipient\'s own'),
  segment: Segment.optional(),
  ratePerMinute: z.number().int().min(1).max(6000).optional(),
  quietHours: Quiet.nullable().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
});

const ImportRow = z.object({
  phone: z.string().min(6).max(30).describe("With country code"),
  name: z.string().trim().max(200).optional(),
  attributes: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
  variables: z.record(z.string(), z.string().max(1024)).optional().describe("This recipient's own template values"),
  optIn: z.object({ source: z.string().trim().min(3).max(200).describe("Where THIS contact agreed: form, contract clause, store sign-up…") }).optional(),
});

async function campaignOr404(db: Db, id: string): Promise<Campaign> {
  const [c] = (await db.select().from(koeCampaigns).where(eq(koeCampaigns.id, id)).limit(1)) as Campaign[];
  if (!c) throw AppError.notFound("Campaign not found");
  return c;
}

async function checkTemplate(db: Db, channelId: string, templateId: string): Promise<{ channel: Channel; template: Template }> {
  const [channel] = (await db.select().from(koeChannels).where(eq(koeChannels.id, channelId)).limit(1)) as Channel[];
  if (!channel) throw AppError.validation("Channel not found");
  if (channel.kind !== "whatsapp") throw AppError.validation("Campaigns go through WhatsApp templates: pick a WhatsApp channel");
  const [template] = (await db.select().from(koeTemplates).where(and(eq(koeTemplates.id, templateId), eq(koeTemplates.channelId, channelId))).limit(1)) as Template[];
  if (!template) throw AppError.validation("Template not found on this channel");
  return { channel, template };
}

const editable = (c: Campaign) => c.status === "draft" && !c.approvedBy;

async function setStatus(db: Db, id: string, from: Campaign["status"][], set: Partial<Campaign>): Promise<Campaign> {
  const [row] = (await db
    .update(koeCampaigns)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(koeCampaigns.id, id), inArray(koeCampaigns.status, from)))
    .returning()) as Campaign[];
  if (!row) {
    const c = await campaignOr404(db, id);
    throw AppError.conflict(`The campaign is ${c.status}`);
  }
  return row;
}

/** What sending would reach and cost, from the recipients as they are now. */
export async function estimateCampaign(db: Db, campaign: Campaign) {
  const [template] = (await db.select({ category: koeTemplates.category, status: koeTemplates.status }).from(koeTemplates).where(eq(koeTemplates.id, campaign.templateId)).limit(1)) as Array<{ category: string; status: string }>;
  const rows = (await db
    .select({
      status: koeCampaignRecipients.status,
      phone: koeContacts.phone,
      blocked: koeContacts.blocked,
      consent: koeConsents.status,
      identity: koeIdentities.externalId,
    })
    .from(koeCampaignRecipients)
    .innerJoin(koeContacts, eq(koeContacts.id, koeCampaignRecipients.contactId))
    .leftJoin(koeConsents, and(eq(koeConsents.contactId, koeContacts.id), eq(koeConsents.channelId, campaign.channelId)))
    .leftJoin(koeIdentities, and(eq(koeIdentities.contactId, koeContacts.id), eq(koeIdentities.channelId, campaign.channelId)))
    .where(eq(koeCampaignRecipients.campaignId, campaign.id))) as Array<{ status: string; phone: string | null; blocked: boolean; consent: string | null; identity: string | null }>;
  const pricing = await pricingOf(db);
  const skipped = { noConsent: 0, optedOut: 0, blocked: 0, noPhone: 0 };
  let eligible = 0;
  let alreadyDone = 0;
  let cost = 0;
  let unknown = 0;
  for (const r of rows) {
    if (r.status !== "pending") {
      alreadyDone++;
      continue;
    }
    const phone = r.identity ?? r.phone;
    if (r.blocked) skipped.blocked++;
    else if (r.consent === "opted_out") skipped.optedOut++;
    else if (r.consent !== "opted_in") skipped.noConsent++;
    else if (!phone) skipped.noPhone++;
    else {
      eligible++;
      const p = priceFor(pricing, template?.category, phone);
      if (p === null) unknown++;
      else cost += p;
    }
  }
  return {
    recipients: rows.length,
    eligible,
    alreadyProcessed: alreadyDone,
    skipped,
    template: template ?? null,
    cost: pricing
      ? { currency: pricing.currency, estimated: Math.round(cost * 10_000) / 10_000, recipientsWithoutPrice: unknown, complete: unknown === 0, note: pricing.note ?? null }
      : { currency: null, estimated: null, recipientsWithoutPrice: eligible, complete: false, note: "No price table: an admin sets it with PUT /config/pricing" },
  };
}

export const campaignOperations: OperationsModule = (app, ctx) => {
  const db = (): Db => dbOf(ctx);

  app.get(
    "/config/pricing",
    {
      id: "get-pricing",
      summary: "Message price table",
      description: "The per-category, per-country price table admins keep for cost estimates. `null` when nobody set one: koe states no prices by itself.",
      access: "session",
      permission: USE,
      output: { schema: Output },
    },
    async (c, _i, h) => {
      await requireLead(db(), h.user);
      return c.json({ data: await pricingOf(db()) });
    }
  );

  app.put(
    "/config/pricing",
    {
      id: "set-pricing",
      summary: "Set the message price table",
      description: "Prices per message by template category and country calling code, as you pay them (check Meta's current rate card). Used only for estimates and reports. Admins only.",
      access: "session",
      permission: CONFIGURE,
      input: { body: PricingBody },
      output: { schema: Output },
    },
    async (c, input) => {
      const value = input.body as unknown as Record<string, unknown>;
      await db().insert(koeConfig).values({ key: "pricing", value }).onConflictDoUpdate({ target: koeConfig.key, set: { value, updatedAt: new Date() } });
      return c.json({ data: input.body });
    }
  );

  app.get(
    "/campaigns",
    {
      id: "list-campaigns",
      summary: "List campaigns",
      description: "Campaigns, newest first, with their status and counters. Paged with `limit` (1-100, default 50) and `offset`; `hasMore` says whether another page follows. Supervisors and admins.",
      access: "session",
      permission: USE,
      input: {
        query: z.object({
          status: z.enum(["draft", "scheduled", "running", "paused", "done", "cancelled"]).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0).describe("Rows to skip."),
        }),
      },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const where = input.query.status ? eq(koeCampaigns.status, input.query.status) : undefined;
      const { limit, offset } = input.query;
      const rows = await db().select().from(koeCampaigns).where(where).orderBy(desc(koeCampaigns.createdAt), desc(koeCampaigns.id)).limit(limit + 1).offset(offset);
      return c.json({ data: rows.slice(0, limit), hasMore: rows.length > limit });
    }
  );

  app.get(
    "/campaigns/:id",
    {
      id: "get-campaign",
      summary: "Get a campaign",
      description: "A campaign with its recipient counters.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const campaign = await campaignOr404(db(), input.params.id);
      return c.json({ data: { ...campaign, recipients: await recipientCounts(db(), campaign.id) } });
    }
  );

  app.post(
    "/campaigns",
    {
      id: "create-campaign",
      summary: "Create a campaign draft",
      description:
        "A draft: channel (WhatsApp), template, values, segment, pace (`ratePerMinute`) and quiet hours. Nothing is sent: add recipients, look at the estimate, approve, then schedule. Supervisors and admins.",
      access: "session",
      permission: USE,
      input: { body: CampaignFields },
      output: { schema: Output, status: 201 },
    },
    async (c, input, h) => {
      const me = await requireLead(db(), h.user);
      await checkTemplate(db(), input.body.channelId, input.body.templateId);
      const b = input.body;
      const [row] = (await db()
        .insert(koeCampaigns)
        .values({
          id: newId(),
          channelId: b.channelId,
          name: b.name,
          templateId: b.templateId,
          variables: b.variables ?? {},
          segment: b.segment ?? {},
          ratePerMinute: b.ratePerMinute ?? 60,
          quietHours: b.quietHours ?? null,
          scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : null,
          createdBy: me.userId,
        })
        .returning()) as Campaign[];
      return c.json({ data: row }, 201);
    }
  );

  app.patch(
    "/campaigns/:id",
    {
      id: "update-campaign",
      summary: "Change a campaign draft",
      description: "Only a draft not yet approved. Changing the template or the values does not touch the recipients.",
      access: "session",
      permission: USE,
      input: { params: ParamId, body: CampaignFields.omit({ channelId: true }).partial() },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const campaign = await campaignOr404(db(), input.params.id);
      if (!editable(campaign)) throw AppError.conflict("Only a draft that is not approved can change");
      if (input.body.templateId) await checkTemplate(db(), campaign.channelId, input.body.templateId);
      const { scheduledAt, quietHours, ...rest } = input.body;
      const [row] = (await db()
        .update(koeCampaigns)
        .set({
          ...rest,
          ...(scheduledAt !== undefined ? { scheduledAt: scheduledAt ? new Date(scheduledAt) : null } : {}),
          ...(quietHours !== undefined ? { quietHours: quietHours as never } : {}),
          updatedAt: new Date(),
        })
        .where(eq(koeCampaigns.id, campaign.id))
        .returning()) as Campaign[];
      return c.json({ data: row });
    }
  );

  app.delete(
    "/campaigns/:id",
    {
      id: "delete-campaign",
      summary: "Delete a campaign draft",
      description: "Deletes a draft (or a cancelled campaign) and its recipient list. A campaign that sent anything is kept for the record: cancel it instead.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const campaign = await campaignOr404(db(), input.params.id);
      const counts = await recipientCounts(db(), campaign.id);
      if (!(campaign.status === "draft" || campaign.status === "cancelled") || (counts.sent ?? 0) > 0 || (counts.failed ?? 0) > 0) throw AppError.conflict("Only a draft or a cancelled campaign that sent nothing can be deleted");
      await db().delete(koeCampaigns).where(eq(koeCampaigns.id, campaign.id));
      return c.json({ data: { ok: true } });
    }
  );

  app.post(
    "/campaigns/:id/recipients",
    {
      id: "add-campaign-recipients",
      summary: "Add recipients to a campaign",
      description:
        "`fromSegment: true` adds the contacts of the campaign's segment; `contacts` imports a list (phone with country code), creating contacts that do not exist. A row's `optIn.source` records THAT contact's consent on the channel; rows without it are added and will be skipped unless the contact already agreed. An opt-out the contact asked for is never overwritten. Only before approval.",
      access: "session",
      permission: USE,
      input: { params: ParamId, body: z.object({ fromSegment: z.boolean().optional(), contacts: z.array(ImportRow).max(5000).optional() }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const campaign = await campaignOr404(db(), input.params.id);
      if (!editable(campaign)) throw AppError.conflict("Recipients change only before approval");
      if (!input.body.fromSegment && !input.body.contacts?.length) throw AppError.validation("Give fromSegment: true or a list of contacts");
      const [have] = (await db().select({ n: count() }).from(koeCampaignRecipients).where(eq(koeCampaignRecipients.campaignId, campaign.id))) as Array<{ n: number }>;
      let room = MAX_RECIPIENTS - Number(have?.n ?? 0);
      const report = { added: 0, alreadyThere: 0, contactsCreated: 0, consentsRecorded: 0, optOutsKept: 0, invalidPhones: 0 };

      const addRows = async (rows: Array<{ contactId: string; variables?: Record<string, string> }>) => {
        for (let i = 0; i < rows.length && room > 0; i += 500) {
          const chunk = rows.slice(i, i + Math.min(500, room));
          const inserted = (await db()
            .insert(koeCampaignRecipients)
            .values(chunk.map((r) => ({ id: newId(), campaignId: campaign.id, contactId: r.contactId, variables: r.variables ?? {} })))
            .onConflictDoNothing()
            .returning({ id: koeCampaignRecipients.id })) as unknown[];
          report.added += inserted.length;
          report.alreadyThere += chunk.length - inserted.length;
          room -= inserted.length;
        }
      };

      if (input.body.fromSegment) {
        const s = (campaign.segment ?? {}) as z.infer<typeof Segment>;
        const filters: SQL[] = [];
        if (s.labels?.length) {
          filters.push(sql`EXISTS (SELECT 1 FROM koe_conversations cv WHERE cv.contact_id = ${koeContacts.id} AND cv.labels ?| ARRAY[${sql.join(s.labels.map((l) => sql`${l}`), sql`, `)}]::text[])`);
        }
        if (s.attributes && Object.keys(s.attributes).length) filters.push(sql`${koeContacts.attributes} @> ${JSON.stringify(s.attributes)}::jsonb`);
        const ids = new Set<string>(s.contactIds ?? []);
        if (filters.length) {
          const found = (await db().select({ id: koeContacts.id }).from(koeContacts).where(and(...filters)).limit(MAX_RECIPIENTS)) as Array<{ id: string }>;
          for (const f of found) ids.add(f.id);
        }
        if (ids.size === 0 && !s.contactIds?.length && !filters.length) throw AppError.validation("The campaign's segment is empty: set contactIds, labels or attributes");
        // Only contacts that exist (and the caller may see).
        const existing = ids.size ? ((await db().select({ id: koeContacts.id }).from(koeContacts).where(inArray(koeContacts.id, [...ids]))) as Array<{ id: string }>) : [];
        await addRows(existing.map((e) => ({ contactId: e.id })));
      }

      if (input.body.contacts?.length) {
        const seen = new Set<string>();
        const rows: Array<{ contactId: string; variables?: Record<string, string> }> = [];
        for (const row of input.body.contacts) {
          const phone = row.phone.replace(/[^\d]/g, "");
          if (phone.length < 8 || phone.length > 15) {
            report.invalidPhones++;
            continue;
          }
          if (seen.has(phone)) continue;
          seen.add(phone);
          let [contact] = (await db().select().from(koeContacts).where(eq(koeContacts.phone, phone)).limit(1)) as Contact[];
          if (!contact) {
            [contact] = (await db()
              .insert(koeContacts)
              .values({ id: newId(), displayName: row.name ?? null, phone, attributes: row.attributes ?? {} })
              .returning()) as Contact[];
            report.contactsCreated++;
          } else if (row.attributes || (row.name && !contact.displayName)) {
            await db()
              .update(koeContacts)
              .set({ ...(row.name && !contact.displayName ? { displayName: row.name } : {}), ...(row.attributes ? { attributes: sql`${koeContacts.attributes} || ${JSON.stringify(row.attributes)}::jsonb` } : {}), updatedAt: new Date() })
              .where(eq(koeContacts.id, contact.id));
          }
          if (row.optIn) {
            const [current] = (await db().select({ status: koeConsents.status }).from(koeConsents).where(and(eq(koeConsents.contactId, contact!.id), eq(koeConsents.channelId, campaign.channelId))).limit(1)) as Array<{ status: string }>;
            if (current?.status === "opted_out") report.optOutsKept++;
            else if (!current) {
              await db().insert(koeConsents).values({ id: newId(), contactId: contact!.id, channelId: campaign.channelId, status: "opted_in", source: `import: ${row.optIn.source}` }).onConflictDoNothing();
              report.consentsRecorded++;
              emit(ctx, "contact.opted_in", { contactId: contact!.id, channelId: campaign.channelId });
            }
          }
          rows.push({ contactId: contact!.id, variables: row.variables });
        }
        await addRows(rows);
      }
      return c.json({ data: { ...report, recipients: await recipientCounts(db(), campaign.id), limitReached: room <= 0 } });
    }
  );

  app.get(
    "/campaigns/:id/estimate",
    {
      id: "estimate-campaign",
      summary: "Estimate a campaign",
      description:
        "How many recipients it would reach, how many it would skip and why (no consent, opted out, blocked, no phone), and the estimated cost from the admins' price table (`null` when there is none: koe does not invent prices).",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const campaign = await campaignOr404(db(), input.params.id);
      return c.json({ data: await estimateCampaign(db(), campaign) });
    }
  );

  app.post(
    "/campaigns/:id/approve",
    {
      id: "approve-campaign",
      summary: "Approve a campaign",
      description: "Approves the draft as it is now (template approved by Meta, at least one recipient who agreed). An agent asking gets a proposal a person must accept. Recipients cannot change afterwards.",
      access: "session",
      permission: USE,
      sensitive: true,
      input: { params: ParamId },
      output: { schema: Output },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const me = await requireLead(db(), h.user);
      const campaign = await campaignOr404(db(), input.params.id);
      if (!editable(campaign)) throw AppError.conflict(campaign.approvedBy ? "Already approved" : `The campaign is ${campaign.status}`);
      const estimate = await estimateCampaign(db(), campaign);
      if (estimate.template?.status !== "approved") throw AppError.conflict(`The template is ${estimate.template?.status ?? "missing"}, not approved by Meta`);
      if (estimate.eligible === 0) throw AppError.conflict("No recipient has agreed to receive it");
      const [row] = (await db()
        .update(koeCampaigns)
        .set({ approvedBy: me.userId, estimatedCostUsd: estimate.cost.currency === "USD" && estimate.cost.estimated !== null ? String(estimate.cost.estimated) : null, updatedAt: new Date() })
        .where(and(eq(koeCampaigns.id, campaign.id), eq(koeCampaigns.status, "draft"), isNull(koeCampaigns.approvedBy)))
        .returning()) as Campaign[];
      if (!row) throw AppError.conflict("The campaign changed meanwhile");
      return c.json({ data: { ...row, estimate } });
    }
  );

  app.post(
    "/campaigns/:id/schedule",
    {
      id: "schedule-campaign",
      summary: "Schedule a campaign",
      description: "Starts an approved campaign at `scheduledAt` (now when left out). It then sends at its pace, outside quiet hours.",
      access: "session",
      permission: USE,
      sensitive: true,
      input: { params: ParamId, body: z.object({ scheduledAt: z.string().datetime().optional() }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const campaign = await campaignOr404(db(), input.params.id);
      if (!campaign.approvedBy) throw AppError.conflict("Approve the campaign first");
      const at = input.body.scheduledAt ? new Date(input.body.scheduledAt) : new Date();
      const now = at.getTime() <= Date.now();
      const row = await setStatus(db(), campaign.id, ["draft", "paused"], { status: now ? "running" : "scheduled", scheduledAt: at });
      if (now) {
        emit(ctx, "campaign.started", { campaignId: row.id, name: row.name });
        await queue.dispatch(QUEUES.automation, "campaign", { campaignId: row.id }, { attempts: 3, reason: "koe campaign batch" });
      }
      return c.json({ data: row });
    }
  );

  for (const [verb, from, to, summary] of [
    ["pause", ["scheduled", "running"], "paused", "Pause a campaign"],
    ["resume", ["paused"], "running", "Resume a campaign"],
  ] as const) {
    app.post(
      `/campaigns/:id/${verb}`,
      {
        id: `${verb}-campaign`,
        summary,
        description: verb === "pause" ? "Stops sending after the batch in flight; recipients stay pending." : "Continues a paused campaign (it waits for its scheduled time if that is still ahead).",
        access: "session",
        permission: USE,
        input: { params: ParamId },
        output: { schema: Output },
      },
      async (c, input, h) => {
        await requireLead(db(), h.user);
        const campaign = await campaignOr404(db(), input.params.id);
        const future = verb === "resume" && campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now();
        const row = await setStatus(db(), campaign.id, [...from], { status: future ? "scheduled" : to });
        if (row.status === "running") await queue.dispatch(QUEUES.automation, "campaign", { campaignId: row.id }, { attempts: 3, reason: "koe campaign batch" });
        return c.json({ data: row });
      }
    );
  }

  app.post(
    "/campaigns/:id/cancel",
    {
      id: "cancel-campaign",
      summary: "Cancel a campaign",
      description: "Stops it for good; recipients not reached yet are marked skipped (`cancelled`). What was sent stays sent.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const row = await setStatus(db(), input.params.id, ["draft", "scheduled", "running", "paused"], { status: "cancelled" });
      await db()
        .update(koeCampaignRecipients)
        .set({ status: "skipped", error: "cancelled", sentAt: null })
        .where(and(eq(koeCampaignRecipients.campaignId, row.id), eq(koeCampaignRecipients.status, "pending")));
      const stats = await recipientCounts(db(), row.id);
      await db().update(koeCampaigns).set({ stats }).where(eq(koeCampaigns.id, row.id));
      return c.json({ data: { ...row, stats } });
    }
  );

  app.get(
    "/campaigns/:id/stats",
    {
      id: "campaign-stats",
      summary: "Campaign results",
      description: "Recipients by status and skip reason, and what happened to the messages sent (delivered, read, failed), with the cost the price table gives for billable ones.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const campaign = await campaignOr404(db(), input.params.id);
      const reasons = (await db()
        .select({ reason: koeCampaignRecipients.error, n: count() })
        .from(koeCampaignRecipients)
        .where(and(eq(koeCampaignRecipients.campaignId, campaign.id), inArray(koeCampaignRecipients.status, ["skipped", "failed"])))
        .groupBy(koeCampaignRecipients.error)) as Array<{ reason: string | null; n: number }>;
      const messages = (await db()
        .select({ status: koeMessages.status, n: count() })
        .from(koeCampaignRecipients)
        .innerJoin(koeMessages, eq(koeMessages.id, koeCampaignRecipients.messageId))
        .where(eq(koeCampaignRecipients.campaignId, campaign.id))
        .groupBy(koeMessages.status)) as Array<{ status: string; n: number }>;
      const billable = (await db()
        .select({ category: sql<string | null>`${koeMessages.payload}->'pricing'->>'category'`, phone: koeContacts.phone })
        .from(koeCampaignRecipients)
        .innerJoin(koeMessages, eq(koeMessages.id, koeCampaignRecipients.messageId))
        .innerJoin(koeContacts, eq(koeContacts.id, koeCampaignRecipients.contactId))
        .where(and(eq(koeCampaignRecipients.campaignId, campaign.id), sql`(${koeMessages.payload}->'pricing'->>'billable')::boolean IS TRUE`))) as Array<{ category: string | null; phone: string | null }>;
      const pricing = await pricingOf(db());
      let cost = 0;
      let unpriced = 0;
      for (const b of billable) {
        const p = priceFor(pricing, b.category, b.phone);
        if (p === null) unpriced++;
        else cost += p;
      }
      return c.json({
        data: {
          campaignId: campaign.id,
          status: campaign.status,
          recipients: await recipientCounts(db(), campaign.id),
          reasons: Object.fromEntries(reasons.map((r) => [r.reason ?? "unknown", Number(r.n)])),
          messages: Object.fromEntries(messages.map((m) => [m.status, Number(m.n)])),
          billable: billable.length,
          cost: pricing ? { currency: pricing.currency, amount: Math.round(cost * 10_000) / 10_000, unpriced } : null,
        },
      });
    }
  );
};
