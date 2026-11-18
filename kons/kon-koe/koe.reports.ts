/**
 * Reports: what the core's aggregate queries can say, and the inbox dashboard for the rest
 * ============================================================================
 *
 * `koeReports` are core reports (docs/reports.md): one table, counts and sums grouped by columns, run
 * by the core as whoever asks, under koe's row security. They appear in `GET /api/reports` as
 * `kon:kon-koe/<id>` and can go on any dashboard.
 *
 * What one aggregate query cannot say lives in `GET /reports/summary` (supervisors and admins):
 *   - first response time per team (a difference of two timestamps, from the moment each opening began),
 *     average and median;
 *   - SLA breach rate per team;
 *   - campaign results with their recipients;
 *   - collections: promised against kept and broken amounts per currency;
 *   - template costs: billable template messages (Meta reports `pricing` on each status) by category, priced
 *     with the admins' table when there is one. koe never assumes a price.
 */

import type { KonContext, ReportDefinition } from "@kitsuden/shared";
import { sql, type SQL } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import { pricingOf, priceFor, rowsOf } from "./koe.campaigns";
import { dbOf, type Db } from "./koe.common";
import { requireLead, USE } from "./koe.policy";
import { Output, type OperationsModule } from "./operations";

export const koeReports: ReportDefinition[] = [
  {
    id: "conversations-per-day",
    name: "koe: conversations per channel per day",
    description: "New conversations, by channel and day (UTC).",
    query: {
      source: { table: "koe_conversations" },
      measures: [{ fn: "count", as: "conversations" }],
      groupBy: [
        { field: "created_at", bucket: "day", as: "day" },
        { field: "channel_id", as: "channel" },
      ],
      orderBy: [{ by: "day", dir: "asc" }],
      limit: 1000,
    },
    chart: { type: "bar", x: "day", y: ["conversations"] },
  },
  {
    id: "resolved-per-agent",
    name: "koe: conversations resolved per person",
    description: "Resolutions by the person who resolved them.",
    query: {
      source: { table: "koe_conversation_events" },
      measures: [{ fn: "count", as: "resolved" }],
      groupBy: [{ field: "actor_id", as: "person" }],
      filters: [
        { field: "type", op: "eq", value: "state" },
        { field: "to_state", op: "eq", value: "resolved" },
        { field: "actor_kind", op: "eq", value: "agent" },
      ],
      orderBy: [{ by: "resolved", dir: "desc" }],
    },
    chart: { type: "bar", x: "person", y: ["resolved"] },
  },
  {
    id: "sla-breaches-per-team",
    name: "koe: SLA breaches per team",
    description: "Conversations with an SLA, by team and whether they missed it.",
    query: {
      source: { table: "koe_conversations" },
      measures: [{ fn: "count", as: "conversations" }],
      groupBy: [
        { field: "team_id", as: "team" },
        { field: "sla_breached", as: "breached" },
      ],
      filters: [{ field: "first_response_due_at", op: "is_null", value: false }],
    },
    chart: { type: "table" },
  },
  {
    id: "campaign-results",
    name: "koe: campaign results",
    description: "Recipients of each campaign by status (sent, skipped, failed, pending).",
    query: {
      source: { table: "koe_campaign_recipients" },
      measures: [{ fn: "count", as: "recipients" }],
      groupBy: [
        { field: "campaign_id", as: "campaign" },
        { field: "status", as: "status" },
      ],
    },
    chart: { type: "table" },
  },
  {
    id: "promises-by-status",
    name: "koe: payment promises by status",
    description: "Promised amounts (in cents) and counts, by currency and status: pending, kept, broken, cancelled.",
    query: {
      source: { table: "koe_promises" },
      measures: [
        { fn: "sum", field: "amount_cents", as: "amount_cents" },
        { fn: "count", as: "promises" },
      ],
      groupBy: [
        { field: "currency", as: "currency" },
        { field: "status", as: "status" },
      ],
    },
    chart: { type: "table" },
  },
  {
    id: "outcomes-by-kind",
    name: "koe: outcomes of sales and collections attempts",
    description: "Recorded outcomes by kind.",
    query: {
      source: { table: "koe_outcomes" },
      measures: [{ fn: "count", as: "outcomes" }],
      groupBy: [{ field: "kind", as: "kind" }],
      orderBy: [{ by: "outcomes", dir: "desc" }],
    },
    chart: { type: "donut", x: "kind", y: ["outcomes"] },
  },
  {
    id: "messages-sent-per-day",
    name: "koe: messages sent per day",
    description: "Outbound messages by day and by who wrote them (person, bot, AI, rule, campaign).",
    query: {
      source: { table: "koe_messages" },
      measures: [{ fn: "count", as: "messages" }],
      groupBy: [
        { field: "created_at", bucket: "day", as: "day" },
        { field: "author_kind", as: "author" },
      ],
      filters: [{ field: "direction", op: "eq", value: "out" }],
      orderBy: [{ by: "day", dir: "asc" }],
      limit: 1000,
    },
    chart: { type: "line", x: "day", y: ["messages"] },
  },
];

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export interface SummaryRange {
  from: Date;
  to: Date;
  teamId?: string | null;
}

/** The dashboard numbers. Runs with the caller's row security (a lead sees everything). */
export async function reportSummary(db: Db, range: SummaryRange) {
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  const team: SQL = range.teamId ? sql`AND c.team_id = ${range.teamId}` : sql``;
  const q = async <T>(query: SQL) => rowsOf<T>(await db.execute(query));

  const perDay = await q<{ day: string; channel_id: string; channel: string | null; n: string }>(sql`
    SELECT to_char(date_trunc('day', c.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, c.channel_id, ch.name AS channel, count(*) AS n
    FROM koe_conversations c LEFT JOIN koe_channels ch ON ch.id = c.channel_id
    WHERE c.created_at >= ${from} AND c.created_at < ${to} ${team}
    GROUP BY 1, 2, 3 ORDER BY 1, 3`);

  // From when each opening began: the conversation's creation, or the last time it was reopened.
  const frt = await q<{ team_id: string | null; team: string | null; n: string; avg_s: string | null; median_s: string | null }>(sql`
    WITH r AS (
      SELECT c.team_id, extract(epoch FROM c.first_responded_at - coalesce(
        (SELECT max(e.created_at) FROM koe_conversation_events e WHERE e.conversation_id = c.id AND e.from_state = 'resolved' AND e.created_at <= c.first_responded_at),
        c.created_at)) AS s
      FROM koe_conversations c
      WHERE c.first_responded_at >= ${from} AND c.first_responded_at < ${to} ${team}
    )
    SELECT r.team_id, t.name AS team, count(*) AS n, avg(r.s) AS avg_s, percentile_cont(0.5) WITHIN GROUP (ORDER BY r.s) AS median_s
    FROM r LEFT JOIN koe_teams t ON t.id = r.team_id GROUP BY 1, 2 ORDER BY 2`);

  const resolved = await q<{ user_id: string | null; name: string | null; n: string }>(sql`
    SELECT e.actor_id AS user_id, m.display_name AS name, count(*) AS n
    FROM koe_conversation_events e JOIN koe_conversations c ON c.id = e.conversation_id LEFT JOIN koe_members m ON m.user_id = e.actor_id
    WHERE e.type = 'state' AND e.to_state = 'resolved' AND e.actor_kind = 'agent' AND e.created_at >= ${from} AND e.created_at < ${to} ${team}
    GROUP BY 1, 2 ORDER BY 3 DESC`);

  const sla = await q<{ team_id: string | null; team: string | null; total: string; breached: string }>(sql`
    SELECT c.team_id, t.name AS team, count(*) AS total, count(*) FILTER (WHERE c.sla_breached) AS breached
    FROM koe_conversations c LEFT JOIN koe_teams t ON t.id = c.team_id
    WHERE (c.first_response_due_at IS NOT NULL OR c.resolution_due_at IS NOT NULL)
      AND coalesce(c.first_response_due_at, c.resolution_due_at) >= ${from} AND coalesce(c.first_response_due_at, c.resolution_due_at) < ${to} ${team}
    GROUP BY 1, 2 ORDER BY 2`);

  const campaigns = await q<{ id: string; name: string; status: string; pending: string; sent: string; failed: string; skipped: string; delivered: string; read: string }>(sql`
    SELECT k.id, k.name, k.status,
      count(r.id) FILTER (WHERE r.status = 'pending') AS pending,
      count(r.id) FILTER (WHERE r.status = 'sent') AS sent,
      count(r.id) FILTER (WHERE r.status = 'failed') AS failed,
      count(r.id) FILTER (WHERE r.status = 'skipped') AS skipped,
      count(m.id) FILTER (WHERE m.status IN ('delivered', 'read')) AS delivered,
      count(m.id) FILTER (WHERE m.status = 'read') AS read
    FROM koe_campaigns k LEFT JOIN koe_campaign_recipients r ON r.campaign_id = k.id LEFT JOIN koe_messages m ON m.id = r.message_id
    WHERE (k.created_at >= ${from} AND k.created_at < ${to}) OR k.status IN ('running', 'scheduled', 'paused')
    GROUP BY 1, 2, 3 ORDER BY max(k.created_at) DESC`);

  const promises = await q<{ currency: string; status: string; amount: string; n: string }>(sql`
    SELECT p.currency, p.status, sum(p.amount_cents) AS amount, count(*) AS n
    FROM koe_promises p LEFT JOIN koe_conversations c ON c.id = p.conversation_id
    WHERE p.created_at >= ${from} AND p.created_at < ${to} ${range.teamId ? sql`AND c.team_id = ${range.teamId}` : sql``}
    GROUP BY 1, 2`);
  const collections = new Map<string, { currency: string; promisedCents: number; keptCents: number; brokenCents: number; pendingCents: number; cancelledCents: number; promises: number; kept: number; broken: number }>();
  for (const p of promises) {
    const c = collections.get(p.currency) ?? { currency: p.currency, promisedCents: 0, keptCents: 0, brokenCents: 0, pendingCents: 0, cancelledCents: 0, promises: 0, kept: 0, broken: 0 };
    const amount = n(p.amount);
    if (p.status !== "cancelled") {
      c.promisedCents += amount;
      c.promises += n(p.n);
    }
    if (p.status === "kept") {
      c.keptCents += amount;
      c.kept += n(p.n);
    }
    if (p.status === "broken") {
      c.brokenCents += amount;
      c.broken += n(p.n);
    }
    if (p.status === "pending") c.pendingCents += amount;
    if (p.status === "cancelled") c.cancelledCents += amount;
    collections.set(p.currency, c);
  }

  const outcomes = await q<{ kind: string; n: string; amount: string | null }>(sql`
    SELECT o.kind, count(*) AS n, sum(o.amount_cents) AS amount
    FROM koe_outcomes o JOIN koe_conversations c ON c.id = o.conversation_id
    WHERE o.created_at >= ${from} AND o.created_at < ${to} ${team}
    GROUP BY 1 ORDER BY 2 DESC`);

  // Template costs: the category and billability Meta reported; the price from the admins' table.
  const billed = await q<{ category: string | null; billable: boolean | null; prefix: string | null; n: string }>(sql`
    SELECT coalesce(m.payload->'pricing'->>'category', m.payload->'template'->>'category') AS category,
      (m.payload->'pricing'->>'billable')::boolean AS billable,
      left(regexp_replace(coalesce(i.external_id, ct.phone, ''), '[^0-9]', '', 'g'), 4) AS prefix,
      count(*) AS n
    FROM koe_messages m JOIN koe_conversations c ON c.id = m.conversation_id
      LEFT JOIN koe_identities i ON i.id = c.identity_id LEFT JOIN koe_contacts ct ON ct.id = c.contact_id
    WHERE m.direction = 'out' AND m.kind = 'template' AND m.created_at >= ${from} AND m.created_at < ${to} ${team}
    GROUP BY 1, 2, 3`);
  const pricing = await pricingOf(db);
  const costs = new Map<string, { category: string; messages: number; billable: number; reported: number; cost: number | null; unpriced: number }>();
  for (const b of billed) {
    const category = b.category ?? "unknown";
    const row = costs.get(category) ?? { category, messages: 0, billable: 0, reported: 0, cost: pricing ? 0 : null, unpriced: 0 };
    const count = n(b.n);
    row.messages += count;
    if (b.billable !== null) row.reported += count;
    if (b.billable) {
      row.billable += count;
      const price = priceFor(pricing, b.category, b.prefix);
      if (price === null) row.unpriced += count;
      else if (row.cost !== null) row.cost = round(row.cost + price * count, 4);
    }
    costs.set(category, row);
  }

  return {
    range: { from, to, teamId: range.teamId ?? null },
    conversationsPerChannelPerDay: perDay.map((r) => ({ day: r.day, channelId: r.channel_id, channel: r.channel, conversations: n(r.n) })),
    firstResponse: frt.map((r) => ({ teamId: r.team_id, team: r.team, conversations: n(r.n), avgSeconds: r.avg_s === null ? null : round(n(r.avg_s), 1), medianSeconds: r.median_s === null ? null : round(n(r.median_s), 1) })),
    resolvedPerAgent: resolved.map((r) => ({ userId: r.user_id, name: r.name, resolved: n(r.n) })),
    sla: sla.map((r) => ({ teamId: r.team_id, team: r.team, conversations: n(r.total), breached: n(r.breached), breachRate: n(r.total) ? round(n(r.breached) / n(r.total), 4) : 0 })),
    campaigns: campaigns.map((r) => ({ id: r.id, name: r.name, status: r.status, pending: n(r.pending), sent: n(r.sent), failed: n(r.failed), skipped: n(r.skipped), delivered: n(r.delivered), read: n(r.read) })),
    collections: [...collections.values()].map((c) => ({ ...c, keptRate: c.kept + c.broken ? round(c.kept / (c.kept + c.broken), 4) : null })),
    outcomes: outcomes.map((o) => ({ kind: o.kind, count: n(o.n), amountCents: o.amount === null ? null : n(o.amount) })),
    templateCosts: { currency: pricing?.currency ?? null, pricing: pricing ? "set" : "unset", byCategory: [...costs.values()] },
  };
}

export const reportOperations: OperationsModule = (app, ctx: KonContext) => {
  const db = (): Db => dbOf(ctx);

  app.get(
    "/reports/summary",
    {
      id: "koe-reports-summary",
      summary: "Inbox dashboard",
      description:
        "Conversations per channel and day, first response time per team (average and median, seconds), resolutions per person, SLA breach rate, campaign results, collections (promised, kept, broken per currency) and template costs (from the admins' price table; `null` without one). Default range: the last 30 days. Supervisors and admins.",
      access: "session",
      permission: USE,
      input: { query: z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), teamId: z.string().max(100).optional() }) },
      output: { schema: Output },
      cost: 2,
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const to = input.query.to ? new Date(input.query.to) : new Date();
      const from = input.query.from ? new Date(input.query.from) : new Date(to.getTime() - 30 * 24 * 3_600_000);
      return c.json({ data: await reportSummary(db(), { from, to, teamId: input.query.teamId ?? null }) });
    }
  );
};
