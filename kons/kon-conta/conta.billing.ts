/**
 * BillingService — the documents of a business that bills clients, on top of the ledger
 * ============================================================================
 *
 * Invoices, payments, work, recurring fees, success fees, client funds, bank reconciliation
 * and period close. The rule that holds all of it together: money moves only through
 * `ContaService.createJournal`, the one posting path, which refuses unbalanced entries, closed
 * periods and client funds overdrafts. These tables keep the documents and point at their journals.
 *
 * Every operation that writes more than one row runs in `atomic`, because the host commits a 4xx:
 * a refusal halfway through must not leave the first half behind.
 */

import dayjs from "dayjs";
import { Decimal } from "decimal.js";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import {
  accounts,
  auditLog,
  bankLines,
  contaSettings,
  successFees,
  counterparties,
  currencies,
  disbursements,
  invoiceLines,
  invoicePayments,
  invoiceReminders,
  invoices,
  journals,
  ledgerEntries,
  projects,
  numberSequences,
  recurringFees,
  workEntries,
  resources,
  type AccountRole,
  type BankLine,
  type BillingType,
  type SuccessFee,
  type ContaSettings,
  type Counterparty,
  type Invoice,
  type InvoiceLine,
  type Issuer,
  type Journal,
  type Labels,
  type LedgerEntry,
  type Project,
  type RecurringFee,
  type RecurringFrequency,
  type Target,
  type WorkEntry,
  type Resource,
} from "./conta.schema";
import { AccountingError, ContaService, IN_THE_BOOKS, d, isRealDate, toDb } from "./conta.service";
import type { ContaDb } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Small helpers
// ═══════════════════════════════════════════════════════════════════════════

export const today = (): string => dayjs().format("YYYY-MM-DD");
export const addDays = (date: string, days: number): string =>
  dayjs(date).add(days, "day").format("YYYY-MM-DD");

function requireDate(date: string): string {
  if (!isRealDate(date)) throw new AccountingError(`Invalid date: ${date}`);
  return date;
}

function roundTo(value: Decimal, decimals: number): Decimal {
  return value.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
}

function requirePositive(value: string | number | Decimal, what: string): Decimal {
  const amount = d(value);
  if (!amount.greaterThan(0)) throw new AccountingError(`${what} must be greater than zero`);
  return amount;
}

const RECONCILED_BY = sql`NULLIF(current_setting('app.current_user_id', true), '')`;

// ═══════════════════════════════════════════════════════════════════════════
// Pure rules (exported so a front end and the tests read the same ones)
// ═══════════════════════════════════════════════════════════════════════════

export interface InvoiceTotals {
  fees: Decimal;
  expenses: Decimal;
  feesNet: Decimal;
  tax: Decimal;
  total: Decimal;
}

/** Tax applies to fees net of the discount. Expenses are passed on to the client at cost. */
export function computeInvoiceTotals(
  lines: Array<{ kind: "fee" | "expense"; amount: string | Decimal }>,
  discountValue: string | Decimal,
  taxRate: string | Decimal,
  decimals: number
): InvoiceTotals {
  const sum = (kind: "fee" | "expense") =>
    lines.filter((l) => l.kind === kind).reduce((s, l) => s.plus(d(l.amount)), new Decimal(0));
  const fees = sum("fee");
  const expenses = sum("expense");
  const discount = roundTo(d(discountValue), decimals);
  const feesNet = fees.minus(discount);
  if (feesNet.isNegative()) throw new AccountingError("The discount is larger than the fees");
  const tax = roundTo(feesNet.times(d(taxRate)), decimals);
  return { fees, expenses, feesNet, tax, total: feesNet.plus(tax).plus(expenses) };
}

export type InvoiceDisplayStatus = "void" | "draft" | "paid" | "overdue" | "partial" | "pending";

export function invoiceDisplayStatus(
  invoice: Pick<Invoice, "status" | "total" | "amountPaid" | "dueDate">,
  asOf: string = today()
): InvoiceDisplayStatus {
  if (invoice.status === "void") return "void";
  if (invoice.status === "draft") return "draft";
  if (!d(invoice.total).minus(invoice.amountPaid).greaterThan(0)) return "paid";
  if (asOf > invoice.dueDate) return "overdue";
  return d(invoice.amountPaid).greaterThan(0) ? "partial" : "pending";
}

export const invoiceBalance = (invoice: Pick<Invoice, "status" | "total" | "amountPaid">): Decimal =>
  invoice.status === "void" ? new Decimal(0) : d(invoice.total).minus(invoice.amountPaid);

/** `invoiceDisplayStatus` in SQL, so a filter, a count and a row read the same rule. */
export function displayStatusSql(asOf: string) {
  return sql<InvoiceDisplayStatus>`CASE
    WHEN ${invoices.status} = 'void' THEN 'void'
    WHEN ${invoices.status} = 'draft' THEN 'draft'
    WHEN ${invoices.total} - ${invoices.amountPaid} <= 0 THEN 'paid'
    WHEN ${invoices.dueDate} < ${asOf} THEN 'overdue'
    WHEN ${invoices.amountPaid} > 0 THEN 'partial'
    ELSE 'pending' END`;
}

/** `invoiceBalance` in SQL. */
export function invoiceBalanceSql() {
  return sql<string>`CASE WHEN ${invoices.status} = 'void' THEN 0 ELSE ${invoices.total} - ${invoices.amountPaid} END`;
}

/** What a list of invoices can be sorted by. */
export const INVOICE_SORTS = ["issueDate", "dueDate", "daysOverdue", "balance", "total"] as const;
export type InvoiceSort = (typeof INVOICE_SORTS)[number];

function daysOverdue(dueDate: string, asOf: string): number {
  return Math.max(0, dayjs(asOf).diff(dayjs(dueDate), "day"));
}

/** An invoice as the API returns it: the stored row plus what is derived from it. */
function presentInvoice<T extends Invoice>(invoice: T, asOf: string = today()) {
  const status = invoiceDisplayStatus(invoice, asOf);
  return {
    ...invoice,
    balance: toDb(invoiceBalance(invoice)),
    displayStatus: status,
    daysOverdue: status === "overdue" ? daysOverdue(invoice.dueDate, asOf) : 0,
  };
}

export interface BankMatchSuggestion {
  kind: "invoice" | "fee";
  confidence: "high" | "medium";
  label: string;
  invoiceId?: string;
  partial?: boolean;
}

/**
 * What a statement line probably is. A charge is recognised by the keywords in the settings, money
 * in by an open invoice with the same balance, by the client's name, or by both.
 */
export function suggestBankMatch(
  line: Pick<BankLine, "amount" | "description">,
  open: Array<{ id: string; number: string | null; clientName: string; balance: Decimal }>,
  feeKeywords: string[]
): BankMatchSuggestion | null {
  const amount = d(line.amount);
  const text = line.description.toUpperCase();
  if (amount.isNegative()) {
    return feeKeywords.some((k) => k && text.includes(k.toUpperCase()))
      ? { kind: "fee", confidence: "high", label: "Bank charge" }
      : null;
  }
  const tokens = text.match(/\p{L}{4,}/gu) ?? [];
  const named = (clientName: string) => tokens.some((t) => clientName.toUpperCase().includes(t));
  const same = open.filter((i) => i.balance.equals(amount));
  const exact = same.find((i) => named(i.clientName)) ?? same[0];
  if (exact) {
    return {
      kind: "invoice",
      invoiceId: exact.id,
      confidence: named(exact.clientName) ? "high" : "medium",
      label: `${exact.number} · ${exact.clientName}`,
      partial: false,
    };
  }
  const partial = open.find((i) => named(i.clientName) && i.balance.greaterThan(amount));
  if (partial) {
    return {
      kind: "invoice",
      invoiceId: partial.id,
      confidence: "medium",
      label: `${partial.number} · ${partial.clientName} (partial)`,
      partial: true,
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Inputs
// ═══════════════════════════════════════════════════════════════════════════

export interface InvoiceLineInput {
  kind?: "fee" | "expense";
  description: string;
  quantity?: string;
  unitPrice: string;
  resourceId?: string;
  date?: string;
}

export interface InvoiceInput {
  clientId: string;
  projectId?: string;
  concept?: string;
  feeType?: BillingType;
  revenueAccountId?: string;
  issueDate?: string;
  termsDays?: number;
  taxRate?: string;
  discount?: string;
  lines?: InvoiceLineInput[];
  workEntryIds?: string[];
  disbursementIds?: string[];
  /** Issue it now instead of leaving a draft. */
  issue?: boolean;
  /** The account that paid the expense lines not recorded yet. The operating bank by default. */
  paidFromAccountId?: string;
  source?: string;
  externalRef?: string;
}

export interface WorkEntryInput {
  projectId?: string;
  /** Instead of `projectId`: the project's id in another system, such as a CRM deal id. */
  projectExternalRef?: string;
  resourceId?: string;
  resourceUserId?: string;
  resourceExternalRef?: string;
  date?: string;
  description: string;
  /** How much, in the resource's unit: hours for a person billed by the hour. */
  quantity: string | number;
  /** Must be the resource's unit when given: the rate is per that unit. */
  unit?: string;
  /** Overrides the resource's rate for this entry. */
  billingRate?: string;
  /** Id of the source record elsewhere: recording it twice returns the same entry. */
  externalRef?: string;
  /** Only for a caller running as the system: whose action this is. */
  createdBy?: string | null;
}

export interface ExpenseInput {
  projectId?: string;
  projectExternalRef?: string;
  description: string;
  amount: string | number;
  date?: string;
  category?: string;
  /** An account id, or `client_funds` to pay from the client's funds. The operating bank by default. */
  paidFrom?: string;
  externalRef?: string;
  createdBy?: string | null;
}

export interface ClientFundsInput {
  clientId: string;
  projectId?: string;
  amount: string | number;
  date?: string;
  description?: string;
  reference?: string;
  payee?: string;
  createdBy?: string | null;
}

export type BankMatch =
  | { kind: "invoice"; invoiceId: string }
  | { kind: "fee" }
  | { kind: "client_funds"; clientId: string; projectId?: string }
  | { kind: "journal"; journalId: string };

export interface ListPage {
  limit?: number;
  page?: number;
}

function paging(page: ListPage, fallback = 50) {
  const limit = Math.min(Math.max(page.limit ?? fallback, 1), 500);
  const current = Math.max(page.page ?? 1, 1);
  return { limit, page: current, offset: (current - 1) * limit };
}

/** Months in one period of each frequency: what moves the next date on and turns an amount into a monthly figure. */
const RECURRING_MONTHS: Record<RecurringFrequency, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

// ═══════════════════════════════════════════════════════════════════════════
// BillingService
// ═══════════════════════════════════════════════════════════════════════════

export class BillingService {
  private conta: ContaService;

  constructor(private db: ContaDb) {
    this.conta = new ContaService(db);
  }

  private atomic<T>(fn: (service: BillingService) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new BillingService(tx as unknown as ContaDb)));
  }

  private account(role: AccountRole): Promise<string> {
    return this.conta.accountIdFor(role);
  }

  /** Decimal places of the base currency: what invoices round to. */
  private async decimals(settings: ContaSettings): Promise<number> {
    const [row] = await this.db
      .select({ decimalPlaces: currencies.decimalPlaces })
      .from(currencies)
      .where(eq(currencies.code, settings.baseCurrency))
      .limit(1);
    return row?.decimalPlaces ?? 2;
  }

  // ── Lookups ─────────────────────────────────────────────────────────────

  private async requireClient(id: string): Promise<Counterparty> {
    const [row] = await this.db.select().from(counterparties).where(eq(counterparties.id, id)).limit(1);
    if (!row) throw new AccountingError("Client not found", 404);
    return row;
  }

  private async requireProject(ref: { projectId?: string; projectExternalRef?: string }): Promise<Project> {
    const where = ref.projectId
      ? eq(projects.id, ref.projectId)
      : ref.projectExternalRef
        ? eq(projects.externalRef, ref.projectExternalRef)
        : undefined;
    if (!where) throw new AccountingError("A project is required (projectId or projectExternalRef)");
    const [row] = await this.db.select().from(projects).where(where).limit(1);
    if (!row) throw new AccountingError("Project not found", 404);
    return row;
  }

  private async requireResource(ref: {
    resourceId?: string;
    resourceUserId?: string;
    resourceExternalRef?: string;
  }): Promise<Resource> {
    const where = ref.resourceId
      ? eq(resources.id, ref.resourceId)
      : ref.resourceUserId
        ? eq(resources.userId, ref.resourceUserId)
        : ref.resourceExternalRef
          ? eq(resources.externalRef, ref.resourceExternalRef)
          : undefined;
    if (!where) throw new AccountingError("A resource is required");
    const [row] = await this.db.select().from(resources).where(where).limit(1);
    if (!row) throw new AccountingError("Resource not found", 404);
    return row;
  }

  private async requireProjectOfClient(projectId: string | undefined | null, clientId: string) {
    if (!projectId) return null;
    const project = await this.requireProject({ projectId });
    if (project.clientId !== clientId) throw new AccountingError("The project belongs to another client", 409);
    return project;
  }

  private async requireInvoice(id: string): Promise<Invoice> {
    const [row] = await this.db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!row) throw new AccountingError("Invoice not found", 404);
    return row;
  }

  /** Where client payments may land: the business's own asset accounts, never a client funds account. */
  private async requireOperatingAccount(id: string) {
    const [row] = await this.db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    if (!row) throw new AccountingError("Account not found", 404);
    if (row.type !== "asset") throw new AccountingError("The account must be an asset account");
    if (row.isClientFundsAccount) throw new AccountingError("Client funds accounts cannot take the business's own money", 409);
    return row;
  }

  private async nextNumber(kind: string, prefix: string, date: string, padding: number): Promise<string> {
    const year = date.slice(0, 4);
    const [row] = await this.db
      .insert(numberSequences)
      .values({ key: `${kind}:${year}`, nextValue: 1 })
      .onConflictDoUpdate({
        target: numberSequences.key,
        set: { nextValue: sql`${numberSequences.nextValue} + 1` },
      })
      .returning();
    return `${prefix}-${year}-${String(row.nextValue).padStart(padding, "0")}`;
  }

  // ── Settings and periods ────────────────────────────────────────────────

  getSettings() {
    return this.conta.getSettings();
  }

  async updateSettings(patch: {
    baseCurrency?: string;
    defaultTaxRate?: string;
    taxRates?: string[];
    defaultPaymentTermsDays?: number;
    invoicePrefix?: string;
    creditNotePrefix?: string;
    numberPadding?: number;
    accountCodes?: Partial<Record<AccountRole, string>>;
    bankFeeKeywords?: string[];
    labels?: Partial<Labels>;
    billingTypes?: BillingType[];
    issuer?: Issuer;
    targets?: Target[];
  }) {
    return this.atomic(async (service) => {
      const current = await service.getSettings();
      if (patch.baseCurrency) {
        const [known] = await service.db
          .select({ code: currencies.code })
          .from(currencies)
          .where(eq(currencies.code, patch.baseCurrency))
          .limit(1);
        if (!known) throw new AccountingError(`Unknown currency: ${patch.baseCurrency}`);
      }
      for (const code of Object.values(patch.accountCodes ?? {})) {
        if (code) await service.conta.resolveAccountCode(code);
      }
      const [row] = await service.db
        .update(contaSettings)
        .set({
          ...patch,
          // Labels and account codes merge: changing one name keeps the others.
          ...(patch.labels ? { labels: { ...current.labels, ...patch.labels } } : {}),
          ...(patch.accountCodes ? { accountCodes: { ...current.accountCodes, ...patch.accountCodes } } : {}),
          ...(patch.billingTypes ? { billingTypes: [...new Set(patch.billingTypes)] } : {}),
          // The issuer merges too; an empty string clears one field.
          ...(patch.issuer ? { issuer: { ...current.issuer, ...patch.issuer } } : {}),
          updatedAt: new Date(),
        })
        .returning();
      if (!row) throw new AccountingError("Accounting settings are missing: run the kon's migrations");
      await service.conta.recordAudit({
        action: "settings.updated",
        entityType: "settings",
        entityId: row.id,
        summary: `Settings changed: ${Object.keys(patch).join(", ")}`,
        detail: { ...patch },
      });
      return service.getSettings();
    });
  }

  /** What should be true before closing: a warning list, the decision stays with the accountant. */
  async closeChecklist(until: string = today()) {
    requireDate(until);
    const [pending] = await this.db
      .select({ n: count() })
      .from(bankLines)
      .where(and(isNull(bankLines.reconciledAt), lte(bankLines.date, until)));
    const [drafts] = await this.db.select({ n: count() }).from(invoices).where(eq(invoices.status, "draft"));
    const [books] = await this.db
      .select({
        debit: sql<string>`coalesce(sum(${ledgerEntries.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${ledgerEntries.credit}), 0)`,
      })
      .from(ledgerEntries)
      .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
      .where(and(inArray(journals.status, IN_THE_BOOKS), lte(journals.date, until)));
    const funds = await this.clientFundsReconciliation(until);
    const trialBalanced = d(books?.debit ?? 0).equals(books?.credit ?? 0);
    const items = [
      { key: "bank", ok: Number(pending?.n ?? 0) === 0, pending: Number(pending?.n ?? 0) },
      { key: "client_funds", ok: funds.balanced, pending: 0 },
      { key: "drafts", ok: Number(drafts?.n ?? 0) === 0, pending: Number(drafts?.n ?? 0) },
      { key: "trialBalance", ok: trialBalanced, pending: 0 },
    ];
    return { until, ready: items.every((i) => i.ok), items };
  }

  async getPeriodStatus(until?: string) {
    const settings = await this.getSettings();
    return { lockedUntil: settings.lockedUntil, checklist: await this.closeChecklist(until) };
  }

  /** Nothing posts on or before `until` from now on. It only moves forward: see `reopenPeriod`. */
  async closePeriod(until: string) {
    requireDate(until);
    if (until > today()) throw new AccountingError("A period cannot be closed before it ends");
    return this.atomic(async (service) => {
      const settings = await service.getSettings();
      if (settings.lockedUntil && until <= settings.lockedUntil) {
        throw new AccountingError(`The books are already closed up to ${settings.lockedUntil}`, 409);
      }
      const checklist = await service.closeChecklist(until);
      await service.db.update(contaSettings).set({ lockedUntil: until, updatedAt: new Date() });
      await service.conta.recordAudit({
        action: "period.closed",
        entityType: "period",
        entityId: until,
        summary: `Period closed up to ${until}`,
        detail: { checklist },
      });
      return { lockedUntil: until, checklist };
    });
  }

  /** Lifts the lock, entirely or back to an earlier date. */
  async reopenPeriod(until?: string | null) {
    if (until) requireDate(until);
    return this.atomic(async (service) => {
      const settings = await service.getSettings();
      if (!settings.lockedUntil) throw new AccountingError("No period is closed", 409);
      if (until && until >= settings.lockedUntil) {
        throw new AccountingError(`The books are closed up to ${settings.lockedUntil}: reopen to an earlier date`);
      }
      const lockedUntil = until ?? null;
      await service.db.update(contaSettings).set({ lockedUntil, updatedAt: new Date() });
      await service.conta.recordAudit({
        action: "period.reopened",
        entityType: "period",
        entityId: settings.lockedUntil,
        summary: lockedUntil
          ? `Period reopened: closed up to ${lockedUntil} instead of ${settings.lockedUntil}`
          : `Period reopened: the lock up to ${settings.lockedUntil} was lifted`,
        detail: { previous: settings.lockedUntil, lockedUntil },
      });
      return { lockedUntil };
    });
  }

  // ── Resources ─────────────────────────────────────────────────────────

  async listResources(options: { includeInactive?: boolean } = {}) {
    return this.db
      .select()
      .from(resources)
      .where(options.includeInactive ? undefined : eq(resources.isActive, true))
      .orderBy(asc(resources.name));
  }

  async createResource(input: {
    name: string;
    title?: string;
    userId?: string;
    externalRef?: string;
    unit?: string;
    billingRate: string;
    costRate?: string;
  }) {
    const [row] = await this.db
      .insert(resources)
      .values({ ...input, costRate: input.costRate ?? "0" })
      .returning();
    return row;
  }

  async updateResource(
    id: string,
    patch: {
      name?: string;
      title?: string;
      userId?: string;
      externalRef?: string;
      unit?: string;
      billingRate?: string;
      costRate?: string;
      isActive?: boolean;
    }
  ) {
    const [row] = await this.db
      .update(resources)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(resources.id, id))
      .returning();
    if (!row) throw new AccountingError("Resource not found", 404);
    return row;
  }

  // ── Work entries ────────────────────────────────────────────────────────

  /** Work carries no journal: it is worth nothing in the books until an invoice bills it. */
  async recordWorkEntry(input: WorkEntryInput): Promise<{ entry: WorkEntry; created: boolean }> {
    const quantity = requirePositive(input.quantity, "The quantity");
    if (quantity.decimalPlaces() > 4) throw new AccountingError("The quantity takes at most four decimals");
    const date = requireDate(input.date ?? today());

    return this.atomic(async (service) => {
      const project = await service.requireProject(input);
      const resource = await service.requireResource(input);
      if (input.unit && input.unit !== resource.unit) {
        throw new AccountingError(`${resource.name} is billed per ${resource.unit}, not per ${input.unit}`);
      }
      const [entry] = await service.db
        .insert(workEntries)
        .values({
          projectId: project.id,
          resourceId: resource.id,
          date,
          description: input.description,
          quantity: quantity.toFixed(4),
          unit: resource.unit,
          billingRate: input.billingRate ?? resource.billingRate,
          costRate: resource.costRate,
          externalRef: input.externalRef,
          ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        })
        .onConflictDoNothing()
        .returning();

      if (!entry) {
        const [existing] = await service.db
          .select()
          .from(workEntries)
          .where(eq(workEntries.externalRef, input.externalRef ?? ""))
          .limit(1);
        if (!existing) throw new AccountingError("Work entry could not be recorded", 409);
        return { entry: existing, created: false };
      }

      await service.conta.recordAudit({
        action: "work.recorded",
        entityType: "work_entry",
        entityId: entry.id,
        summary: `${entry.quantity} ${entry.unit} · ${resource.name} · ${project.number}`,
        detail: { projectId: project.id, resourceId: resource.id, date },
        actorId: input.createdBy,
      });
      return { entry, created: true };
    });
  }

  async listWorkEntries(
    filter: ListPage & {
      projectId?: string;
      resourceId?: string;
      externalRef?: string;
      unbilled?: boolean;
      dateFrom?: string;
      dateTo?: string;
    } = {}
  ) {
    const { limit, offset } = paging(filter, 100);
    const conditions: SQL[] = [];
    if (filter.projectId) conditions.push(eq(workEntries.projectId, filter.projectId));
    if (filter.resourceId) conditions.push(eq(workEntries.resourceId, filter.resourceId));
    if (filter.externalRef) conditions.push(eq(workEntries.externalRef, filter.externalRef));
    if (filter.unbilled) conditions.push(isNull(workEntries.invoiceId));
    if (filter.dateFrom) conditions.push(gte(workEntries.date, filter.dateFrom));
    if (filter.dateTo) conditions.push(lte(workEntries.date, filter.dateTo));
    const rows = await this.db
      .select({ entry: workEntries, resourceName: resources.name, projectNumber: projects.number })
      .from(workEntries)
      .innerJoin(resources, eq(workEntries.resourceId, resources.id))
      .innerJoin(projects, eq(workEntries.projectId, projects.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(workEntries.date), desc(workEntries.createdAt))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({ ...r.entry, resourceName: r.resourceName, projectNumber: r.projectNumber }));
  }

  private async requireUnbilledEntry(id: string): Promise<WorkEntry> {
    const [row] = await this.db.select().from(workEntries).where(eq(workEntries.id, id)).limit(1);
    if (!row) throw new AccountingError("Work entry not found", 404);
    if (row.invoiceId) throw new AccountingError("The entry is on an invoice: void that invoice first", 409);
    return row;
  }

  async updateWorkEntry(
    id: string,
    patch: { date?: string; description?: string; quantity?: string; billingRate?: string }
  ) {
    await this.requireUnbilledEntry(id);
    if (patch.date) requireDate(patch.date);
    if (patch.quantity) requirePositive(patch.quantity, "The quantity");
    const [row] = await this.db
      .update(workEntries)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(workEntries.id, id), isNull(workEntries.invoiceId)))
      .returning();
    if (!row) throw new AccountingError("The entry is on an invoice: void that invoice first", 409);
    return row;
  }

  async deleteWorkEntry(id: string) {
    await this.requireUnbilledEntry(id);
    return this.atomic(async (service) => {
      const [row] = await service.db
        .delete(workEntries)
        .where(and(eq(workEntries.id, id), isNull(workEntries.invoiceId)))
        .returning();
      if (!row) throw new AccountingError("The entry is on an invoice: void that invoice first", 409);
      await service.conta.recordAudit({
        action: "work.deleted",
        entityType: "work_entry",
        entityId: id,
        summary: `${row.quantity} ${row.unit} deleted`,
        detail: { projectId: row.projectId, resourceId: row.resourceId, date: row.date },
      });
    });
  }

  // ── Expenses ────────────────────────────────────────────────────────────

  /**
   * An expense on a project. Paid by the business it waits to be billed. Paid from the client's
   * funds it is already settled: there is nothing to bill and the overdraft rule applies.
   */
  async recordExpense(input: ExpenseInput) {
    requirePositive(input.amount, "The amount");
    const date = requireDate(input.date ?? today());
    return this.atomic(async (service) => {
      const project = await service.requireProject(input);

      if (input.paidFrom === "client_funds") {
        if (input.externalRef) {
          const [existing] = await service.db
            .select()
            .from(journals)
            .where(sql`${journals.metadata}->>'externalRef' = ${input.externalRef}`)
            .limit(1);
          if (existing) return { kind: "client_funds" as const, journal: existing, created: false };
        }
        const { journal } = await service.clientFundsDisburse({
          clientId: project.clientId,
          projectId: project.id,
          amount: input.amount,
          date,
          description: input.description,
          payee: input.category,
          reference: input.externalRef,
          createdBy: input.createdBy,
        });
        return { kind: "client_funds" as const, journal, created: true };
      }

      if (input.externalRef) {
        const [existing] = await service.db
          .select()
          .from(disbursements)
          .where(eq(disbursements.externalRef, input.externalRef))
          .limit(1);
        if (existing) return { kind: "business" as const, disbursement: existing, created: false };
      }
      const paidFrom = input.paidFrom ?? (await service.account("operatingBank"));
      const { disbursement, journal } = await service.conta.createDisbursement({
        projectId: project.id,
        description: input.description,
        amount: input.amount,
        paidFromAccountId: paidFrom,
        date,
        category: input.category,
        externalRef: input.externalRef,
        createdBy: input.createdBy,
      });
      await service.conta.recordAudit({
        action: "expense.recorded",
        entityType: "disbursement",
        entityId: disbursement.id,
        summary: `${input.description} · ${disbursement.amount} · ${project.number}`,
        detail: { projectId: project.id, journalId: journal.id, category: input.category ?? null },
        actorId: input.createdBy,
      });
      return { kind: "business" as const, disbursement, journal, created: true };
    });
  }

  // ── Invoices: drafts ────────────────────────────────────────────────────

  /** A draft posts nothing, but the work and expenses on it leave work in progress. */
  async createInvoice(input: InvoiceInput) {
    const issueDate = requireDate(input.issueDate ?? today());
    return this.atomic(async (service) => {
      const settings = await service.getSettings();
      const client = await service.requireClient(input.clientId);
      const project = await service.requireProjectOfClient(input.projectId, client.id);
      const feeType = input.feeType ?? project?.billingType ?? "time";
      await service.conta.assertBillingType(feeType);
      const termsDays = input.termsDays ?? client.paymentTermsDays ?? settings.defaultPaymentTermsDays;
      const revenueAccountId = await service.resolveRevenueAccount(input.revenueAccountId, feeType);
      const fromWip = Boolean(input.workEntryIds?.length || input.disbursementIds?.length);

      const [invoice] = await service.db
        .insert(invoices)
        .values({
          clientId: client.id,
          projectId: project?.id,
          concept: input.concept || "Professional services",
          feeType,
          revenueAccountId,
          currency: settings.baseCurrency,
          issueDate,
          dueDate: addDays(issueDate, termsDays),
          termsDays,
          taxRate: input.taxRate ?? settings.defaultTaxRate,
          discount: input.discount ?? "0",
          source: input.source ?? (fromWip ? "wip" : "manual"),
          externalRef: input.externalRef,
        })
        .returning();

      const decimals = await service.decimals(settings);
      const priced = await service.writeLines(invoice, input, decimals);
      await service.conta.recordAudit({
        action: "invoice.drafted",
        entityType: "invoice",
        entityId: invoice.id,
        summary: `Draft · ${client.name} · ${priced.total}`,
        detail: { clientId: client.id, projectId: project?.id ?? null, total: priced.total },
      });

      if (input.issue) {
        return service.issueInvoice(invoice.id, {
          date: issueDate,
          paidFromAccountId: input.paidFromAccountId,
        });
      }
      return service.getInvoice(invoice.id);
    });
  }

  private async resolveRevenueAccount(id: string | undefined, feeType: BillingType): Promise<string> {
    if (id) {
      const [row] = await this.db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
      if (!row) throw new AccountingError("Account not found", 404);
      if (row.type !== "revenue") throw new AccountingError("The revenue account must be of type revenue");
      return row.id;
    }
    if (feeType === "recurring") return this.account("recurringFeeRevenue");
    if (feeType === "success") return this.account("successFeeRevenue");
    return this.account("feeRevenue");
  }

  /**
   * Claims the work and expenses, writes every line and stores the totals. The amounts of what is
   * claimed come from the records themselves, so an invoice cannot disagree with its own source.
   */
  private async writeLines(
    invoice: Invoice,
    input: Pick<InvoiceInput, "lines" | "workEntryIds" | "disbursementIds" | "discount" | "taxRate">,
    decimals: number
  ) {
    const lineRows: Array<typeof invoiceLines.$inferInsert> = [];
    let position = 0;
    const amountOf = (quantity: string | Decimal, unitPrice: string | Decimal) =>
      toDb(roundTo(d(quantity).times(d(unitPrice)), decimals));

    if (input.workEntryIds?.length) {
      const claimed: WorkEntry[] = await this.db
        .update(workEntries)
        .set({ invoiceId: invoice.id, updatedAt: new Date() })
        .where(and(inArray(workEntries.id, input.workEntryIds), isNull(workEntries.invoiceId)))
        .returning();
      if (claimed.length !== new Set(input.workEntryIds).size) {
        throw new AccountingError("A work entry does not exist or is already on an invoice", 409);
      }
      await this.assertSameProject(invoice, claimed.map((t) => t.projectId));
      for (const entry of claimed.sort((a, b) => (a.date < b.date ? -1 : 1))) {
        lineRows.push({
          invoiceId: invoice.id,
          position: position++,
          kind: "fee",
          description: entry.description,
          quantity: entry.quantity,
          unit: entry.unit,
          unitPrice: entry.billingRate,
          amount: amountOf(entry.quantity, entry.billingRate),
          resourceId: entry.resourceId,
          lineDate: entry.date,
          workEntryId: entry.id,
        });
      }
    }

    if (input.disbursementIds?.length) {
      const claimed = await this.db
        .update(disbursements)
        .set({ invoiceId: invoice.id, updatedAt: new Date() })
        .where(
          and(
            inArray(disbursements.id, input.disbursementIds),
            isNull(disbursements.invoiceId),
            eq(disbursements.status, "pending")
          )
        )
        .returning();
      if (claimed.length !== new Set(input.disbursementIds).size) {
        throw new AccountingError("A disbursement does not exist or is already billed", 409);
      }
      await this.assertSameProject(invoice, claimed.map((x) => x.projectId));
      for (const expense of claimed) {
        lineRows.push({
          invoiceId: invoice.id,
          position: position++,
          kind: "expense",
          description: expense.description,
          quantity: "1",
          unitPrice: expense.amount,
          amount: amountOf("1", expense.amount),
          lineDate: expense.date,
          disbursementId: expense.id,
        });
      }
    }

    for (const line of input.lines ?? []) {
      const quantity = line.quantity ?? "1";
      if (d(quantity).isNegative() || d(line.unitPrice).isNegative()) {
        throw new AccountingError("Invoice lines cannot be negative: use the discount");
      }
      lineRows.push({
        invoiceId: invoice.id,
        position: position++,
        kind: line.kind ?? "fee",
        description: line.description,
        quantity,
        unitPrice: line.unitPrice,
        amount: amountOf(quantity, line.unitPrice),
        resourceId: line.resourceId,
        lineDate: line.date,
      });
    }

    if (lineRows.length > 0) await this.db.insert(invoiceLines).values(lineRows);
    return this.storeTotals(invoice.id, {
      lines: lineRows.map((l) => ({ kind: l.kind ?? "fee", amount: l.amount ?? "0" })),
      discount: input.discount ?? invoice.discount,
      taxRate: input.taxRate ?? invoice.taxRate,
      decimals,
    });
  }

  private async storeTotals(
    invoiceId: string,
    input: {
      lines: Array<{ kind: "fee" | "expense"; amount: string }>;
      discount: string;
      taxRate: string;
      decimals: number;
    }
  ) {
    const totals = computeInvoiceTotals(input.lines, input.discount, input.taxRate, input.decimals);
    if (!totals.total.greaterThan(0)) {
      throw new AccountingError("An invoice needs at least one line with an amount");
    }
    const values = {
      fees: toDb(totals.fees),
      expenses: toDb(totals.expenses),
      feesNet: toDb(totals.feesNet),
      tax: toDb(totals.tax),
      total: toDb(totals.total),
    };
    await this.db
      .update(invoices)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId));
    return values;
  }

  private async assertSameProject(invoice: Invoice, projectIds: string[]): Promise<void> {
    const ids = [...new Set(projectIds)];
    if (invoice.projectId && ids.some((id) => id !== invoice.projectId)) {
      throw new AccountingError("Everything on the invoice must belong to its project", 409);
    }
    const rows = await this.db
      .select({ clientId: projects.clientId })
      .from(projects)
      .where(inArray(projects.id, ids));
    if (rows.some((m) => m.clientId !== invoice.clientId)) {
      throw new AccountingError("Everything on the invoice must belong to its client", 409);
    }
  }

  private async releaseFromInvoice(invoiceId: string): Promise<void> {
    await this.db
      .update(workEntries)
      .set({ invoiceId: null, updatedAt: new Date() })
      .where(eq(workEntries.invoiceId, invoiceId));
    await this.db
      .update(disbursements)
      .set({ invoiceId: null, status: "pending", billedAt: null, updatedAt: new Date() })
      .where(eq(disbursements.invoiceId, invoiceId));
  }

  /**
   * Changes a draft. Sending lines, work entries or expenses replaces all three: what is not sent goes
   * back to work in progress. Without them, the existing lines are repriced.
   */
  async updateDraft(
    id: string,
    patch: Partial<Pick<InvoiceInput, "concept" | "feeType" | "revenueAccountId" | "issueDate" | "termsDays" | "taxRate" | "discount" | "lines" | "workEntryIds" | "disbursementIds">>
  ) {
    if (patch.issueDate) requireDate(patch.issueDate);
    return this.atomic(async (service) => {
      const invoice = await service.requireInvoice(id);
      if (invoice.status !== "draft") throw new AccountingError("Only a draft can be edited", 409);
      const settings = await service.getSettings();
      const decimals = await service.decimals(settings);
      const issueDate = patch.issueDate ?? invoice.issueDate;
      const termsDays = patch.termsDays ?? invoice.termsDays;
      const feeType = patch.feeType ?? invoice.feeType;
      if (patch.feeType) await service.conta.assertBillingType(feeType);

      const [updated] = await service.db
        .update(invoices)
        .set({
          concept: patch.concept ?? invoice.concept,
          feeType,
          revenueAccountId:
            patch.revenueAccountId || patch.feeType
              ? await service.resolveRevenueAccount(patch.revenueAccountId, feeType)
              : invoice.revenueAccountId,
          issueDate,
          termsDays,
          dueDate: addDays(issueDate, termsDays),
          taxRate: patch.taxRate ?? invoice.taxRate,
          discount: patch.discount ?? invoice.discount,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, id))
        .returning();

      if (patch.lines || patch.workEntryIds || patch.disbursementIds) {
        await service.releaseFromInvoice(id);
        await service.db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
        await service.writeLines(updated, patch, decimals);
      } else {
        const lines = await service.db
          .select({ kind: invoiceLines.kind, amount: invoiceLines.amount })
          .from(invoiceLines)
          .where(eq(invoiceLines.invoiceId, id));
        await service.storeTotals(id, {
          lines,
          discount: updated.discount,
          taxRate: updated.taxRate,
          decimals,
        });
      }
      return service.getInvoice(id);
    });
  }

  // ── Invoices: issue, void ───────────────────────────────────────────────

  /**
   * Issues a draft: takes the next number and posts receivable against revenue, reimbursable
   * expenses and tax. An expense line with no recorded disbursement means the business advanced the
   * money: it is recorded now, so that account 1250 always equals the disbursements behind it.
   */
  async issueInvoice(id: string, options: { date?: string; paidFromAccountId?: string } = {}) {
    const date = requireDate(options.date ?? today());
    return this.atomic(async (service) => {
      const invoice = await service.requireInvoice(id);
      if (invoice.status !== "draft") throw new AccountingError("Only a draft can be issued", 409);
      const settings = await service.getSettings();
      const number = await service.nextNumber(
        "invoice",
        settings.invoicePrefix,
        date,
        settings.numberPadding
      );

      const [claimed] = await service.db
        .update(invoices)
        .set({
          status: "issued",
          number,
          issueDate: date,
          dueDate: addDays(date, invoice.termsDays),
          updatedAt: new Date(),
        })
        .where(and(eq(invoices.id, id), eq(invoices.status, "draft")))
        .returning();
      if (!claimed) throw new AccountingError("Only a draft can be issued", 409);

      const lines: InvoiceLine[] = await service.db
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, id));
      const advances = lines.filter((l) => l.kind === "expense" && !l.disbursementId);
      if (advances.length > 0 && !invoice.projectId) {
        throw new AccountingError("An expense line needs an invoice with a project");
      }
      const paidFrom =
        options.paidFromAccountId ?? (advances.length ? await service.account("operatingBank") : undefined);
      for (const line of advances) {
        const { disbursement } = await service.conta.createDisbursement({
          projectId: invoice.projectId as string,
          description: `Advanced: ${line.description}`,
          amount: line.amount,
          paidFromAccountId: paidFrom as string,
          date,
        });
        await service.db
          .update(disbursements)
          .set({ invoiceId: id })
          .where(eq(disbursements.id, disbursement.id));
        await service.db
          .update(invoiceLines)
          .set({ disbursementId: disbursement.id })
          .where(eq(invoiceLines.id, line.id));
      }
      await service.db
        .update(disbursements)
        .set({ status: "billed", billedAt: new Date(), updatedAt: new Date() })
        .where(eq(disbursements.invoiceId, id));

      const projectId = invoice.projectId ?? undefined;
      const ledger: Array<{ accountId: string; debit?: string; credit?: string; description: string }> = [
        { accountId: await service.account("receivable"), debit: invoice.total, description: `Receivable ${number}` },
      ];
      if (d(invoice.feesNet).greaterThan(0)) {
        ledger.push({ accountId: invoice.revenueAccountId, credit: invoice.feesNet, description: `Fees ${number}` });
      }
      if (d(invoice.expenses).greaterThan(0)) {
        ledger.push({
          accountId: await service.account("reimbursable"),
          credit: invoice.expenses,
          description: `Expenses billed ${number}`,
        });
      }
      if (d(invoice.tax).greaterThan(0)) {
        ledger.push({ accountId: await service.account("taxPayable"), credit: invoice.tax, description: `Tax ${number}` });
      }
      const { journal } = await service.conta.createJournal({
        date,
        description: `Invoice ${number}`,
        reference: number,
        counterpartyId: invoice.clientId,
        journalType: "invoice",
        status: "posted",
        metadata: { invoiceId: id, source: invoice.source },
        lines: ledger.map((l) => ({ ...l, projectId, currency: invoice.currency })),
      });

      await service.db.update(invoices).set({ journalId: journal.id }).where(eq(invoices.id, id));
      await service.conta.recordAudit({
        action: "invoice.issued",
        entityType: "invoice",
        entityId: id,
        summary: `${number} · ${invoice.total}`,
        detail: { journalId: journal.id, clientId: invoice.clientId, date },
      });
      return service.getInvoice(id);
    });
  }

  /**
   * Voids an invoice. A draft disappears. An issued one is cancelled by reversing its journal under
   * a credit note, and refused while it has live payments: reverse those first. Work and expenses
   * go back to work in progress. Money the business advanced stays in account 1250, still recoverable.
   */
  async voidInvoice(id: string, options: { reason?: string; date?: string } = {}) {
    const date = requireDate(options.date ?? today());
    return this.atomic(async (service) => {
      const invoice = await service.requireInvoice(id);
      if (invoice.status === "void") throw new AccountingError("The invoice is already void", 409);

      if (invoice.status === "draft") {
        await service.releaseFromInvoice(id);
        await service.db.delete(invoices).where(eq(invoices.id, id));
        await service.conta.recordAudit({
          action: "invoice.draft_deleted",
          entityType: "invoice",
          entityId: id,
          summary: `Draft deleted · ${invoice.total}`,
          detail: { reason: options.reason ?? null, clientId: invoice.clientId },
        });
        return { id, deleted: true as const };
      }

      if (d(invoice.amountPaid).greaterThan(0)) {
        throw new AccountingError("The invoice has payments: reverse them before voiding it", 409);
      }
      const settings = await service.getSettings();
      const creditNote = await service.nextNumber(
        "credit_note",
        settings.creditNotePrefix,
        date,
        settings.numberPadding
      );
      const { reversal } = await service.conta.reverseJournal(invoice.journalId as string, date, {
        journalType: "credit_note",
        reference: creditNote,
        description: `Credit note ${creditNote}, voids ${invoice.number}`,
      });
      await service.db
        .update(invoices)
        .set({
          status: "void",
          voidJournalId: reversal.id,
          creditNoteNumber: creditNote,
          voidReason: options.reason,
          voidedOn: date,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, id));
      await service.releaseFromInvoice(id);
      await service.db
        .update(successFees)
        .set({ status: "open", invoiceId: null, settledOn: null, achievedAmount: null, updatedAt: new Date() })
        .where(eq(successFees.invoiceId, id));
      await service.conta.recordAudit({
        action: "invoice.voided",
        entityType: "invoice",
        entityId: id,
        summary: `${invoice.number} voided by ${creditNote}`,
        detail: { reason: options.reason ?? null, journalId: reversal.id, date },
      });
      return { id, deleted: false as const, invoice: await service.getInvoice(id) };
    });
  }

  // ── Invoices: payments ──────────────────────────────────────────────────

  /**
   * A full or partial payment into an own account, or applied from the client's funds. Paying from
   * client funds moves the money out of the client funds bank too, so that bank never holds own money.
   */
  async recordPayment(
    invoiceId: string,
    input: {
      amount: string | number;
      date?: string;
      accountId?: string;
      source?: "account" | "client_funds";
      method?: string;
      reference?: string;
      bankLineId?: string;
      /** A file kept with the payment, such as a receipt: its id in the media library. */
      attachmentMediaId?: string;
    }
  ) {
    const amount = requirePositive(input.amount, "The amount");
    const date = requireDate(input.date ?? today());
    const source = input.source ?? "account";
    return this.atomic(async (service) => {
      const invoice = await service.requireInvoice(invoiceId);
      if (invoice.status !== "issued") throw new AccountingError("Only an issued invoice takes payments", 409);

      // The balance is checked and moved in one statement: two payments at once cannot overpay.
      const [claimed] = await service.db
        .update(invoices)
        .set({ amountPaid: sql`${invoices.amountPaid} + ${toDb(amount)}::numeric`, updatedAt: new Date() })
        .where(
          and(
            eq(invoices.id, invoiceId),
            eq(invoices.status, "issued"),
            sql`${invoices.total} - ${invoices.amountPaid} >= ${toDb(amount)}::numeric`
          )
        )
        .returning();
      if (!claimed) {
        throw new AccountingError(
          `The amount exceeds the balance due (${invoiceBalance(invoice).toFixed(2)})`,
          409
        );
      }

      const operating =
        source === "account" && input.accountId
          ? (await service.requireOperatingAccount(input.accountId)).id
          : await service.account("operatingBank");
      const receivable = await service.account("receivable");
      const projectId = invoice.projectId ?? undefined;
      const value = toDb(amount);
      const label = `Payment ${invoice.number}`;
      const ledger =
        source === "client_funds"
          ? [
              { accountId: await service.account("clientFundsLiability"), debit: value, description: `Client funds applied to ${invoice.number}` },
              { accountId: await service.account("clientFundsBank"), credit: value, description: `Out of the client funds bank for ${invoice.number}` },
              { accountId: operating, debit: value, description: label },
              { accountId: receivable, credit: value, description: label },
            ]
          : [
              { accountId: operating, debit: value, description: label },
              { accountId: receivable, credit: value, description: label },
            ];
      const { journal } = await service.conta.createJournal({
        date,
        description: label,
        reference: input.reference || invoice.number || undefined,
        counterpartyId: invoice.clientId,
        journalType: source === "client_funds" ? "client_funds_application" : "payment",
        status: "posted",
        metadata: { invoiceId, method: input.method ?? null },
        lines: ledger.map((l) => ({ ...l, projectId, currency: invoice.currency })),
      });

      const [payment] = await service.db
        .insert(invoicePayments)
        .values({
          invoiceId,
          date,
          amount: value,
          source,
          accountId: operating,
          method: input.method,
          reference: input.reference,
          journalId: journal.id,
          bankLineId: input.bankLineId,
          attachmentMediaId: input.attachmentMediaId,
        })
        .returning();

      if (!invoiceBalance(claimed).greaterThan(0)) {
        await service.db
          .update(disbursements)
          .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
          .where(eq(disbursements.invoiceId, invoiceId));
      }
      await service.conta.recordAudit({
        action: "payment.recorded",
        entityType: "invoice",
        entityId: invoiceId,
        summary: `${invoice.number} · ${value} · ${source}`,
        detail: { paymentId: payment.id, journalId: journal.id, source, date },
      });
      return { payment, invoice: presentInvoice(claimed) };
    });
  }

  /** Undoes a payment that did not happen, such as a returned check. */
  async reversePayment(paymentId: string, options: { date?: string; reason?: string } = {}) {
    const date = requireDate(options.date ?? today());
    return this.atomic(async (service) => {
      const [payment] = await service.db
        .select()
        .from(invoicePayments)
        .where(eq(invoicePayments.id, paymentId))
        .limit(1);
      if (!payment) throw new AccountingError("Payment not found", 404);

      const [claimed] = await service.db
        .update(invoicePayments)
        .set({ reversedOn: date })
        .where(and(eq(invoicePayments.id, paymentId), isNull(invoicePayments.reversedOn)))
        .returning({ id: invoicePayments.id });
      if (!claimed) throw new AccountingError("The payment was already reversed", 409);

      const { reversal } = await service.conta.reverseJournal(payment.journalId, date);
      await service.db
        .update(invoicePayments)
        .set({ reversalJournalId: reversal.id })
        .where(eq(invoicePayments.id, paymentId));
      const [invoice] = await service.db
        .update(invoices)
        .set({ amountPaid: sql`${invoices.amountPaid} - ${payment.amount}::numeric`, updatedAt: new Date() })
        .where(eq(invoices.id, payment.invoiceId))
        .returning();
      await service.db
        .update(disbursements)
        .set({ status: "billed", paidAt: null, updatedAt: new Date() })
        .where(and(eq(disbursements.invoiceId, payment.invoiceId), eq(disbursements.status, "paid")));
      if (payment.bankLineId) {
        await service.db
          .update(bankLines)
          .set({ matchKind: null, matchLabel: null, matchId: null, journalId: null, reconciledAt: null, reconciledBy: null })
          .where(eq(bankLines.id, payment.bankLineId));
      }
      await service.conta.recordAudit({
        action: "payment.reversed",
        entityType: "invoice",
        entityId: payment.invoiceId,
        summary: `${invoice.number} · ${payment.amount} reversed`,
        detail: { paymentId, journalId: reversal.id, reason: options.reason ?? null, date },
      });
      return { paymentId, invoice: presentInvoice(invoice) };
    });
  }

  // ── Invoices: reminders and delivery ────────────────────────────────────

  /** Records that a reminder went out. Sending it is the job of whatever channel the app uses. */
  async addReminder(invoiceId: string, input: { channel: string; date?: string; note?: string }) {
    const date = requireDate(input.date ?? today());
    return this.atomic(async (service) => {
      const invoice = await service.requireInvoice(invoiceId);
      if (invoice.status !== "issued") throw new AccountingError("Only an issued invoice takes reminders", 409);
      const [reminder] = await service.db
        .insert(invoiceReminders)
        .values({ invoiceId, date, channel: input.channel, note: input.note })
        .returning();
      await service.conta.recordAudit({
        action: "invoice.reminded",
        entityType: "invoice",
        entityId: invoiceId,
        summary: `${invoice.number} via ${input.channel}`,
        detail: { date },
      });
      return reminder;
    });
  }

  /**
   * The same reminder on many invoices. Each stands alone: one that cannot take it (not found, not
   * issued) is listed in `failed` with the reason, and the others are still recorded.
   */
  async addReminders(input: { invoiceIds: string[]; channel: string; date?: string; note?: string }) {
    const date = requireDate(input.date ?? today());
    let recorded = 0;
    const failed: Array<{ invoiceId: string; reason: string }> = [];
    for (const invoiceId of [...new Set(input.invoiceIds)]) {
      try {
        await this.addReminder(invoiceId, { channel: input.channel, date, note: input.note });
        recorded += 1;
      } catch (err) {
        if (!(err instanceof AccountingError)) throw err;
        failed.push({ invoiceId, reason: err.message });
      }
    }
    return { recorded, failed };
  }

  async markDelivery(invoiceId: string, event: "sent" | "viewed", at?: string) {
    const invoice = await this.requireInvoice(invoiceId);
    if (invoice.status !== "issued") throw new AccountingError("Only an issued invoice is delivered", 409);
    const when = at ? new Date(at) : new Date();
    const [row] = await this.db
      .update(invoices)
      .set(event === "sent" ? { sentAt: when } : { viewedAt: when })
      .where(eq(invoices.id, invoiceId))
      .returning();
    return presentInvoice(row);
  }

  // ── Invoices: reading ───────────────────────────────────────────────────

  /**
   * One invoice with its lines, payments and reminders. With `journals`, also the journals behind it:
   * its issue, its credit note, and each payment and payment reversal, with their lines.
   */
  async getInvoice(id: string, options: { journals?: boolean } = {}) {
    const invoice = await this.requireInvoice(id);
    const lines = await this.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, id))
      .orderBy(asc(invoiceLines.position));
    const payments = await this.db
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, id))
      .orderBy(asc(invoicePayments.date), asc(invoicePayments.createdAt));
    const reminders = await this.db
      .select()
      .from(invoiceReminders)
      .where(eq(invoiceReminders.invoiceId, id))
      .orderBy(asc(invoiceReminders.date));
    const [client] = await this.db
      .select({ name: counterparties.name })
      .from(counterparties)
      .where(eq(counterparties.id, invoice.clientId))
      .limit(1);
    const detail = { ...presentInvoice(invoice), clientName: client?.name ?? null, lines, payments, reminders };
    if (!options.journals) return detail;
    const ids = [
      invoice.journalId,
      invoice.voidJournalId,
      ...payments.flatMap((p) => [p.journalId, p.reversalJournalId]),
    ].filter((x): x is string => Boolean(x));
    return { ...detail, journals: await this.journalsWithLines(ids) };
  }

  /** Journals with their lines as account code and name, in date order. Two queries, whatever the count. */
  private async journalsWithLines(ids: string[]) {
    if (ids.length === 0) return [];
    const heads = await this.db
      .select({ id: journals.id, date: journals.date, description: journals.description, journalType: journals.journalType })
      .from(journals)
      .where(inArray(journals.id, ids))
      .orderBy(asc(journals.date), asc(journals.createdAt));
    const lines = await this.db
      .select({
        journalId: ledgerEntries.journalId,
        accountCode: accounts.code,
        accountName: accounts.name,
        debit: ledgerEntries.debit,
        credit: ledgerEntries.credit,
      })
      .from(ledgerEntries)
      .innerJoin(accounts, eq(ledgerEntries.accountId, accounts.id))
      .where(inArray(ledgerEntries.journalId, ids))
      // Debits first, then by account: the order an entry is read in.
      .orderBy(desc(sql`${ledgerEntries.debit} > 0`), asc(accounts.code));
    return heads.map((head) => ({
      ...head,
      lines: lines
        .filter((l) => l.journalId === head.id)
        .map(({ journalId: _journalId, ...line }) => line),
    }));
  }

  /**
   * Invoices with what a list shows of each, in one query: client, project, reminders and payments.
   * `summary` adds up the rows' `total`, `amountPaid` and `balance` over every page of the filter.
   * `counts` (with `include: "counts"`) are per display status over the same filter without
   * `status`, so each tab of a list can show its number.
   */
  async listInvoices(
    filter: ListPage & {
      status?: InvoiceDisplayStatus | "open";
      clientId?: string;
      projectId?: string;
      feeType?: BillingType;
      /** Invoices of the projects this resource runs. */
      responsibleResourceId?: string;
      dateFrom?: string;
      dateTo?: string;
      dueFrom?: string;
      dueTo?: string;
      q?: string;
      asOf?: string;
      sort?: InvoiceSort;
      order?: "asc" | "desc";
      include?: "counts";
    } = {}
  ) {
    const { limit, page, offset } = paging(filter);
    const asOf = filter.asOf ?? today();
    const conditions: Array<SQL | undefined> = [];
    if (filter.clientId) conditions.push(eq(invoices.clientId, filter.clientId));
    if (filter.projectId) conditions.push(eq(invoices.projectId, filter.projectId));
    if (filter.feeType) conditions.push(eq(invoices.feeType, filter.feeType));
    if (filter.responsibleResourceId) conditions.push(eq(projects.responsibleResourceId, filter.responsibleResourceId));
    if (filter.dateFrom) conditions.push(gte(invoices.issueDate, filter.dateFrom));
    if (filter.dateTo) conditions.push(lte(invoices.issueDate, filter.dateTo));
    if (filter.dueFrom) conditions.push(gte(invoices.dueDate, filter.dueFrom));
    if (filter.dueTo) conditions.push(lte(invoices.dueDate, filter.dueTo));
    if (filter.q) {
      const like = `%${filter.q}%`;
      conditions.push(
        or(ilike(invoices.number, like), ilike(invoices.concept, like), ilike(counterparties.name, like))
      );
    }
    const withoutStatus = conditions.length ? and(...conditions) : undefined;
    const status = displayStatusSql(asOf);
    const where = filter.status
      ? and(
          withoutStatus,
          filter.status === "open"
            ? sql`${invoices.status} = 'issued' AND ${invoices.total} > ${invoices.amountPaid}`
            : sql`${status} = ${filter.status}`
        )
      : withoutStatus;

    const balance = invoiceBalanceSql();
    const overdueDays = sql<number>`CASE WHEN ${status} = 'overdue' THEN ${asOf}::date - ${invoices.dueDate}::date ELSE 0 END`;
    const sortBy = { issueDate: invoices.issueDate, dueDate: invoices.dueDate, daysOverdue: overdueDays, balance, total: invoices.total };
    const direction = filter.order === "asc" ? asc : desc;
    const order = [
      ...(filter.sort ? [direction(sortBy[filter.sort])] : []),
      desc(invoices.issueDate),
      desc(invoices.createdAt),
      asc(invoices.id),
    ];

    const rows = await this.db
      .select({
        invoice: invoices,
        clientName: counterparties.name,
        projectName: projects.name,
        projectNumber: projects.number,
        reminderCount: sql<number>`(SELECT count(*)::int FROM ${invoiceReminders} WHERE ${invoiceReminders.invoiceId} = ${invoices.id})`,
        lastReminderOn: sql<string | null>`(SELECT max(${invoiceReminders.date}) FROM ${invoiceReminders} WHERE ${invoiceReminders.invoiceId} = ${invoices.id})`,
        paymentCount: sql<number>`(SELECT count(*)::int FROM ${invoicePayments} WHERE ${invoicePayments.invoiceId} = ${invoices.id} AND ${invoicePayments.reversedOn} IS NULL)`,
      })
      .from(invoices)
      .innerJoin(counterparties, eq(invoices.clientId, counterparties.id))
      .leftJoin(projects, eq(invoices.projectId, projects.id))
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset);
    const [summary] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${invoices.total}), 0)`,
        paid: sql<string>`coalesce(sum(${invoices.amountPaid}), 0)`,
        balance: sql<string>`coalesce(sum(${balance}), 0)`,
      })
      .from(invoices)
      .innerJoin(counterparties, eq(invoices.clientId, counterparties.id))
      .leftJoin(projects, eq(invoices.projectId, projects.id))
      .where(where);
    const total = Number(summary?.count ?? 0);

    let counts: Record<InvoiceDisplayStatus | "open", number> | undefined;
    if (filter.include === "counts") {
      const by = (value: InvoiceDisplayStatus) => sql<number>`(count(*) FILTER (WHERE ${status} = ${value}))::int`;
      const [row] = await this.db
        .select({
          draft: by("draft"),
          pending: by("pending"),
          partial: by("partial"),
          overdue: by("overdue"),
          paid: by("paid"),
          void: by("void"),
        })
        .from(invoices)
        .innerJoin(counterparties, eq(invoices.clientId, counterparties.id))
        .leftJoin(projects, eq(invoices.projectId, projects.id))
        .where(withoutStatus);
      const n = (k: InvoiceDisplayStatus) => Number(row?.[k] ?? 0);
      counts = {
        draft: n("draft"),
        pending: n("pending"),
        partial: n("partial"),
        overdue: n("overdue"),
        paid: n("paid"),
        void: n("void"),
        open: n("pending") + n("partial") + n("overdue"),
      };
    }

    return {
      data: rows.map((r) => ({
        ...presentInvoice(r.invoice, asOf),
        clientName: r.clientName,
        projectName: r.projectName,
        projectNumber: r.projectNumber,
        reminderCount: Number(r.reminderCount),
        lastReminderOn: r.lastReminderOn,
        paymentCount: Number(r.paymentCount),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      summary: {
        count: total,
        total: toDb(d(summary?.total ?? 0)),
        paid: toDb(d(summary?.paid ?? 0)),
        balance: toDb(d(summary?.balance ?? 0)),
      },
      ...(counts ? { counts } : {}),
    };
  }

  // ── Client funds ──────────────────────────────────────────────────

  private async postClientFunds(
    input: ClientFundsInput,
    kind: { journalType: Journal["journalType"]; action: string; into: boolean; label: string }
  ): Promise<{ journal: Journal; lines: LedgerEntry[]; balance: string }> {
    const amount = requirePositive(input.amount, "The amount");
    const date = requireDate(input.date ?? today());
    return this.atomic(async (service) => {
      const client = await service.requireClient(input.clientId);
      const project = await service.requireProjectOfClient(input.projectId, client.id);
      const settings = await service.getSettings();
      const bank = await service.account("clientFundsBank");
      const liability = await service.account("clientFundsLiability");
      const value = toDb(amount);
      const description = input.description || `${kind.label} · ${client.name}`;
      const posted = await service.conta.createJournal({
        date,
        description,
        reference: input.reference,
        counterpartyId: client.id,
        journalType: kind.journalType,
        status: "posted",
        createdBy: input.createdBy,
        metadata: {
          payee: input.payee ?? null,
          ...(input.reference ? { externalRef: input.reference } : {}),
        },
        lines: [
          { accountId: kind.into ? bank : liability, debit: value, description },
          { accountId: kind.into ? liability : bank, credit: value, description },
        ].map((l) => ({ ...l, projectId: project?.id, currency: settings.baseCurrency })),
      });
      const balance = await service.conta.getClientFundsHeld(client.id);
      await service.conta.recordAudit({
        action: kind.action,
        entityType: "client",
        entityId: client.id,
        summary: `${client.name} · ${value}${input.payee ? ` · ${input.payee}` : ""}`,
        detail: { journalId: posted.journal.id, projectId: project?.id ?? null, date },
        actorId: input.createdBy,
      });
      return { ...posted, balance: toDb(balance) };
    });
  }

  clientFundsDeposit(input: ClientFundsInput) {
    return this.postClientFunds(input, {
      journalType: "client_funds_deposit",
      action: "client_funds.deposited",
      into: true,
      label: "Funds received",
    });
  }

  clientFundsDisburse(input: ClientFundsInput) {
    return this.postClientFunds(input, {
      journalType: "client_funds_disbursement",
      action: "client_funds.disbursed",
      into: false,
      label: "Paid from client funds",
    });
  }

  clientFundsRefund(input: ClientFundsInput) {
    return this.postClientFunds(input, {
      journalType: "client_funds_refund",
      action: "client_funds.refunded",
      into: false,
      label: "Unused funds returned",
    });
  }

  /** The balance per client, with the minimum agreed with each and the top-up it suggests. */
  async clientFundsByClient() {
    const rows = await this.db
      .select({
        clientId: journals.counterpartyId,
        balance: sql<string>`coalesce(sum(${ledgerEntries.credit} - ${ledgerEntries.debit}), 0)`,
        lastMovement: sql<string>`max(${journals.date})`,
        clientName: counterparties.name,
        minimum: counterparties.fundsMinimum,
      })
      .from(ledgerEntries)
      .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
      .innerJoin(accounts, eq(ledgerEntries.accountId, accounts.id))
      .innerJoin(counterparties, eq(journals.counterpartyId, counterparties.id))
      .where(
        and(eq(accounts.isClientFundsAccount, true), eq(accounts.type, "liability"), inArray(journals.status, IN_THE_BOOKS))
      )
      .groupBy(journals.counterpartyId, counterparties.name, counterparties.fundsMinimum);
    return rows
      .map((r) => {
        const balance = d(r.balance);
        const minimum = d(r.minimum);
        const below = balance.lessThan(minimum);
        return {
          clientId: r.clientId as string,
          clientName: r.clientName,
          balance: toDb(balance),
          minimum: toDb(minimum),
          belowMinimum: below,
          suggestedTopUp: below ? toDb(minimum.times(2).minus(balance)) : "0.0000",
          lastMovement: r.lastMovement,
        };
      })
      .sort((a, b) => d(b.balance).comparedTo(d(a.balance)));
  }

  /** A client's statement, newest first. Running balances come from the first movement on. */
  async clientFundsTransactions(
    filter: { clientId?: string; dateFrom?: string; dateTo?: string; limit?: number } = {}
  ) {
    const conditions: SQL[] = [
      eq(accounts.isClientFundsAccount, true),
      eq(accounts.type, "liability"),
      inArray(journals.status, IN_THE_BOOKS),
    ];
    if (filter.clientId) conditions.push(eq(journals.counterpartyId, filter.clientId));
    const rows = await this.db
      .select({
        id: ledgerEntries.id,
        journalId: journals.id,
        date: journals.date,
        type: journals.journalType,
        description: journals.description,
        reference: journals.reference,
        reversalOfId: journals.reversalOfId,
        metadata: journals.metadata,
        clientId: journals.counterpartyId,
        clientName: counterparties.name,
        projectId: ledgerEntries.projectId,
        debit: ledgerEntries.debit,
        credit: ledgerEntries.credit,
      })
      .from(ledgerEntries)
      .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
      .innerJoin(accounts, eq(ledgerEntries.accountId, accounts.id))
      .leftJoin(counterparties, eq(journals.counterpartyId, counterparties.id))
      .where(and(...conditions))
      .orderBy(asc(journals.date), asc(journals.createdAt));

    const running = new Map<string, Decimal>();
    const movements = rows.map((row) => {
      const amount = d(row.credit).minus(row.debit);
      const key = row.clientId ?? "";
      const balance = (running.get(key) ?? new Decimal(0)).plus(amount);
      running.set(key, balance);
      const { debit: _debit, credit: _credit, metadata, ...rest } = row;
      return {
        ...rest,
        payee: (metadata as { payee?: string | null } | null)?.payee ?? null,
        amount: toDb(amount),
        balance: toDb(balance),
      };
    });
    return movements
      .filter((m) => (!filter.dateFrom || m.date >= filter.dateFrom) && (!filter.dateTo || m.date <= filter.dateTo))
      .reverse()
      .slice(0, Math.min(Math.max(filter.limit ?? 1000, 1), 5000));
  }

  /** Bank = liability = sum of client balances. If they differ, money is misplaced. */
  async clientFundsReconciliation(asOf?: string) {
    const conditions: SQL[] = [eq(accounts.isClientFundsAccount, true), inArray(journals.status, IN_THE_BOOKS)];
    if (asOf) conditions.push(lte(journals.date, asOf));
    const rows = await this.db
      .select({
        type: accounts.type,
        debit: sql<string>`coalesce(sum(${ledgerEntries.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${ledgerEntries.credit}), 0)`,
        namedCredit: sql<string>`coalesce(sum(${ledgerEntries.credit}) FILTER (WHERE ${journals.counterpartyId} IS NOT NULL), 0)`,
        namedDebit: sql<string>`coalesce(sum(${ledgerEntries.debit}) FILTER (WHERE ${journals.counterpartyId} IS NOT NULL), 0)`,
      })
      .from(ledgerEntries)
      .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
      .innerJoin(accounts, eq(ledgerEntries.accountId, accounts.id))
      .where(and(...conditions))
      .groupBy(accounts.type);
    const asset = rows.find((r) => r.type === "asset");
    const liability = rows.find((r) => r.type === "liability");
    const bank = d(asset?.debit ?? 0).minus(asset?.credit ?? 0);
    const held = d(liability?.credit ?? 0).minus(liability?.debit ?? 0);
    const clients = d(liability?.namedCredit ?? 0).minus(liability?.namedDebit ?? 0);
    return {
      bank: toDb(bank),
      liability: toDb(held),
      clients: toDb(clients),
      balanced: bank.equals(held) && held.equals(clients),
    };
  }

  // ── Recurring fees ───────────────────────────────────────────────────────────

  async createRecurringFee(input: {
    clientId: string;
    projectId?: string;
    concept: string;
    amount: string;
    quantityIncluded?: string;
    unit?: string;
    frequency?: RecurringFrequency;
    nextDate?: string;
    externalRef?: string;
  }) {
    requirePositive(input.amount, "The amount");
    const nextDate = requireDate(input.nextDate ?? today());
    return this.atomic(async (service) => {
      const client = await service.requireClient(input.clientId);
      await service.requireProjectOfClient(input.projectId, client.id);
      const [row] = await service.db
        .insert(recurringFees)
        .values({ ...input, nextDate, since: today() })
        .returning();
      await service.conta.recordAudit({
        action: "recurring_fee.created",
        entityType: "recurring",
        entityId: row.id,
        summary: `${client.name} · ${row.concept} · ${row.amount}`,
        detail: { frequency: row.frequency, nextDate },
      });
      return row;
    });
  }

  async updateRecurringFee(
    id: string,
    patch: {
      concept?: string;
      amount?: string;
      quantityIncluded?: string;
      unit?: string;
      frequency?: RecurringFrequency;
      nextDate?: string;
      isActive?: boolean;
    }
  ) {
    if (patch.amount) requirePositive(patch.amount, "The amount");
    if (patch.nextDate) requireDate(patch.nextDate);
    return this.atomic(async (service) => {
      const [row] = await service.db
        .update(recurringFees)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(recurringFees.id, id))
        .returning();
      if (!row) throw new AccountingError("Recurring fee not found", 404);
      await service.conta.recordAudit({
        action: "recurring_fee.updated",
        entityType: "recurring",
        entityId: id,
        summary: `${row.concept}: ${Object.keys(patch).join(", ")}`,
        detail: { ...patch },
      });
      return row;
    });
  }

  private periodStart(recurringFee: Pick<RecurringFee, "nextDate" | "frequency">): string {
    return dayjs(recurringFee.nextDate).subtract(RECURRING_MONTHS[recurringFee.frequency], "month").format("YYYY-MM-DD");
  }

  /** Each recurring fee with the quantity used in its current period, and the recurring revenue. */
  async listRecurringFees(filter: { clientId?: string; active?: boolean; asOf?: string } = {}) {
    const asOf = filter.asOf ?? today();
    const conditions: SQL[] = [];
    if (filter.clientId) conditions.push(eq(recurringFees.clientId, filter.clientId));
    if (filter.active !== undefined) conditions.push(eq(recurringFees.isActive, filter.active));
    const rows = await this.db
      .select({ recurringFee: recurringFees, clientName: counterparties.name })
      .from(recurringFees)
      .innerJoin(counterparties, eq(recurringFees.clientId, counterparties.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(recurringFees.nextDate));

    const data = [];
    let monthly = new Decimal(0);
    let due = 0;
    for (const { recurringFee, clientName } of rows) {
      let quantityUsed = "0.0000";
      if (recurringFee.projectId) {
        const [used] = await this.db
          .select({ quantity: sql<string>`coalesce(sum(${workEntries.quantity}), 0)` })
          .from(workEntries)
          .where(
            and(
              eq(workEntries.projectId, recurringFee.projectId),
              eq(workEntries.unit, recurringFee.unit),
              gte(workEntries.date, this.periodStart(recurringFee)),
              sql`${workEntries.date} < ${recurringFee.nextDate}`
            )
          );
        quantityUsed = toDb(d(used?.quantity ?? 0));
      }
      const isDue = recurringFee.isActive && recurringFee.nextDate <= asOf;
      if (recurringFee.isActive) monthly = monthly.plus(d(recurringFee.amount).dividedBy(RECURRING_MONTHS[recurringFee.frequency]));
      if (isDue) due += 1;
      data.push({ ...recurringFee, clientName, quantityUsed, isDue });
    }
    return { data, summary: { monthlyRecurring: toDb(monthly), dueCount: due, asOf } };
  }

  /** Bills one period of a recurring fee. The period is claimed first, so two calls at once bill it once. */
  async billRecurringFee(id: string, options: { date?: string } = {}) {
    const date = requireDate(options.date ?? today());
    return this.atomic(async (service) => {
      const [recurringFee] = await service.db.select().from(recurringFees).where(eq(recurringFees.id, id)).limit(1);
      if (!recurringFee) throw new AccountingError("Recurring fee not found", 404);
      if (!recurringFee.isActive) throw new AccountingError("The recurring fee is paused", 409);

      const next = dayjs(recurringFee.nextDate).add(RECURRING_MONTHS[recurringFee.frequency], "month").format("YYYY-MM-DD");
      const [claimed] = await service.db
        .update(recurringFees)
        .set({ nextDate: next, updatedAt: new Date() })
        .where(and(eq(recurringFees.id, id), eq(recurringFees.nextDate, recurringFee.nextDate)))
        .returning({ id: recurringFees.id });
      if (!claimed) throw new AccountingError("This period was just billed", 409);

      const included = d(recurringFee.quantityIncluded);
      const invoice = await service.createInvoice({
        clientId: recurringFee.clientId,
        projectId: recurringFee.projectId ?? undefined,
        concept: `${recurringFee.concept} · ${recurringFee.nextDate.slice(0, 7)}`,
        feeType: "recurring",
        issueDate: date,
        source: "recurring",
        issue: true,
        lines: [
          {
            description: included.greaterThan(0)
              ? `${recurringFee.concept} (includes ${included.toString()} ${recurringFee.unit})`
              : recurringFee.concept,
            unitPrice: recurringFee.amount,
          },
        ],
      });
      await service.db
        .update(recurringFees)
        .set({ lastInvoiceId: invoice.id })
        .where(eq(recurringFees.id, id));
      return { recurringFeeId: id, nextDate: next, invoice };
    });
  }

  /**
   * Bills every recurring fee due. One period each per run. A recurring fee that cannot be billed, say on a
   * closed date, is reported and the others go on.
   */
  async runRecurringFees(options: { date?: string } = {}) {
    const date = requireDate(options.date ?? today());
    const due = await this.db
      .select({ id: recurringFees.id })
      .from(recurringFees)
      .where(and(eq(recurringFees.isActive, true), lte(recurringFees.nextDate, date)))
      .orderBy(asc(recurringFees.nextDate));
    const created = [];
    const failed: Array<{ recurringFeeId: string; message: string }> = [];
    for (const { id } of due) {
      try {
        created.push(await this.billRecurringFee(id, { date }));
      } catch (err) {
        if (!(err instanceof AccountingError)) throw err;
        failed.push({ recurringFeeId: id, message: err.message });
      }
    }
    return { date, created, failed };
  }

  // ── Success fees ────────────────────────────────────────────────────

  private presentSuccessFee<T extends SuccessFee>(row: T) {
    const expected = d(row.baseAmount).times(row.percentage);
    return {
      ...row,
      expectedFee: toDb(expected),
      weightedFee: toDb(expected.times(row.probability)),
    };
  }

  async createSuccessFee(input: {
    projectId: string;
    baseAmount: string;
    percentage: string;
    probability?: string;
    stage?: string;
    expectedDate?: string;
    externalRef?: string;
  }) {
    if (input.expectedDate) requireDate(input.expectedDate);
    return this.atomic(async (service) => {
      const project = await service.requireProject({ projectId: input.projectId });
      const [row] = await service.db
        .insert(successFees)
        .values({ ...input, clientId: project.clientId })
        .returning();
      await service.conta.recordAudit({
        action: "success_fee.created",
        entityType: "success",
        entityId: row.id,
        summary: `${project.number} · ${row.percentage} of ${row.baseAmount}`,
        detail: {},
      });
      return service.presentSuccessFee(row);
    });
  }

  async updateSuccessFee(
    id: string,
    patch: {
      baseAmount?: string;
      percentage?: string;
      probability?: string;
      stage?: string;
      expectedDate?: string;
    }
  ) {
    if (patch.expectedDate) requireDate(patch.expectedDate);
    const [row] = await this.db
      .update(successFees)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(successFees.id, id), eq(successFees.status, "open")))
      .returning();
    if (!row) throw new AccountingError("Success fee not found or already settled", 404);
    return this.presentSuccessFee(row);
  }

  /** The pipeline: each success fee with its amount if won, and that amount weighted by its probability. */
  async listSuccessFees(filter: { clientId?: string; status?: SuccessFee["status"] } = {}) {
    const conditions: SQL[] = [];
    if (filter.clientId) conditions.push(eq(successFees.clientId, filter.clientId));
    if (filter.status) conditions.push(eq(successFees.status, filter.status));
    const rows = await this.db
      .select({ row: successFees, clientName: counterparties.name, projectNumber: projects.number })
      .from(successFees)
      .innerJoin(counterparties, eq(successFees.clientId, counterparties.id))
      .innerJoin(projects, eq(successFees.projectId, projects.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(successFees.expectedDate));
    const data = rows.map((r) => ({
      ...this.presentSuccessFee(r.row),
      clientName: r.clientName,
      projectNumber: r.projectNumber,
    }));
    const open = data.filter((c) => c.status === "open");
    return {
      data,
      summary: {
        expectedFee: toDb(open.reduce((s, c) => s.plus(c.expectedFee), new Decimal(0))),
        weightedFee: toDb(open.reduce((s, c) => s.plus(c.weightedFee), new Decimal(0))),
      },
    };
  }

  /**
   * Settles it. Won: bills the percentage of what was achieved, or the fee given. Lost: nothing
   * was earned and nothing posts.
   */
  async settleSuccessFee(
    id: string,
    input: { outcome: "won" | "lost"; achievedAmount?: string; feeAmount?: string; date?: string }
  ) {
    const date = requireDate(input.date ?? today());
    return this.atomic(async (service) => {
      const [row] = await service.db.select().from(successFees).where(eq(successFees.id, id)).limit(1);
      if (!row) throw new AccountingError("Success fee not found", 404);
      if (row.status !== "open") throw new AccountingError("The success fee is already settled", 409);

      if (input.outcome === "lost") {
        const [settled] = await service.db
          .update(successFees)
          .set({ status: "lost", settledOn: date, updatedAt: new Date() })
          .where(and(eq(successFees.id, id), eq(successFees.status, "open")))
          .returning();
        await service.conta.recordAudit({
          action: "success_fee.lost",
          entityType: "success",
          entityId: id,
          summary: `Lost on ${date}`,
          detail: {},
        });
        return { successFee: service.presentSuccessFee(settled), invoice: null };
      }

      if (!input.achievedAmount && !input.feeAmount) {
        throw new AccountingError("A won success fee needs achievedAmount or feeAmount");
      }
      const settings = await service.getSettings();
      const decimals = await service.decimals(settings);
      const fee = input.feeAmount
        ? d(input.feeAmount)
        : roundTo(d(input.achievedAmount as string).times(row.percentage), decimals);
      const [project] = await service.db
        .select({ projectNumber: projects.number })
        .from(projects)
        .where(eq(projects.id, row.projectId))
        .limit(1);
      const invoice = await service.createInvoice({
        clientId: row.clientId,
        projectId: row.projectId,
        concept: `Success fee · ${project?.projectNumber ?? row.projectId}`,
        feeType: "success",
        issueDate: date,
        source: "success",
        issue: true,
        lines: [{ description: "Success fee on the amount achieved", unitPrice: toDb(fee) }],
      });
      const [settled] = await service.db
        .update(successFees)
        .set({
          status: "won",
          settledOn: date,
          achievedAmount: input.achievedAmount,
          invoiceId: invoice.id,
          updatedAt: new Date(),
        })
        .where(and(eq(successFees.id, id), eq(successFees.status, "open")))
        .returning();
      if (!settled) throw new AccountingError("The success fee is already settled", 409);
      await service.conta.recordAudit({
        action: "success_fee.won",
        entityType: "success",
        entityId: id,
        summary: `Won on ${date} · fee ${toDb(fee)}`,
        detail: { invoiceId: invoice.id },
      });
      return { successFee: service.presentSuccessFee(settled), invoice };
    });
  }

  // ── Bank reconciliation ─────────────────────────────────────────────────

  /** Loads statement lines. The same line twice (date, reference, amount) is skipped. */
  async importBankLines(input: {
    accountId?: string;
    lines: Array<{ date: string; description: string; reference?: string; amount: string }>;
  }) {
    for (const line of input.lines) requireDate(line.date);
    return this.atomic(async (service) => {
      const accountId = input.accountId ?? (await service.account("operatingBank"));
      const [account] = await service.db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
      if (!account) throw new AccountingError("Account not found", 404);
      if (account.type !== "asset") throw new AccountingError("A statement belongs to an asset account");
      const inserted = input.lines.length
        ? await service.db
            .insert(bankLines)
            .values(input.lines.map((l) => ({ ...l, accountId })))
            .onConflictDoNothing()
            .returning({ id: bankLines.id })
        : [];
      await service.conta.recordAudit({
        action: "bank.imported",
        entityType: "account",
        entityId: accountId,
        summary: `${inserted.length} statement lines imported into ${account.code}`,
        detail: { received: input.lines.length },
      });
      return { accountId, imported: inserted.length, skipped: input.lines.length - inserted.length };
    });
  }

  private async openInvoicesForMatching() {
    const rows = await this.db
      .select({
        id: invoices.id,
        number: invoices.number,
        clientName: counterparties.name,
        total: invoices.total,
        amountPaid: invoices.amountPaid,
      })
      .from(invoices)
      .innerJoin(counterparties, eq(invoices.clientId, counterparties.id))
      .where(sql`${invoices.status} = 'issued' AND ${invoices.total} > ${invoices.amountPaid}`)
      .orderBy(asc(invoices.dueDate));
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      clientName: r.clientName,
      balance: d(r.total).minus(r.amountPaid),
    }));
  }

  async listBankLines(filter: ListPage & { accountId?: string; pending?: boolean } = {}) {
    const { limit, offset } = paging(filter, 100);
    const conditions: SQL[] = [];
    if (filter.accountId) conditions.push(eq(bankLines.accountId, filter.accountId));
    if (filter.pending) conditions.push(isNull(bankLines.reconciledAt));
    const rows = await this.db
      .select()
      .from(bankLines)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(bankLines.date), desc(bankLines.createdAt))
      .limit(limit)
      .offset(offset);
    const open = rows.some((r) => !r.reconciledAt) ? await this.openInvoicesForMatching() : [];
    const { bankFeeKeywords } = await this.getSettings();
    return rows.map((line) => ({
      ...line,
      suggestion: line.reconciledAt ? null : suggestBankMatch(line, open, bankFeeKeywords),
    }));
  }

  async suggestForLine(id: string) {
    const [line] = await this.db.select().from(bankLines).where(eq(bankLines.id, id)).limit(1);
    if (!line) throw new AccountingError("Statement line not found", 404);
    if (line.reconciledAt) throw new AccountingError("The line is already reconciled", 409);
    const { bankFeeKeywords } = await this.getSettings();
    return suggestBankMatch(line, await this.openInvoicesForMatching(), bankFeeKeywords);
  }

  /**
   * Book against statement for one account. Lines still pending are what separates them, as the
   * statement balance is not imported: it is the book balance plus what the books have not seen.
   */
  async bankSummary(accountId?: string) {
    const id = accountId ?? (await this.account("operatingBank"));
    const [book] = await this.db
      .select({
        debit: sql<string>`coalesce(sum(${ledgerEntries.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${ledgerEntries.credit}), 0)`,
      })
      .from(ledgerEntries)
      .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
      .where(and(eq(ledgerEntries.accountId, id), inArray(journals.status, IN_THE_BOOKS)));
    const [lines] = await this.db
      .select({
        total: count(),
        pending: sql<string>`count(*) FILTER (WHERE ${bankLines.reconciledAt} IS NULL)`,
        pendingAmount: sql<string>`coalesce(sum(${bankLines.amount}) FILTER (WHERE ${bankLines.reconciledAt} IS NULL), 0)`,
      })
      .from(bankLines)
      .where(eq(bankLines.accountId, id));
    const bookBalance = d(book?.debit ?? 0).minus(book?.credit ?? 0);
    const pendingAmount = d(lines?.pendingAmount ?? 0);
    const total = Number(lines?.total ?? 0);
    const pending = Number(lines?.pending ?? 0);
    return {
      accountId: id,
      bookBalance: toDb(bookBalance),
      statementBalance: toDb(bookBalance.plus(pendingAmount)),
      difference: toDb(pendingAmount),
      pendingLines: pending,
      totalLines: total,
      progress: total ? Math.round(((total - pending) / total) * 100) : 100,
    };
  }

  /** Decides what a statement line is, and posts it if the books do not have it yet. */
  async reconcileLine(id: string, match: BankMatch) {
    return this.atomic(async (service) => {
      const [line] = await service.db.select().from(bankLines).where(eq(bankLines.id, id)).limit(1);
      if (!line) throw new AccountingError("Statement line not found", 404);

      const [claimed] = await service.db
        .update(bankLines)
        .set({ reconciledAt: new Date(), reconciledBy: RECONCILED_BY, matchKind: match.kind })
        .where(and(eq(bankLines.id, id), isNull(bankLines.reconciledAt)))
        .returning({ id: bankLines.id });
      if (!claimed) throw new AccountingError("The line is already reconciled", 409);

      const amount = d(line.amount);
      let matchLabel = "";
      let matchId: string | undefined;
      let journalId: string | undefined;

      if (match.kind === "invoice") {
        if (!amount.greaterThan(0)) throw new AccountingError("Only money in can pay an invoice");
        const { payment, invoice } = await service.recordPayment(match.invoiceId, {
          amount: amount.toFixed(4),
          date: line.date,
          accountId: line.accountId,
          method: "bank",
          reference: line.reference ?? undefined,
          bankLineId: id,
        });
        matchLabel = invoice.number ?? "";
        matchId = invoice.id;
        journalId = payment.journalId;
      } else if (match.kind === "fee") {
        if (!amount.isNegative()) throw new AccountingError("A bank charge takes money out");
        const [account] = await service.db.select().from(accounts).where(eq(accounts.id, line.accountId)).limit(1);
        if (account?.isClientFundsAccount) {
          throw new AccountingError("Bank charges cannot be paid from client funds", 409);
        }
        const settings = await service.getSettings();
        const value = toDb(amount.abs());
        const description = `Bank charge · ${line.description}`;
        const { journal } = await service.conta.createJournal({
          date: line.date,
          description,
          reference: line.reference ?? undefined,
          journalType: "bank_fee",
          status: "posted",
          metadata: { bankLineId: id },
          lines: [
            { accountId: await service.account("bankCharges"), debit: value, description, currency: settings.baseCurrency },
            { accountId: line.accountId, credit: value, description, currency: settings.baseCurrency },
          ],
        });
        matchLabel = "Bank charge";
        journalId = journal.id;
      } else if (match.kind === "client_funds") {
        if (!amount.greaterThan(0)) throw new AccountingError("Only money in can be client funds");
        const { journal } = await service.clientFundsDeposit({
          clientId: match.clientId,
          projectId: match.projectId,
          amount: amount.toFixed(4),
          date: line.date,
          description: `Funds identified on the statement · ${line.description}`,
          reference: line.reference ?? undefined,
        });
        const client = await service.requireClient(match.clientId);
        matchLabel = `Client funds · ${client.name}`;
        matchId = client.id;
        journalId = journal.id;
        // Client money that landed in an own account moves to the client funds bank at once: the books
        // record it there, and this second line nets the operating statement back to zero.
        const clientFundsBank = await service.account("clientFundsBank");
        if (line.accountId !== clientFundsBank) {
          await service.db.insert(bankLines).values({
            accountId: line.accountId,
            date: line.date,
            description: "Transfer to the client funds account",
            reference: line.reference ? `${line.reference}-FUNDS` : null,
            amount: toDb(amount.negated()),
            matchKind: "transfer",
            matchLabel: "Internal transfer to the client funds bank",
            matchId: journal.id,
            journalId: journal.id,
            reconciledAt: new Date(),
            reconciledBy: RECONCILED_BY,
          });
        }
      } else {
        const rows = await service.db
          .select({ debit: ledgerEntries.debit, credit: ledgerEntries.credit, status: journals.status })
          .from(ledgerEntries)
          .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
          .where(and(eq(ledgerEntries.journalId, match.journalId), eq(ledgerEntries.accountId, line.accountId)));
        if (rows.length === 0) throw new AccountingError("That journal does not move this account", 404);
        if (rows[0].status !== "posted") throw new AccountingError("Only a posted journal can be matched", 409);
        const net = rows.reduce((s, r) => s.plus(r.debit).minus(r.credit), new Decimal(0));
        if (!net.equals(amount)) {
          throw new AccountingError(
            `The journal moves this account by ${net.toFixed(2)}, the line by ${amount.toFixed(2)}`,
            409
          );
        }
        matchLabel = `Journal ${match.journalId}`;
        matchId = match.journalId;
        journalId = match.journalId;
      }

      const [updated] = await service.db
        .update(bankLines)
        .set({ matchLabel, matchId, journalId })
        .where(eq(bankLines.id, id))
        .returning();
      await service.conta.recordAudit({
        action: "bank.reconciled",
        entityType: "bank_line",
        entityId: id,
        summary: `${line.description} · ${line.amount} → ${matchLabel}`,
        detail: { kind: match.kind, journalId: journalId ?? null },
      });
      return updated;
    });
  }

  /** Accepts every high-confidence suggestion. A line that fails stays pending and is reported. */
  async reconcileSuggested(options: { accountId?: string } = {}) {
    const lines = await this.listBankLines({ accountId: options.accountId, pending: true, limit: 500 });
    const reconciled: string[] = [];
    const failed: Array<{ lineId: string; message: string }> = [];
    for (const line of lines) {
      if (line.suggestion?.confidence !== "high") continue;
      const match: BankMatch =
        line.suggestion.kind === "invoice"
          ? { kind: "invoice", invoiceId: line.suggestion.invoiceId as string }
          : { kind: "fee" };
      try {
        await this.reconcileLine(line.id, match);
        reconciled.push(line.id);
      } catch (err) {
        if (!(err instanceof AccountingError)) throw err;
        failed.push({ lineId: line.id, message: err.message });
      }
    }
    return { reconciled, failed };
  }

  // ── Audit trail ─────────────────────────────────────────────────────────

  async listAudit(
    filter: ListPage & {
      action?: string;
      entityType?: string;
      entityId?: string;
      q?: string;
      dateFrom?: string;
      dateTo?: string;
    } = {}
  ) {
    const { limit, page, offset } = paging(filter);
    const conditions: Array<SQL | undefined> = [];
    if (filter.action) conditions.push(eq(auditLog.action, filter.action));
    if (filter.entityType) conditions.push(eq(auditLog.entityType, filter.entityType));
    if (filter.entityId) conditions.push(eq(auditLog.entityId, filter.entityId));
    if (filter.dateFrom) conditions.push(sql`${auditLog.at} >= ${filter.dateFrom}::date`);
    if (filter.dateTo) conditions.push(sql`${auditLog.at} < (${filter.dateTo}::date + 1)`);
    if (filter.q) {
      const like = `%${filter.q}%`;
      conditions.push(or(ilike(auditLog.summary, like), ilike(auditLog.action, like)));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const data = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(limit)
      .offset(offset);
    const [{ total }] = await this.db.select({ total: count() }).from(auditLog).where(where);
    return {
      data,
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    };
  }
}
