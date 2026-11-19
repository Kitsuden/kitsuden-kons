/**
 * Sales and collections: payment promises, outcomes, the portfolio and the pipeline
 * ============================================================================
 *
 * Collections teams live on promises: "I pay 150.00 on Friday". A promise belongs to a contact (and the
 * conversation it was made in), is `pending` until someone marks it `kept` or `cancelled`, and turns
 * `broken` by itself when its date passes (the sweep does it, with an event and a notice). Every attempt
 * can record an outcome (contacted, no answer, promise, paid, refused, wrong number, won, lost,
 * follow-up) for the reports.
 *
 * Row security decides who sees what: a promise is visible to whoever sees one of the contact's
 * conversations, an outcome to whoever sees its conversation.
 *
 * When kon-crm is installed (its `crm_deals` table exists) the sales pipeline shows each linked deal's
 * stage, read-only and through the caller's own row security: koe never writes to the CRM.
 */

import { AppError, attemptSql } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import { rowsOf } from "./koe.campaigns";
import { dbOf, emit, newId, QUEUES, type Db } from "./koe.common";
import { requireMember, USE } from "./koe.policy";
import { koeContacts, koeConversations, koeOutcomes, koePromises, koeTeams, type Conversation } from "./koe.schema";
import { Output, ParamId, type OperationsModule } from "./operations";
import { queue } from "@kitsuden/engine";

export type PaymentPromise = typeof koePromises.$inferSelect;

export const OUTCOME_KINDS = ["contacted", "no_answer", "promise", "paid", "refused", "wrong_number", "won", "lost", "follow_up"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** A page of a list that used to stop at 200 rows with no sign: the default is still those 200. */
const Page200 = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(200).describe("Rows per page (1-200). The default is the maximum, what the list always returned."),
  offset: z.coerce.number().int().min(0).default(0).describe("Rows to skip."),
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

async function conversationOr404(db: Db, id: string): Promise<Conversation> {
  const [c] = (await db.select().from(koeConversations).where(eq(koeConversations.id, id)).limit(1)) as Conversation[];
  if (!c) throw AppError.notFound("Conversation not found");
  return c;
}

/** Records an outcome (also the automation step `record-outcome`). */
export async function recordOutcome(ctx: KonContext, db: Db, conversationId: string, o: { kind: OutcomeKind; amountCents?: number | null; currency?: string | null; note?: string | null }, authorId: string | null) {
  const [row] = (await db
    .insert(koeOutcomes)
    .values({ id: newId(), conversationId, kind: o.kind, amountCents: o.amountCents ?? null, currency: o.currency ?? null, note: o.note ?? null, authorId })
    .returning()) as Array<typeof koeOutcomes.$inferSelect>;
  emit(ctx, "outcome.recorded", { conversationId, kind: o.kind, amountCents: o.amountCents ?? null, currency: o.currency ?? null, outcomeId: row!.id });
  return row!;
}

/**
 * For the sweep: promises whose date passed become broken, once (the conditional update), with an event
 * and a notice to whoever has the conversation (or the leads).
 */
export async function breakOverduePromises(ctx: KonContext, db: Db, now: Date): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const broken = (await db
    .update(koePromises)
    .set({ status: "broken", resolvedAt: now })
    .where(and(eq(koePromises.status, "pending"), sql`${koePromises.dueDate} < ${today}::date`))
    .returning()) as PaymentPromise[];
  for (const p of broken) {
    emit(ctx, "promise.broken", { promiseId: p.id, contactId: p.contactId, conversationId: p.conversationId, amountCents: p.amountCents, currency: p.currency, dueDate: p.dueDate });
    const [conv] = p.conversationId ? ((await db.select({ assigneeId: koeConversations.assigneeId }).from(koeConversations).where(eq(koeConversations.id, p.conversationId)).limit(1)) as Array<{ assigneeId: string | null }>) : [];
    const title = `A payment promise was not kept (${(p.amountCents / 100).toFixed(2)} ${p.currency}, due ${p.dueDate})`;
    if (conv?.assigneeId) await queue.dispatch(QUEUES.notify, "user", { userId: conv.assigneeId, kind: "promise", title, conversationId: p.conversationId }, { attempts: 3 });
    else await queue.dispatch(QUEUES.notify, "leads", { kind: "promise", title, conversationId: p.conversationId }, { attempts: 3 });
  }
  return broken.length;
}

const PromiseBody = z.object({
  amountCents: z.number().int().positive().max(1e13).describe("In cents: 15000 = 150.00"),
  currency: z.string().regex(/^[A-Z]{3}$/).describe("ISO 4217"),
  dueDate: z.string().refine(isRealDate, "a date such as 2026-11-20"),
  reference: z.string().trim().max(200).optional().describe("Invoice, loan or account number"),
  note: z.string().trim().max(2000).optional(),
});

/** kon-crm's deals for these ids, read as the caller; null when kon-crm is not installed or refuses. */
async function crmDeals(db: Db, ids: string[]): Promise<Map<string, Record<string, unknown>> | null> {
  const present = await attemptSql(async () => rowsOf<{ ok: boolean }>(await db.execute(sql`SELECT to_regclass('public.crm_deals') IS NOT NULL AS ok`))[0]?.ok === true, false);
  if (!present) return null;
  if (!ids.length) return new Map();
  const rows = await attemptSql(
    async () =>
      rowsOf<Record<string, unknown>>(
        await db.execute(
          sql`SELECT d.id, d.title, d.status::text AS status, d.value, d.currency, s.name AS stage FROM crm_deals d LEFT JOIN crm_pipeline_stages s ON s.id = d.stage_id WHERE d.id IN (${sql.join(
            ids.map((i) => sql`${i}`),
            sql`, `
          )})`
        )
      ),
    null as Array<Record<string, unknown>> | null
  );
  if (!rows) return null;
  return new Map(rows.map((r) => [String(r.id), r]));
}

export const salesOperations: OperationsModule = (app, ctx) => {
  const db = (): Db => dbOf(ctx);

  app.post(
    "/conversations/:id/promises",
    {
      id: "create-promise",
      summary: "Record a payment promise",
      description: "The contact promises to pay an amount by a date. It turns `broken` by itself if nobody marks it `kept` by then.",
      access: "session",
      permission: USE,
      input: { params: ParamId, body: PromiseBody },
      output: { schema: Output, status: 201 },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const conv = await conversationOr404(db(), input.params.id);
      const [row] = (await db()
        .insert(koePromises)
        .values({ id: newId(), conversationId: conv.id, contactId: conv.contactId, ...input.body, createdBy: me.userId })
        .returning()) as PaymentPromise[];
      emit(ctx, "promise.created", { promiseId: row!.id, contactId: row!.contactId, conversationId: conv.id, amountCents: row!.amountCents, currency: row!.currency, dueDate: row!.dueDate });
      return c.json({ data: row }, 201);
    }
  );

  app.get(
    "/conversations/:id/promises",
    {
      id: "list-promises",
      summary: "Payment promises of a contact",
      description: "Every promise of the conversation's contact (on any channel), newest first. Paged with `limit` (1-200, default 200) and `offset`; `hasMore` says whether another page follows.",
      access: "session",
      permission: USE,
      input: { params: ParamId, query: Page200 },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const conv = await conversationOr404(db(), input.params.id);
      const { limit, offset } = input.query as z.infer<typeof Page200>;
      const rows = await db().select().from(koePromises).where(eq(koePromises.contactId, conv.contactId)).orderBy(desc(koePromises.createdAt), desc(koePromises.id)).limit(limit + 1).offset(offset);
      return c.json({ data: rows.slice(0, limit), hasMore: rows.length > limit });
    }
  );

  app.patch(
    "/promises/:id",
    {
      id: "update-promise",
      summary: "Mark a payment promise kept or cancelled",
      description: "`kept` when the payment arrived (also after it was marked broken: a late payment), `cancelled` when it no longer applies.",
      access: "session",
      permission: USE,
      input: { params: ParamId, body: z.object({ status: z.enum(["kept", "cancelled"]), note: z.string().trim().max(2000).optional() }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const from = input.body.status === "kept" ? ["pending", "broken"] : ["pending"];
      const [row] = (await db()
        .update(koePromises)
        .set({ status: input.body.status, resolvedAt: new Date(), ...(input.body.note ? { note: input.body.note } : {}) })
        .where(and(eq(koePromises.id, input.params.id), inArray(koePromises.status, from as Array<PaymentPromise["status"]>)))
        .returning()) as PaymentPromise[];
      if (!row) {
        const [p] = (await db().select({ status: koePromises.status }).from(koePromises).where(eq(koePromises.id, input.params.id)).limit(1)) as Array<{ status: string }>;
        if (!p) throw AppError.notFound("Promise not found");
        throw AppError.conflict(`The promise is already ${p.status}`);
      }
      if (row.status === "kept") emit(ctx, "promise.kept", { promiseId: row.id, contactId: row.contactId, conversationId: row.conversationId, amountCents: row.amountCents, currency: row.currency });
      return c.json({ data: row });
    }
  );

  app.post(
    "/conversations/:id/outcomes",
    {
      id: "record-outcome",
      summary: "Record the outcome of an attempt",
      description: "What came of a sales or collections attempt, for the reports: contacted, no_answer, promise, paid, refused, wrong_number, won, lost, follow_up.",
      access: "session",
      permission: USE,
      input: {
        params: ParamId,
        body: z.object({ kind: z.enum(OUTCOME_KINDS), amountCents: z.number().int().min(0).max(1e13).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), note: z.string().trim().max(2000).optional() }),
      },
      output: { schema: Output, status: 201 },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const conv = await conversationOr404(db(), input.params.id);
      if (input.body.amountCents !== undefined && !input.body.currency) throw AppError.validation("An amount needs its currency");
      return c.json({ data: await recordOutcome(ctx, db(), conv.id, input.body, me.userId) }, 201);
    }
  );

  app.get(
    "/conversations/:id/outcomes",
    {
      id: "list-outcomes",
      summary: "Outcomes of a conversation",
      description: "The recorded outcomes of a conversation, newest first. Paged with `limit` (1-200, default 200) and `offset`; `hasMore` says whether another page follows.",
      access: "session",
      permission: USE,
      input: { params: ParamId, query: Page200 },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      await conversationOr404(db(), input.params.id);
      const { limit, offset } = input.query as z.infer<typeof Page200>;
      const rows = await db().select().from(koeOutcomes).where(eq(koeOutcomes.conversationId, input.params.id)).orderBy(desc(koeOutcomes.createdAt), desc(koeOutcomes.id)).limit(limit + 1).offset(offset);
      return c.json({ data: rows.slice(0, limit), hasMore: rows.length > limit });
    }
  );

  app.get(
    "/collections/portfolio",
    {
      id: "collections-portfolio",
      summary: "Collections portfolio",
      description: "Payment promises by due date with their contact, and totals per currency. Defaults to pending ones; `from`/`to` limit the dates. You see the contacts of the conversations you can see.",
      access: "session",
      permission: USE,
      input: {
        query: z.object({
          status: z.enum(["pending", "kept", "broken", "cancelled", "all"]).default("pending"),
          from: z.string().refine(isRealDate, "YYYY-MM-DD").optional(),
          to: z.string().refine(isRealDate, "YYYY-MM-DD").optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const q = input.query;
      const where = and(
        ...(q.status !== "all" ? [eq(koePromises.status, q.status)] : []),
        ...(q.from ? [gte(koePromises.dueDate, q.from)] : []),
        ...(q.to ? [lte(koePromises.dueDate, q.to)] : [])
      );
      const rows = (await db()
        .select({
          id: koePromises.id,
          dueDate: koePromises.dueDate,
          amountCents: koePromises.amountCents,
          currency: koePromises.currency,
          status: koePromises.status,
          reference: koePromises.reference,
          note: koePromises.note,
          conversationId: koePromises.conversationId,
          contact: { id: koeContacts.id, displayName: koeContacts.displayName, phone: koeContacts.phone },
        })
        .from(koePromises)
        .innerJoin(koeContacts, eq(koeContacts.id, koePromises.contactId))
        .where(where)
        .orderBy(asc(koePromises.dueDate), asc(koePromises.id))
        .limit(q.limit)) as Array<{ amountCents: number; currency: string; status: string }>;
      const totals = (await db()
        .select({ currency: koePromises.currency, status: koePromises.status, amountCents: sql<string>`sum(${koePromises.amountCents})`, n: sql<number>`count(*)::int` })
        .from(koePromises)
        .where(where)
        .groupBy(koePromises.currency, koePromises.status)) as Array<{ currency: string; status: string; amountCents: string; n: number }>;
      return c.json({ data: rows, totals: totals.map((t) => ({ ...t, amountCents: Number(t.amountCents) })) });
    }
  );

  app.get(
    "/sales/pipeline",
    {
      id: "sales-pipeline",
      summary: "Sales pipeline",
      description:
        "Open conversations of sales teams, with labels, assignee, last message and the linked CRM deal. When kon-crm is installed, each deal's title, stage and value come along read-only (`crm: null` when it is not, or you cannot read it).",
      access: "session",
      permission: USE,
      input: { query: z.object({ teamId: z.string().max(100).optional(), label: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const q = input.query;
      const rows = (await db()
        .select({
          id: koeConversations.id,
          state: koeConversations.state,
          teamId: koeConversations.teamId,
          team: koeTeams.name,
          assigneeId: koeConversations.assigneeId,
          labels: koeConversations.labels,
          priority: koeConversations.priority,
          crmDealId: koeConversations.crmDealId,
          lastMessageAt: koeConversations.lastMessageAt,
          lastMessagePreview: koeConversations.lastMessagePreview,
          contact: { id: koeContacts.id, displayName: koeContacts.displayName, phone: koeContacts.phone },
        })
        .from(koeConversations)
        .innerJoin(koeTeams, eq(koeTeams.id, koeConversations.teamId))
        .innerJoin(koeContacts, eq(koeContacts.id, koeConversations.contactId))
        .where(
          and(
            eq(koeTeams.purpose, "sales"),
            ne(koeConversations.state, "resolved"),
            ...(q.teamId ? [eq(koeConversations.teamId, q.teamId)] : []),
            ...(q.label ? [sql`${koeConversations.labels} ? ${q.label}`] : [])
          )
        )
        .orderBy(sql`${koeConversations.lastMessageAt} DESC NULLS LAST`)
        .limit(q.limit)) as Array<{ crmDealId: string | null; labels: string[] } & Record<string, unknown>>;
      const deals = await crmDeals(
        db(),
        rows.flatMap((r) => (r.crmDealId ? [r.crmDealId] : []))
      );
      const byLabel: Record<string, number> = {};
      for (const r of rows) for (const l of r.labels ?? []) byLabel[l] = (byLabel[l] ?? 0) + 1;
      return c.json({
        data: rows.map((r) => ({ ...r, deal: r.crmDealId && deals ? (deals.get(r.crmDealId) ?? null) : null })),
        byLabel,
        crm: deals ? "installed" : null,
      });
    }
  );
};
