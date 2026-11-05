/**
 * Management reports: receivables, work in progress, collection and profitability
 * ============================================================================
 *
 * Read-only, computed from invoices, payments, work entries and ledger lines. Nothing is stored.
 * The aging report states its difference with the receivable account instead of hiding it.
 */

import dayjs from "dayjs";
import { Decimal } from "decimal.js";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import {
  accounts,
  bankLines,
  counterparties,
  currencies,
  disbursements,
  invoiceLines,
  invoicePayments,
  invoices,
  journals,
  ledgerEntries,
  projects,
  recurringFees,
  workEntries,
  resources,
} from "./conta.schema";
import { ContaService, IN_THE_BOOKS, d, isRealDate, toDb, AccountingError } from "./conta.service";
import type { ContaDb } from "./types";

const today = (): string => dayjs().format("YYYY-MM-DD");

function asOfDate(value?: string): string {
  const date = value ?? today();
  if (!isRealDate(date)) throw new AccountingError(`Invalid date: ${date}`);
  return date;
}

/** Percentage with one decimal, or null when there is nothing to divide by. */
function percent(part: Decimal, whole: Decimal): number | null {
  if (!whole.greaterThan(0)) return null;
  return part.dividedBy(whole).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toNumber();
}

export const AGING_BUCKETS = ["current", "days1to30", "days31to60", "days61to90", "over90"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

function bucketOf(days: number): AgingBucket {
  if (days <= 0) return "current";
  if (days <= 30) return "days1to30";
  if (days <= 60) return "days31to60";
  if (days <= 90) return "days61to90";
  return "over90";
}

export class ContaReports {
  private conta: ContaService;

  constructor(private db: ContaDb) {
    this.conta = new ContaService(db);
  }

  private async decimals(): Promise<number> {
    const settings = await this.conta.getSettings();
    const [row] = await this.db
      .select({ decimalPlaces: currencies.decimalPlaces })
      .from(currencies)
      .where(eq(currencies.code, settings.baseCurrency))
      .limit(1);
    return Number(row?.decimalPlaces ?? 2);
  }

  /**
   * What each invoice still owed on a date: issued by then, not yet voided by then, less the
   * payments made by then and not yet reversed by then. Later events do not change a past report.
   */
  private async openBalances(asOf: string) {
    const rows = await this.db
      .select({
        id: invoices.id,
        number: invoices.number,
        clientId: invoices.clientId,
        clientName: counterparties.name,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        total: invoices.total,
      })
      .from(invoices)
      .innerJoin(counterparties, eq(invoices.clientId, counterparties.id))
      .where(
        and(
          lte(invoices.issueDate, asOf),
          or(
            eq(invoices.status, "issued"),
            and(eq(invoices.status, "void"), sql`${invoices.voidedOn} > ${asOf}`)
          )
        )
      );
    const paid = await this.db
      .select({
        invoiceId: invoicePayments.invoiceId,
        amount: sql<string>`coalesce(sum(${invoicePayments.amount}), 0)`,
      })
      .from(invoicePayments)
      .where(
        and(
          lte(invoicePayments.date, asOf),
          or(isNull(invoicePayments.reversedOn), sql`${invoicePayments.reversedOn} > ${asOf}`)
        )
      )
      .groupBy(invoicePayments.invoiceId);
    const paidBy = new Map(paid.map((p) => [p.invoiceId, d(p.amount)]));
    return rows
      .map((r) => ({
        id: r.id,
        number: r.number,
        clientId: r.clientId,
        clientName: r.clientName,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        balance: d(r.total).minus(paidBy.get(r.id) ?? 0),
        daysOverdue: Math.max(0, dayjs(asOf).diff(dayjs(r.dueDate), "day")),
      }))
      .filter((r) => r.balance.greaterThan(0));
  }

  private async receivableInBooks(asOf: string): Promise<Decimal> {
    const receivable = await this.conta.accountIdFor("receivable");
    const [row] = await this.db
      .select({ balance: sql<string>`coalesce(sum(${ledgerEntries.debit} - ${ledgerEntries.credit}), 0)` })
      .from(ledgerEntries)
      .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
      .where(
        and(
          eq(ledgerEntries.accountId, receivable),
          inArray(journals.status, IN_THE_BOOKS),
          lte(journals.date, asOf)
        )
      );
    return d(row?.balance ?? 0);
  }

  /**
   * What needs someone now, in one call: invoices overdue (the oldest first, at most 20 listed),
   * those overdue more than `severeDays`, drafts, recurring fees due, clients whose funds are below
   * their minimum, statement lines not reconciled, and the closed date. With `responsibleResourceId`,
   * invoices, recurring fees and clients are those of the projects that resource runs; statement lines
   * and the closed date are the whole book's. Balances are today's, as in list-invoices.
   */
  async attention(options: { asOf?: string; responsibleResourceId?: string; severeDays?: number } = {}) {
    const asOf = asOfDate(options.asOf);
    const severeDays = Math.min(Math.max(Math.trunc(options.severeDays ?? 45), 1), 3650);
    const responsible = options.responsibleResourceId;
    const ofResource = responsible ? eq(projects.responsibleResourceId, responsible) : undefined;

    const balance = sql`${invoices.total} - ${invoices.amountPaid}`;
    const days = sql`(${asOf}::date - ${invoices.dueDate}::date)`;
    const overdue = sql`${invoices.status} = 'issued' AND ${invoices.total} > ${invoices.amountPaid} AND ${invoices.dueDate} < ${asOf}`;
    const severe = sql`${overdue} AND ${days} > ${severeDays}`;
    const draft = sql`${invoices.status} = 'draft'`;

    const [sums] = await this.db
      .select({
        overdueCount: sql<number>`(count(*) FILTER (WHERE ${overdue}))::int`,
        overdueAmount: sql<string>`coalesce(sum(${balance}) FILTER (WHERE ${overdue}), 0)`,
        severeCount: sql<number>`(count(*) FILTER (WHERE ${severe}))::int`,
        severeAmount: sql<string>`coalesce(sum(${balance}) FILTER (WHERE ${severe}), 0)`,
        draftCount: sql<number>`(count(*) FILTER (WHERE ${draft}))::int`,
        draftTotal: sql<string>`coalesce(sum(${invoices.total}) FILTER (WHERE ${draft}), 0)`,
      })
      .from(invoices)
      .leftJoin(projects, eq(invoices.projectId, projects.id))
      .where(ofResource);

    const items = await this.db
      .select({
        invoiceId: invoices.id,
        number: invoices.number,
        clientName: counterparties.name,
        balance: sql<string>`${balance}`,
        daysOverdue: sql<number>`${days}::int`,
      })
      .from(invoices)
      .innerJoin(counterparties, eq(invoices.clientId, counterparties.id))
      .leftJoin(projects, eq(invoices.projectId, projects.id))
      .where(and(overdue, ofResource))
      .orderBy(asc(invoices.dueDate), desc(balance), asc(invoices.id))
      .limit(20);

    const [recurring] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        amount: sql<string>`coalesce(sum(${recurringFees.amount}), 0)`,
      })
      .from(recurringFees)
      .leftJoin(projects, eq(recurringFees.projectId, projects.id))
      .where(and(eq(recurringFees.isActive, true), lte(recurringFees.nextDate, asOf), ofResource));

    // What each client holds on `asOf`, read from the ledger as everywhere else: no second copy.
    // A joined subquery, not a correlated one: drizzle leaves a one-table select list unqualified.
    const held = this.db
      .select({
        clientId: sql<string>`${journals.counterpartyId}`.as("held_client_id"),
        balance: sql<string>`sum(${ledgerEntries.credit} - ${ledgerEntries.debit})`.as("held_balance"),
      })
      .from(ledgerEntries)
      .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
      .innerJoin(accounts, eq(ledgerEntries.accountId, accounts.id))
      .where(
        and(
          eq(accounts.isClientFundsAccount, true),
          eq(accounts.type, "liability"),
          inArray(journals.status, IN_THE_BOOKS),
          lte(journals.date, asOf)
        )
      )
      .groupBy(journals.counterpartyId)
      .as("held");
    const balanceHeld = sql<string>`coalesce(${held.balance}, 0)`;
    const funds = await this.db
      .select({ clientId: counterparties.id, name: counterparties.name, balance: balanceHeld, minimum: counterparties.fundsMinimum })
      .from(counterparties)
      .leftJoin(held, eq(held.clientId, counterparties.id))
      .where(
        and(
          sql`${counterparties.fundsMinimum} > 0`,
          sql`${balanceHeld} < ${counterparties.fundsMinimum}`,
          responsible
            ? sql`EXISTS (SELECT 1 FROM ${projects} WHERE ${projects.clientId} = ${counterparties.id} AND ${projects.responsibleResourceId} = ${responsible})`
            : undefined
        )
      )
      .orderBy(asc(counterparties.name));

    const [pending] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(bankLines)
      .where(and(isNull(bankLines.reconciledAt), lte(bankLines.date, asOf)));
    const { lockedUntil } = await this.conta.getSettings();

    return {
      asOf,
      severeDays,
      overdue: {
        count: Number(sums?.overdueCount ?? 0),
        amount: toDb(d(sums?.overdueAmount ?? 0)),
        items: items.map((i) => ({ ...i, balance: toDb(d(i.balance)), daysOverdue: Number(i.daysOverdue) })),
      },
      severe: { count: Number(sums?.severeCount ?? 0), amount: toDb(d(sums?.severeAmount ?? 0)) },
      drafts: { count: Number(sums?.draftCount ?? 0), total: toDb(d(sums?.draftTotal ?? 0)) },
      recurringDue: { count: Number(recurring?.count ?? 0), amount: toDb(d(recurring?.amount ?? 0)) },
      fundsBelowMinimum: funds.map((f) => ({
        clientId: f.clientId,
        name: f.name,
        balance: toDb(d(f.balance)),
        minimum: toDb(d(f.minimum)),
      })),
      bankLinesPending: { count: Number(pending?.count ?? 0) },
      closedUntil: lockedUntil,
    };
  }

  /** Amounts by age. `ledgerDifference` is the receivable account less the invoices: normally 0. */
  async aging(asOfValue?: string) {
    const asOf = asOfDate(asOfValue);
    const open = await this.openBalances(asOf);
    const buckets = AGING_BUCKETS.map((key) => {
      const inBucket = open.filter((i) => bucketOf(i.daysOverdue) === key);
      return {
        key,
        amount: toDb(inBucket.reduce((s, i) => s.plus(i.balance), new Decimal(0))),
        count: inBucket.length,
      };
    });
    const total = open.reduce((s, i) => s.plus(i.balance), new Decimal(0));
    const ledger = await this.receivableInBooks(asOf);
    return {
      asOf,
      buckets,
      total: toDb(total),
      overdue: toDb(open.filter((i) => i.daysOverdue > 0).reduce((s, i) => s.plus(i.balance), new Decimal(0))),
      ledgerBalance: toDb(ledger),
      ledgerDifference: toDb(ledger.minus(total)),
    };
  }

  async agingByClient(asOfValue?: string) {
    const asOf = asOfDate(asOfValue);
    const open = await this.openBalances(asOf);
    const rows = new Map<string, { clientId: string; clientName: string; buckets: Record<AgingBucket, Decimal>; total: Decimal; invoices: Array<{ id: string; number: string | null; dueDate: string; balance: string; daysOverdue: number }> }>();
    for (const invoice of open) {
      let row = rows.get(invoice.clientId);
      if (!row) {
        row = {
          clientId: invoice.clientId,
          clientName: invoice.clientName,
          buckets: Object.fromEntries(AGING_BUCKETS.map((k) => [k, new Decimal(0)])) as Record<AgingBucket, Decimal>,
          total: new Decimal(0),
          invoices: [],
        };
        rows.set(invoice.clientId, row);
      }
      const bucket = bucketOf(invoice.daysOverdue);
      row.buckets[bucket] = row.buckets[bucket].plus(invoice.balance);
      row.total = row.total.plus(invoice.balance);
      row.invoices.push({
        id: invoice.id,
        number: invoice.number,
        dueDate: invoice.dueDate,
        balance: toDb(invoice.balance),
        daysOverdue: invoice.daysOverdue,
      });
    }
    return [...rows.values()]
      .sort((a, b) => b.total.comparedTo(a.total))
      .map((r) => ({
        ...r,
        total: toDb(r.total),
        buckets: Object.fromEntries(AGING_BUCKETS.map((k) => [k, toDb(r.buckets[k])])),
      }));
  }

  /**
   * Work and expenses no invoice has claimed, by project and by resource. Filtering by resource
   * leaves expenses out, because expenses have no resource.
   */
  async wip(filter: { resourceId?: string; projectId?: string; asOf?: string } = {}) {
    const asOf = asOfDate(filter.asOf);
    const agedBefore = dayjs(asOf).subtract(30, "day").format("YYYY-MM-DD");
    const dp = sql.raw(String(await this.decimals()));
    const value = sql`round(${workEntries.quantity} * ${workEntries.billingRate}, ${dp})`;

    const conditions: SQL[] = [isNull(workEntries.invoiceId), lte(workEntries.date, asOf)];
    if (filter.resourceId) conditions.push(eq(workEntries.resourceId, filter.resourceId));
    if (filter.projectId) conditions.push(eq(workEntries.projectId, filter.projectId));
    const work = await this.db
      .select({
        projectId: workEntries.projectId,
        value: sql<string>`coalesce(sum(${value}), 0)`,
        aged: sql<string>`coalesce(sum(${value}) FILTER (WHERE ${workEntries.date} < ${agedBefore}), 0)`,
        oldest: sql<string>`min(${workEntries.date})`,
        entries: count(),
      })
      .from(workEntries)
      .where(and(...conditions))
      .groupBy(workEntries.projectId);
    // Quantities only add up within one unit: hours and days stay apart.
    const perUnit = await this.db
      .select({
        projectId: workEntries.projectId,
        unit: workEntries.unit,
        quantity: sql<string>`coalesce(sum(${workEntries.quantity}), 0)`,
      })
      .from(workEntries)
      .where(and(...conditions))
      .groupBy(workEntries.projectId, workEntries.unit);

    const expenseConditions: SQL[] = [
      isNull(disbursements.invoiceId),
      eq(disbursements.status, "pending"),
      lte(disbursements.date, asOf),
    ];
    if (filter.projectId) expenseConditions.push(eq(disbursements.projectId, filter.projectId));
    const expenses = filter.resourceId
      ? []
      : await this.db
          .select({
            projectId: disbursements.projectId,
            value: sql<string>`coalesce(sum(${disbursements.amount}), 0)`,
            oldest: sql<string>`min(${disbursements.date})`,
            entries: count(),
          })
          .from(disbursements)
          .where(and(...expenseConditions))
          .groupBy(disbursements.projectId);

    const byResource = await this.db
      .select({
        resourceId: workEntries.resourceId,
        name: resources.name,
        unit: workEntries.unit,
        quantity: sql<string>`coalesce(sum(${workEntries.quantity}), 0)`,
        value: sql<string>`coalesce(sum(${value}), 0)`,
      })
      .from(workEntries)
      .innerJoin(resources, eq(workEntries.resourceId, resources.id))
      .where(and(...conditions))
      .groupBy(workEntries.resourceId, resources.name, workEntries.unit);

    const ids = [...new Set([...work.map((t) => t.projectId), ...expenses.map((e) => e.projectId)])];
    const names = ids.length
      ? await this.db
          .select({
            id: projects.id,
            projectNumber: projects.number,
            name: projects.name,
            clientId: projects.clientId,
            clientName: counterparties.name,
          })
          .from(projects)
          .innerJoin(counterparties, eq(projects.clientId, counterparties.id))
          .where(inArray(projects.id, ids))
      : [];

    const quantities = (rows: typeof perUnit) => {
      const out: Record<string, Decimal> = {};
      for (const r of rows) out[r.unit] = (out[r.unit] ?? new Decimal(0)).plus(r.quantity);
      return out;
    };
    const asText = (q: Record<string, Decimal>) =>
      Object.fromEntries(Object.entries(q).map(([unit, n]) => [unit, toDb(n)]));

    const groups = names
      .map((project) => {
        const t = work.find((x) => x.projectId === project.id);
        const e = expenses.find((x) => x.projectId === project.id);
        const dates = [t?.oldest, e?.oldest].filter((x): x is string => Boolean(x)).sort();
        return {
          ...project,
          quantities: asText(quantities(perUnit.filter((u) => u.projectId === project.id))),
          workValue: toDb(d(t?.value ?? 0)),
          expenseValue: toDb(d(e?.value ?? 0)),
          value: toDb(d(t?.value ?? 0).plus(e?.value ?? 0)),
          agedValue: toDb(d(t?.aged ?? 0)),
          oldestDays: dates[0] ? dayjs(asOf).diff(dayjs(dates[0]), "day") : 0,
          workEntries: Number(t?.entries ?? 0),
          expenses: Number(e?.entries ?? 0),
        };
      })
      .sort((a, b) => d(b.value).comparedTo(d(a.value)));

    return {
      asOf,
      groups,
      byResource: byResource.map((r) => ({
        ...r,
        quantity: toDb(d(r.quantity)),
        value: toDb(d(r.value)),
      })),
      totals: {
        quantities: asText(quantities(perUnit)),
        value: toDb(groups.reduce((s, g) => s.plus(g.value), new Decimal(0))),
        agedValue: toDb(groups.reduce((s, g) => s.plus(g.agedValue), new Decimal(0))),
      },
    };
  }

  /** Average days from issue to the last payment, over the invoices fully paid in the window. */
  async dso(options: { asOf?: string; windowDays?: number } = {}) {
    const asOf = asOfDate(options.asOf);
    const windowDays = Math.min(Math.max(options.windowDays ?? 90, 1), 3660);
    const from = dayjs(asOf).subtract(windowDays, "day").format("YYYY-MM-DD");
    const rows = await this.db
      .select({
        issueDate: invoices.issueDate,
        lastPayment: sql<string>`max(${invoicePayments.date})`,
      })
      .from(invoices)
      .innerJoin(invoicePayments, eq(invoicePayments.invoiceId, invoices.id))
      .where(
        and(
          eq(invoices.status, "issued"),
          sql`${invoices.total} <= ${invoices.amountPaid}`,
          isNull(invoicePayments.reversedOn)
        )
      )
      .groupBy(invoices.id, invoices.issueDate);
    const inWindow = rows.filter((r) => r.lastPayment >= from && r.lastPayment <= asOf);
    const days = inWindow.reduce((s, r) => s + dayjs(r.lastPayment).diff(dayjs(r.issueDate), "day"), 0);
    return {
      asOf,
      windowDays,
      invoices: inWindow.length,
      days: inWindow.length ? Math.round(days / inWindow.length) : 0,
    };
  }

  /** Per month: fees billed net of discount, money collected, expenses in the ledger. */
  async monthlySeries(options: { months?: number; asOf?: string } = {}) {
    const asOf = asOfDate(options.asOf);
    const months = Math.min(Math.max(options.months ?? 6, 1), 60);
    const keys = Array.from({ length: months }, (_, i) =>
      dayjs(asOf).startOf("month").subtract(months - 1 - i, "month").format("YYYY-MM")
    );
    const from = `${keys[0]}-01`;
    const until = dayjs(asOf).endOf("month").format("YYYY-MM-DD");

    const billedMonth = sql<string>`substr(${invoices.issueDate}, 1, 7)`;
    const billed = await this.db
      .select({ key: billedMonth, amount: sql<string>`coalesce(sum(${invoices.feesNet}), 0)` })
      .from(invoices)
      .where(and(eq(invoices.status, "issued"), gte(invoices.issueDate, from), lte(invoices.issueDate, until)))
      .groupBy(billedMonth);

    const paidMonth = sql<string>`substr(${invoicePayments.date}, 1, 7)`;
    const collected = await this.db
      .select({ key: paidMonth, amount: sql<string>`coalesce(sum(${invoicePayments.amount}), 0)` })
      .from(invoicePayments)
      .where(and(isNull(invoicePayments.reversedOn), gte(invoicePayments.date, from), lte(invoicePayments.date, until)))
      .groupBy(paidMonth);

    const journalMonth = sql<string>`substr(${journals.date}, 1, 7)`;
    const expenses = await this.db
      .select({
        key: journalMonth,
        amount: sql<string>`coalesce(sum(${ledgerEntries.debit} - ${ledgerEntries.credit}), 0)`,
      })
      .from(ledgerEntries)
      .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
      .innerJoin(accounts, eq(ledgerEntries.accountId, accounts.id))
      .where(
        and(
          eq(accounts.type, "expense"),
          inArray(journals.status, IN_THE_BOOKS),
          gte(journals.date, from),
          lte(journals.date, until)
        )
      )
      .groupBy(journalMonth);

    const amount = (rows: Array<{ key: string; amount: string }>, key: string) =>
      toDb(d(rows.find((r) => r.key === key)?.amount ?? 0));
    return keys.map((key) => ({
      key,
      billed: amount(billed, key),
      collected: amount(collected, key),
      expenses: amount(expenses, key),
    }));
  }

  /**
   * Work done, billed and unbilled per project, against what it billed and what the work cost.
   * Quantities come per unit. Realization is by value, so hours and days can share one figure.
   */
  async profitabilityByProject(filter: { responsibleResourceId?: string } = {}) {
    const dp = sql.raw(String(await this.decimals()));
    const value = sql`round(${workEntries.quantity} * ${workEntries.billingRate}, ${dp})`;
    const billedFilter = sql`${workEntries.invoiceId} IS NOT NULL`;
    const work = await this.db
      .select({
        projectId: workEntries.projectId,
        workedValue: sql<string>`coalesce(sum(${value}), 0)`,
        billedValue: sql<string>`coalesce(sum(${value}) FILTER (WHERE ${billedFilter}), 0)`,
        cost: sql<string>`coalesce(sum(round(${workEntries.quantity} * ${workEntries.costRate}, ${dp})), 0)`,
      })
      .from(workEntries)
      .groupBy(workEntries.projectId);
    const perUnit = await this.db
      .select({
        projectId: workEntries.projectId,
        unit: workEntries.unit,
        worked: sql<string>`coalesce(sum(${workEntries.quantity}), 0)`,
        billed: sql<string>`coalesce(sum(${workEntries.quantity}) FILTER (WHERE ${billedFilter}), 0)`,
      })
      .from(workEntries)
      .groupBy(workEntries.projectId, workEntries.unit);
    const revenue = await this.db
      .select({ projectId: invoices.projectId, amount: sql<string>`coalesce(sum(${invoices.feesNet}), 0)` })
      .from(invoices)
      .where(and(eq(invoices.status, "issued"), isNotNull(invoices.projectId)))
      .groupBy(invoices.projectId);
    const rows = await this.db
      .select({
        id: projects.id,
        projectNumber: projects.number,
        name: projects.name,
        billingType: projects.billingType,
        category: projects.category,
        responsibleResourceId: projects.responsibleResourceId,
        clientName: counterparties.name,
      })
      .from(projects)
      .innerJoin(counterparties, eq(projects.clientId, counterparties.id))
      .where(
        filter.responsibleResourceId
          ? eq(projects.responsibleResourceId, filter.responsibleResourceId)
          : undefined
      )
      .orderBy(asc(projects.number));

    return rows.map((project) => {
      const t = work.find((x) => x.projectId === project.id);
      const units = perUnit.filter((u) => u.projectId === project.id);
      const worked = d(t?.workedValue ?? 0);
      const billed = d(t?.billedValue ?? 0);
      const income = d(revenue.find((r) => r.projectId === project.id)?.amount ?? 0);
      const cost = d(t?.cost ?? 0);
      const margin = income.minus(cost);
      return {
        ...project,
        quantities: units.map((u) => ({
          unit: u.unit,
          worked: toDb(d(u.worked)),
          billed: toDb(d(u.billed)),
          unbilled: toDb(d(u.worked).minus(u.billed)),
        })),
        workedValue: toDb(worked),
        billedValue: toDb(billed),
        realizationPct: percent(billed, worked),
        wip: toDb(worked.minus(billed)),
        revenue: toDb(income),
        cost: toDb(cost),
        margin: toDb(margin),
        marginPct: percent(margin, income),
      };
    });
  }

  /** The same per resource, in its unit. Revenue is billed work at its rate, and margin charges only billed work. */
  async profitabilityByResource() {
    const dp = sql.raw(String(await this.decimals()));
    const billedFilter = sql`${workEntries.invoiceId} IS NOT NULL`;
    const unbilledFilter = sql`${workEntries.invoiceId} IS NULL`;
    const rows = await this.db
      .select({
        id: resources.id,
        name: resources.name,
        title: resources.title,
        unit: resources.unit,
        billingRate: resources.billingRate,
        costRate: resources.costRate,
        worked: sql<string>`coalesce(sum(${workEntries.quantity}), 0)`,
        billed: sql<string>`coalesce(sum(${workEntries.quantity}) FILTER (WHERE ${billedFilter}), 0)`,
        workedValue: sql<string>`coalesce(sum(round(${workEntries.quantity} * ${workEntries.billingRate}, ${dp})), 0)`,
        billedValue: sql<string>`coalesce(sum(round(${workEntries.quantity} * ${workEntries.billingRate}, ${dp})) FILTER (WHERE ${billedFilter}), 0)`,
        wip: sql<string>`coalesce(sum(round(${workEntries.quantity} * ${workEntries.billingRate}, ${dp})) FILTER (WHERE ${unbilledFilter}), 0)`,
        cost: sql<string>`coalesce(sum(round(${workEntries.quantity} * ${workEntries.costRate}, ${dp})), 0)`,
        billedCost: sql<string>`coalesce(sum(round(${workEntries.quantity} * ${workEntries.costRate}, ${dp})) FILTER (WHERE ${billedFilter}), 0)`,
      })
      .from(resources)
      .leftJoin(workEntries, eq(workEntries.resourceId, resources.id))
      .groupBy(resources.id, resources.name, resources.title, resources.unit, resources.billingRate, resources.costRate)
      .orderBy(asc(resources.name));
    return rows.map((r) => {
      const worked = d(r.worked);
      const billed = d(r.billed);
      const revenue = d(r.billedValue);
      const margin = revenue.minus(r.billedCost);
      return {
        id: r.id,
        name: r.name,
        title: r.title,
        unit: r.unit,
        billingRate: r.billingRate,
        costRate: r.costRate,
        workedQuantity: toDb(worked),
        billedQuantity: toDb(billed),
        unbilledQuantity: toDb(worked.minus(billed)),
        realizationPct: percent(revenue, d(r.workedValue)),
        wip: toDb(d(r.wip)),
        revenue: toDb(revenue),
        cost: toDb(d(r.cost)),
        margin: toDb(margin),
        marginPct: percent(margin, revenue),
      };
    });
  }

  /** Billed, collected and owed per client. */
  async billingByClient() {
    const rows = await this.db
      .select({
        clientId: invoices.clientId,
        clientName: counterparties.name,
        billed: sql<string>`coalesce(sum(${invoices.feesNet}), 0)`,
        collected: sql<string>`coalesce(sum(${invoices.amountPaid}), 0)`,
        balance: sql<string>`coalesce(sum(${invoices.total} - ${invoices.amountPaid}), 0)`,
        invoices: count(),
      })
      .from(invoices)
      .innerJoin(counterparties, eq(invoices.clientId, counterparties.id))
      .where(eq(invoices.status, "issued"))
      .groupBy(invoices.clientId, counterparties.name);
    return rows
      .map((r) => {
        const billed = d(r.billed);
        const collected = d(r.collected);
        return {
          clientId: r.clientId,
          clientName: r.clientName,
          billed: toDb(billed),
          collected: toDb(collected),
          balance: toDb(d(r.balance)),
          invoices: Number(r.invoices),
          collectionPct: Math.min(100, percent(collected, billed) ?? 100),
        };
      })
      .sort((a, b) => d(b.billed).comparedTo(d(a.billed)));
  }

  /** Billed per project category, with each category's share. Invoices with no project count as General. */
  async billingByCategory() {
    const category = sql<string>`coalesce(${projects.category}, 'General')`;
    const rows = await this.db
      .select({
        category,
        billed: sql<string>`coalesce(sum(${invoices.feesNet}), 0)`,
        invoices: count(),
        projects: sql<string>`count(DISTINCT ${invoices.projectId})`,
      })
      .from(invoices)
      .leftJoin(projects, eq(invoices.projectId, projects.id))
      .where(eq(invoices.status, "issued"))
      .groupBy(category);
    const total = rows.reduce((s, r) => s.plus(r.billed), new Decimal(0));
    return rows
      .map((r) => ({
        category: r.category,
        billed: toDb(d(r.billed)),
        invoices: Number(r.invoices),
        projects: Number(r.projects),
        sharePct: percent(d(r.billed), total) ?? 0,
      }))
      .sort((a, b) => d(b.billed).comparedTo(d(a.billed)));
  }

  /**
   * Per resource: the invoices of the projects they run or with a line of theirs, and what those
   * invoices billed, collected and still owe. An invoice with two people counts for both.
   */
  async resourcePerformance() {
    const people = await this.db
      .select({ id: resources.id, name: resources.name, title: resources.title })
      .from(resources)
      .orderBy(asc(resources.name));
    const issued = await this.db
      .select({
        id: invoices.id,
        feesNet: invoices.feesNet,
        amountPaid: invoices.amountPaid,
        total: invoices.total,
        responsible: projects.responsibleResourceId,
      })
      .from(invoices)
      .leftJoin(projects, eq(invoices.projectId, projects.id))
      .where(eq(invoices.status, "issued"));
    const lines = await this.db
      .selectDistinct({ invoiceId: invoiceLines.invoiceId, resourceId: invoiceLines.resourceId })
      .from(invoiceLines)
      .where(isNotNull(invoiceLines.resourceId));
    const projectCounts = await this.db
      .select({ resourceId: projects.responsibleResourceId, n: count() })
      .from(projects)
      .where(isNotNull(projects.responsibleResourceId))
      .groupBy(projects.responsibleResourceId);

    return people.map((person) => {
      const ids = new Set(lines.filter((l) => l.resourceId === person.id).map((l) => l.invoiceId));
      const own = issued.filter((i) => i.responsible === person.id || ids.has(i.id));
      const billed = own.reduce((s, i) => s.plus(i.feesNet), new Decimal(0));
      const collected = own.reduce((s, i) => s.plus(i.amountPaid), new Decimal(0));
      const pending = own.reduce((s, i) => s.plus(i.total).minus(i.amountPaid), new Decimal(0));
      return {
        ...person,
        projects: Number(projectCounts.find((m) => m.resourceId === person.id)?.n ?? 0),
        invoices: own.length,
        billed: toDb(billed),
        collected: toDb(collected),
        pending: toDb(pending),
        collectionPct: Math.min(100, percent(collected, billed) ?? 100),
      };
    });
  }
}
