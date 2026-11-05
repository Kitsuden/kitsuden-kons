/**
 * ContaService — General Ledger Engine
 *
 * Principles:
 *   - All monetary arithmetic uses Decimal.js (never JS Number floats).
 *   - T-accounts are computed views, not stored tables.
 *   - Journal templates translate business events into ledger entries.
 *   - metadata (JSONB) carries all domain-specific data.
 */

import dayjs from "dayjs";
import { Decimal } from "decimal.js";
import { eq, and, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  accounts,
  journals,
  ledgerEntries,
  disbursements,
  journalTemplates,
  currencies,
  counterparties,
  contaSettings,
  auditLog,
  projects,
  DEFAULT_ACCOUNT_CODES,
  DEFAULT_LABELS,
  LABEL_KEYS,
  type AccountRole,
  type BillingType,
  type Labels,
  type ContaSettings,
  type Account,
  type Journal,
  type LedgerEntry,
  type Disbursement,
} from "./conta.schema";
import type { ContaDb } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Decimal Helpers
// ═══════════════════════════════════════════════════════════════════════════

export function d(val: string | number | Decimal): Decimal {
  return new Decimal(val);
}

function zero(): Decimal {
  return new Decimal(0);
}

export function toDb(val: Decimal): string {
  return val.toFixed(4);
}

/** A real calendar date in YYYY-MM-DD: the format alone lets 2026-02-31 through. */
export function isRealDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && dayjs(value).format("YYYY-MM-DD") === value;
}

/**
 * Journals that count in the books. A reversed journal still happened: its reversal is the entry
 * that cancels it, each on its own date. Counting only `posted` left the counter-entry alone in the
 * reports and turned a reversed 100 into -100.
 */
export const IN_THE_BOOKS: Journal["status"][] = ["posted", "reversed"];

// ═══════════════════════════════════════════════════════════════════════════
// Balance Direction
// ═══════════════════════════════════════════════════════════════════════════

function getNormalBalance(type: Account["type"]): 1 | -1 {
  return type === "asset" || type === "expense" ? 1 : -1;
}

function computeBalance(
  openingBalance: string | Decimal,
  type: Account["type"],
  debits: string | Decimal,
  credits: string | Decimal
): Decimal {
  const normal = getNormalBalance(type);
  return d(openingBalance).plus(d(debits).minus(d(credits)).times(normal));
}

// ═══════════════════════════════════════════════════════════════════════════
// Validation Engine
// ═══════════════════════════════════════════════════════════════════════════

export interface ValidationResult {
  ok: boolean;
  totalDebits: Decimal;
  totalCredits: Decimal;
  errors: string[];
}

export function validateLedgerLines(
  lines: Array<{
    debit: string | Decimal;
    credit: string | Decimal;
    currency?: string | null;
    exchangeRate?: string | number | Decimal | null;
  }>
): ValidationResult {
  const errors: string[] = [];

  // One journal, one currency (an earlier audit). Balances and reports
  // add up amounts without converting, so 100 USD in debit against 100 EUR in
  // credit "balanced" and unbalanced everything else. A currency exchange is
  // recorded with separate journals in each currency.
  const currenciesValue = new Set(lines.map((l) => String(l.currency || "USD").toUpperCase()));
  if (currenciesValue.size > 1) {
    errors.push(`A journal entry must use a single currency (found: ${[...currenciesValue].join(", ")})`);
  }
  const types = new Set(lines.map((l) => d(l.exchangeRate || 1).toString()));
  if (types.size > 1) {
    errors.push("All lines of a journal entry must use the same exchange rate");
  }
  const totalDebits = lines.reduce((sum, line) => sum.plus(d(line.debit)), zero());
  const totalCredits = lines.reduce((sum, line) => sum.plus(d(line.credit)), zero());

  if (!totalDebits.equals(totalCredits)) {
    errors.push(
      `Unbalanced: debits (${totalDebits.toString()}) != credits (${totalCredits.toString()})`
    );
  }

  if (lines.length < 2) {
    errors.push("A journal entry must have at least two ledger lines");
  }

  for (let i = 0; i < lines.length; i++) {
    const hasDebit = d(lines[i].debit).greaterThan(0);
    const hasCredit = d(lines[i].credit).greaterThan(0);
    if (hasDebit && hasCredit) {
      errors.push(`Line ${i + 1} cannot have both debit and credit`);
    }
    if (!hasDebit && !hasCredit) {
      errors.push(`Line ${i + 1} must have either debit or credit`);
    }
  }

  return { ok: errors.length === 0, totalDebits, totalCredits, errors };
}

// ═══════════════════════════════════════════════════════════════════════════
// Template Engine
// ═══════════════════════════════════════════════════════════════════════════

export interface TemplateVariables {
  total?: string | number | Decimal;
  amount?: string | number | Decimal;
  taxRate?: string | number | Decimal;
  [key: string]: any;
}

/**
 * Accounting business error: its message is written for the client
 * ("Journal already posted", "Account not found"…). Any other exception
 * — from Postgres, from a bug — does NOT reach the client with its text: the route answers
 * a generic 500 and the detail goes to the log.
 */
export class AccountingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message);
    this.name = "AccountingError";
  }
}

/**
 * Evaluates + - * / and parentheses with Decimal, WITHOUT `eval` or `new Function`.
 *
 * Before, the expression, after a character filter, ended up in
 * `new Function("return (" + expression + ")")`: correct as long as the filter was,
 * but it is executing text that comes in over HTTP (a template's
 * formulas are written by a user) and floating-point arithmetic in a general
 * ledger. Now it is a recursive descent parser: only numbers,
 * operators and parentheses, with a cap on length and nesting.
 */
const MAX_FORMULA = 500;
const MAX_NESTING = 32;

function safeEvaluateArithmetic(expression: string): Decimal {
  if (expression.length > MAX_FORMULA) throw new AccountingError("Formula too long");
  const tokens = expression.match(/\d+(?:\.\d+)?|[+\-*/()]/g) ?? [];
  if (tokens.join("") !== expression.replace(/\s+/g, "")) {
    throw new AccountingError("Invalid arithmetic expression");
  }
  let i = 0;
  let depth = 0;

  const primary = (): Decimal => {
    const t = tokens[i++];
    if (t === undefined) throw new AccountingError("Invalid arithmetic expression");
    if (t === "-") return primary().negated();
    if (t === "+") return primary();
    if (t === "(") {
      if (++depth > MAX_NESTING) throw new AccountingError("Formula too deeply nested");
      const v = sumValue();
      if (tokens[i++] !== ")") throw new AccountingError("Invalid arithmetic expression");
      depth--;
      return v;
    }
    if (/^\d/.test(t)) return d(t);
    throw new AccountingError("Invalid arithmetic expression");
  };
  const product = (): Decimal => {
    let v = primary();
    while (tokens[i] === "*" || tokens[i] === "/") {
      const op = tokens[i++];
      const r = primary();
      if (op === "/" && r.isZero()) throw new AccountingError("Division by zero in formula");
      v = op === "*" ? v.times(r) : v.dividedBy(r);
    }
    return v;
  };
  function sumValue(): Decimal {
    let v = product();
    while (tokens[i] === "+" || tokens[i] === "-") {
      const op = tokens[i++];
      const r = product();
      v = op === "+" ? v.plus(r) : v.minus(r);
    }
    return v;
  }

  const resultValue = sumValue();
  if (i !== tokens.length || !resultValue.isFinite()) {
    throw new AccountingError("Formula evaluation resulted in invalid number");
  }
  return resultValue;
}

export function evaluateFormula(formula: string, variables: TemplateVariables): Decimal {
  const scope: Record<string, Decimal> = Object.assign(
    Object.create(null) as Record<string, Decimal>,
    {
      total: d(variables.total ?? 0),
      amount: d(variables.amount ?? 0),
      taxRate: d(variables.taxRate ?? 0),
    }
  );

  for (const [key, value] of Object.entries(variables)) {
    // Only normal variable names: no `__proto__` or anything that is not an
    // identifier (the name ends up inside a regular expression).
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || key === "__proto__") continue;
    if (!Object.prototype.hasOwnProperty.call(scope, key)) {
      scope[key] = d(value ?? 0);
    }
  }

  // Replace known variable names in the formula
  let expression = formula.trim();
  for (const [key, val] of Object.entries(scope)) {
    // Escape regex special characters in variable names
    const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expression = expression.replace(new RegExp(`\\b${safeKey}\\b`, "g"), val.toString());
  }

  // Only allow numbers, operators, parentheses and spaces
  if (!/^[\d\+\-\*\/\.\(\)\s]+$/.test(expression)) {
    throw new AccountingError("Invalid formula characters");
  }

  // Safe arithmetic evaluation (no eval)
  return safeEvaluateArithmetic(expression);
}

export async function applyJournalTemplate(
  db: ContaDb,
  templateId: string,
  variables: TemplateVariables,
  baseMetadata: Record<string, unknown> = {}
): Promise<{
  lines: Array<{
    accountId: string;
    description?: string;
    debit: string;
    credit: string;
    metadata?: Record<string, unknown>;
  }>;
  totalAmount: string;
}> {
  const [template] = await db
    .select()
    .from(journalTemplates)
    .where(eq(journalTemplates.id, templateId))
    .limit(1);

  if (!template) throw new AccountingError("Journal template not found", 404);

  for (const key of template.requiredMetadata || []) {
    if (!(key in baseMetadata)) {
      throw new AccountingError(`Missing required metadata field: ${key}`);
    }
  }

  const lines: Array<{
    accountId: string;
    description?: string;
    debit: string;
    credit: string;
    metadata?: Record<string, unknown>;
  }> = [];

  for (const rule of template.rules) {
    const [account] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.code, rule.accountCode))
      .limit(1);

    if (!account) {
      throw new AccountingError(`Account with code ${rule.accountCode} not found`);
    }

    const amount = evaluateFormula(rule.amountFormula, variables);
    lines.push({
      accountId: account.id,
      description: rule.description,
      debit: rule.side === "debit" ? toDb(amount) : "0.0000",
      credit: rule.side === "credit" ? toDb(amount) : "0.0000",
      metadata: baseMetadata,
    });
  }

  const totalDebits = lines.reduce((sum, line) => sum.plus(d(line.debit)), zero());
  return { lines, totalAmount: toDb(totalDebits) };
}

// ═══════════════════════════════════════════════════════════════════════════
// ContaService
// ═══════════════════════════════════════════════════════════════════════════

export class ContaService {
  constructor(private db: ContaDb) {}

  /**
   * All or nothing. Inside a request this is a savepoint of the request's transaction: a 409 is
   * a normal response, and the host commits normal responses, so a step that already wrote would
   * survive the refusal of the next one. Outside a request it is a transaction of its own.
   */
  private atomic<T>(fn: (service: ContaService) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new ContaService(tx as unknown as ContaDb)));
  }

  // ── Audit trail ─────────────────────────────────────────────────────────

  /**
   * One line in the append-only trail. The actor is whoever the RLS context says, unless a caller
   * running as the system (a bridge from another kon) names the person it acts for.
   */
  async recordAudit(entry: {
    action: string;
    summary: string;
    entityType?: string;
    entityId?: string;
    detail?: Record<string, unknown>;
    actorId?: string | null;
  }): Promise<void> {
    await this.db.insert(auditLog).values({
      action: entry.action,
      summary: entry.summary,
      entityType: entry.entityType,
      entityId: entry.entityId,
      detail: entry.detail ?? {},
      ...(entry.actorId ? { actorId: entry.actorId } : {}),
    });
  }

  // ── Settings ────────────────────────────────────────────────────────────

  /** The configuration row, with the defaults under whatever this installation changed. */
  async getSettings(): Promise<
    ContaSettings & { accountCodes: Record<AccountRole, string>; labels: Labels }
  > {
    const [row] = await this.db.select().from(contaSettings).limit(1);
    if (!row) throw new AccountingError("Accounting settings are missing: run the kon's migrations");
    const labels = Object.fromEntries(
      LABEL_KEYS.map((key) => [key, { ...DEFAULT_LABELS[key], ...(row.labels?.[key] ?? {}) }])
    ) as Labels;
    return { ...row, accountCodes: { ...DEFAULT_ACCOUNT_CODES, ...row.accountCodes }, labels };
  }

  /** Refuses a billing type this installation does not offer. */
  async assertBillingType(type: BillingType): Promise<void> {
    const { billingTypes } = await this.getSettings();
    if (!billingTypes.includes(type)) {
      throw new AccountingError(`Billing type ${type} is not offered here (${billingTypes.join(", ")})`);
    }
  }

  /** The account a kind of movement posts to, as configured here. */
  async accountIdFor(role: AccountRole): Promise<string> {
    const { accountCodes } = await this.getSettings();
    return this.resolveAccountCode(accountCodes[role]);
  }

  // ── What every posting must pass ────────────────────────────────────────

  /**
   * The last closed date. Read with a share lock: closing a period waits for the postings in
   * flight, and whatever starts after the close sees it.
   */
  async getLockedUntil(): Promise<string | null> {
    const [row] = await this.db
      .select({ lockedUntil: contaSettings.lockedUntil })
      .from(contaSettings)
      .limit(1)
      .for("share");
    return row?.lockedUntil ?? null;
  }

  private async assertPeriodOpen(date: string): Promise<void> {
    if (!isRealDate(date)) throw new AccountingError(`Invalid journal date: ${date}`);
    const lockedUntil = await this.getLockedUntil();
    if (lockedUntil && date <= lockedUntil) {
      throw new AccountingError(
        `The period up to ${lockedUntil} is closed: nothing can be posted on ${date}`,
        409
      );
    }
  }

  /** What is held for this client, read from the ledger: there is no second copy. */
  async getClientFundsHeld(clientId: string): Promise<Decimal> {
    const [row] = await this.db
      .select({ balance: sql<string>`coalesce(sum(${ledgerEntries.credit} - ${ledgerEntries.debit}), 0)` })
      .from(ledgerEntries)
      .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
      .innerJoin(accounts, eq(ledgerEntries.accountId, accounts.id))
      .where(
        and(
          eq(journals.counterpartyId, clientId),
          eq(accounts.isClientFundsAccount, true),
          eq(accounts.type, "liability"),
          inArray(journals.status, IN_THE_BOOKS)
        )
      );
    return d(row?.balance ?? 0);
  }

  /**
   * Client funds. A movement on a client funds liability must say whose money it is, and nothing can take
   * out more than that client holds: another client's funds are not available. This sits in the
   * posting path, so manual journals, reversals and every operation go through the same rule. The
   * client row is locked first, so two withdrawals cannot both read the same balance.
   */
  private async assertClientFundsRules(
    lines: Array<{ accountId: string; debit: string | Decimal; credit: string | Decimal }>,
    counterpartyId: string | null | undefined
  ): Promise<void> {
    const ids = [...new Set(lines.map((l) => l.accountId))];
    if (ids.length === 0) return;
    const held = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(inArray(accounts.id, ids), eq(accounts.isClientFundsAccount, true), eq(accounts.type, "liability")));
    if (held.length === 0) return;
    if (!counterpartyId) {
      throw new AccountingError("A movement on a client funds account must name the client (counterpartyId)");
    }
    const clientFundsIds = new Set(held.map((t: { id: string }) => t.id));
    const change = lines
      .filter((l) => clientFundsIds.has(l.accountId))
      .reduce((sum, l) => sum.plus(d(l.credit)).minus(d(l.debit)), zero());
    if (!change.isNegative()) return;

    await this.db
      .select({ id: counterparties.id })
      .from(counterparties)
      .where(eq(counterparties.id, counterpartyId))
      .limit(1)
      .for("update");
    const balance = await this.getClientFundsHeld(counterpartyId);
    if (balance.plus(change).isNegative()) {
      throw new AccountingError(
        `Client funds overdraft refused: the client holds ${balance.toFixed(2)} and this takes ${change.abs().toFixed(2)}. Funds of another client cannot be used.`,
        409
      );
    }
  }

  // ── Currencies ──────────────────────────────────────────────────────────

  async seedCurrencies(): Promise<void> {
    const defaults = [
      { code: "USD", name: "US Dollar", symbol: "$", decimalPlaces: 2 },
      { code: "EUR", name: "Euro", symbol: "€", decimalPlaces: 2 },
      { code: "PAB", name: "Panamanian Balboa", symbol: "B/.", decimalPlaces: 2 },
    ];

    for (const c of defaults) {
      const exists = await this.db
        .select({ code: currencies.code })
        .from(currencies)
        .where(eq(currencies.code, c.code))
        .limit(1);
      if (exists.length === 0) {
        await this.db.insert(currencies).values(c);
      }
    }
  }

  // ── Accounts ────────────────────────────────────────────────────────────

  async seedDefaultAccounts(): Promise<void> {
    await this.seedCurrencies();

    const defaults: Array<{
      code: string;
      name: string;
      type: Account["type"];
      isClientFundsAccount?: boolean;
    }> = [
      { code: "1000", name: "Cash", type: "asset" },
      { code: "1100", name: "Bank - Operating", type: "asset" },
      { code: "1150", name: "Bank - Client Funds", type: "asset", isClientFundsAccount: true },
      { code: "1200", name: "Accounts Receivable - Clients", type: "asset" },
      { code: "1250", name: "Disbursements Receivable", type: "asset" },
      { code: "1500", name: "Furniture and Equipment", type: "asset" },
      { code: "2000", name: "Accounts Payable", type: "liability" },
      { code: "2100", name: "Client Funds Held", type: "liability", isClientFundsAccount: true },
      { code: "2200", name: "Taxes Payable", type: "liability" },
      { code: "3000", name: "Owner's Equity", type: "equity" },
      { code: "3100", name: "Retained Earnings", type: "equity" },
      { code: "4000", name: "Service Revenue", type: "revenue" },
      { code: "4100", name: "Recurring Fee Revenue", type: "revenue" },
      { code: "4200", name: "Success Fee Revenue", type: "revenue" },
      { code: "5000", name: "Cost of Services", type: "expense" },
      { code: "5100", name: "Salaries and Wages", type: "expense" },
      { code: "6000", name: "Operating Expenses", type: "expense" },
      { code: "6100", name: "Bank Charges", type: "expense" },
    ];

    for (const acc of defaults) {
      const exists = await this.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.code, acc.code))
        .limit(1);

      if (exists.length === 0) {
        await this.db.insert(accounts).values({
          code: acc.code,
          name: acc.name,
          type: acc.type,
          isClientFundsAccount: acc.isClientFundsAccount || false,
          openingBalance: "0.0000",
          currentBalance: "0.0000",
        });
      }
    }
  }

  // ── Journal Entry Creation ──────────────────────────────────────────────

  async createJournal(input: {
    date: string;
    description: string;
    reference?: string;
    counterpartyId?: string;
    journalType?: Journal["journalType"];
    templateId?: string;
    metadata?: Record<string, unknown>;
    status?: Journal["status"];
    /** Only for a caller running as the system: whose action this is, for the audit trail. */
    createdBy?: string | null;
    reversalOfId?: string;
    lines: Array<{
      accountId: string;
      projectId?: string;
      description?: string;
      debit?: string | number | Decimal;
      credit?: string | number | Decimal;
      currency?: string;
      exchangeRate?: string | number | Decimal;
      metadata?: Record<string, unknown>;
    }>;
  }): Promise<{ journal: Journal; lines: LedgerEntry[] }> {
    const validation = validateLedgerLines(
      input.lines.map((l) => ({
        debit: d(l.debit || 0),
        credit: d(l.credit || 0),
        currency: l.currency,
        exchangeRate: l.exchangeRate,
      }))
    );
    if (!validation.ok) {
      throw new AccountingError(validation.errors.join("; "));
    }

    const status = input.status || "draft";
    const totalAmount = toDb(validation.totalDebits);

    return this.atomic(async (service) => {
      if (status === "posted") {
        await service.assertPeriodOpen(input.date);
        await service.assertClientFundsRules(
          input.lines.map((l) => ({
            accountId: l.accountId,
            debit: d(l.debit || 0),
            credit: d(l.credit || 0),
          })),
          input.counterpartyId
        );
      }
      return service.insertJournal(input, status, totalAmount);
    });
  }

  /** The only place that writes a journal. Reached through `createJournal`, after its checks. */
  private async insertJournal(
    input: Parameters<ContaService["createJournal"]>[0],
    status: Journal["status"],
    totalAmount: string
  ): Promise<{ journal: Journal; lines: LedgerEntry[] }> {
    const [journal] = await this.db
      .insert(journals)
      .values({
        date: input.date,
        description: input.description,
        reference: input.reference,
        counterpartyId: input.counterpartyId,
        totalAmount,
        status,
        journalType: input.journalType || "standard",
        templateId: input.templateId,
        metadata: input.metadata || {},
        reversalOfId: input.reversalOfId,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      })
      .returning();

    const lineValues = input.lines.map((line) => ({
      journalId: journal.id,
      accountId: line.accountId,
      projectId: line.projectId || null,
      description: line.description || input.description,
      debit: toDb(d(line.debit || 0)),
      credit: toDb(d(line.credit || 0)),
      currency: line.currency || "USD",
      exchangeRate: toDb(d(line.exchangeRate || 1)),
      metadata: line.metadata || {},
    }));

    const createdLines = await this.db.insert(ledgerEntries).values(lineValues).returning();

    if (status === "posted") {
      await this.applyBalances(journal.id);
      await this.recordAudit({
        action: "journal.posted",
        entityType: "journal",
        entityId: journal.id,
        summary: `${input.description} · ${totalAmount}`,
        detail: { date: input.date, reference: input.reference ?? null, journalType: journal.journalType },
        actorId: input.createdBy,
      });
    }

    return { journal, lines: createdLines };
  }

  // ── Opening balance ─────────────────────────────────────────────────────

  /**
   * An account's opening balance, as a JOURNAL against equity
   * (account 3000) and not written by hand into `currentBalance` (an earlier
   * audit): this way the account, the ledger and the balance sheet balance, and the balance
   * has a trace. It posts it: `applyBalances` moves the two accounts.
   */
  async openWithBalance(accountId: string, amountValue: string | number | Decimal, date?: string) {
    const valueValue = d(amountValue);
    if (valueValue.isZero()) return null;
    const [accountValue] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!accountValue) throw new AccountingError("Account not found", 404);
    const equityTotal = await this.resolveAccountCode("3000");
    if (equityTotal === accountId) {
      throw new AccountingError("The equity account cannot open against itself", 409);
    }
    // On the account's "normal" side: an asset opens as a debit, a liability as a credit.
    const toDebit = getNormalBalance(accountValue.type) > 0 ? valueValue.isPositive() : valueValue.isNegative();
    const abs = valueValue.abs();
    return this.createJournal({
      date: date || dayjs().format("YYYY-MM-DD"),
      description: `Opening balance: ${accountValue.code} ${accountValue.name}`,
      reference: `OPEN-${accountValue.code}`,
      journalType: "standard",
      status: "posted",
      lines: [
        { accountId, debit: toDebit ? abs : 0, credit: toDebit ? 0 : abs },
        { accountId: equityTotal, debit: toDebit ? 0 : abs, credit: toDebit ? abs : 0 },
      ],
    });
  }

  // ── Posting & Reversal ──────────────────────────────────────────────────

  async postJournal(journalId: string): Promise<Journal> {
    const [entry] = await this.db
      .select()
      .from(journals)
      .where(eq(journals.id, journalId))
      .limit(1);

    if (!entry) throw new AccountingError("Journal not found", 404);
    if (entry.status === "posted") throw new AccountingError("Journal already posted", 409);
    if (entry.status === "reversed") throw new AccountingError("Cannot post a reversed journal", 409);

    const lines = await this.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.journalId, journalId));

    const validation = validateLedgerLines(lines);
    if (!validation.ok) {
      throw new AccountingError(validation.errors.join("; "));
    }

    return this.atomic(async (service) => {
      await service.assertPeriodOpen(entry.date);
      await service.assertClientFundsRules(lines, entry.counterpartyId);

      // The journal is CLAIMED before touching balances: two simultaneous requests
      // both passed the check above and applied the balances twice
      // (an earlier audit). Only one gets the row.
      const [updated] = await service.db
        .update(journals)
        .set({ status: "posted", updatedAt: new Date() })
        .where(and(eq(journals.id, journalId), sql`${journals.status} NOT IN ('posted', 'reversed')`))
        .returning();
      if (!updated) throw new AccountingError("Journal already posted", 409);

      await service.applyBalances(journalId);
      await service.recordAudit({
        action: "journal.posted",
        entityType: "journal",
        entityId: journalId,
        summary: `${entry.description} · ${entry.totalAmount}`,
        detail: { date: entry.date, reference: entry.reference ?? null, journalType: entry.journalType },
      });

      return updated;
    });
  }

  async reverseJournal(
    journalId: string,
    reversalDate?: string,
    options?: { journalType?: Journal["journalType"]; reference?: string; description?: string }
  ): Promise<{ original: Journal; reversal: Journal }> {
    return this.atomic((service) => service.reverseInside(journalId, reversalDate, options));
  }

  private async reverseInside(
    journalId: string,
    reversalDate: string | undefined,
    options: { journalType?: Journal["journalType"]; reference?: string; description?: string } | undefined
  ): Promise<{ original: Journal; reversal: Journal }> {
    const [entry] = await this.db
      .select()
      .from(journals)
      .where(eq(journals.id, journalId))
      .limit(1);

    if (!entry) throw new AccountingError("Journal not found", 404);
    // Only what is POSTED is reversed. Reversing a draft applied to the
    // balances the counter-entry of something that was never applied, and reversing
    // the same journal twice deducted it twice.
    if (entry.status !== "posted") {
      throw new AccountingError("Only posted journals can be reversed", 409);
    }

    // Atomic claim (see `postJournal`): two simultaneous reversals
    // created two posted counter-entries (an earlier audit).
    const [original] = await this.db
      .update(journals)
      .set({ status: "reversed", updatedAt: new Date() })
      .where(and(eq(journals.id, journalId), eq(journals.status, "posted")))
      .returning();
    if (!original) throw new AccountingError("Only posted journals can be reversed", 409);

    const lines = await this.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.journalId, journalId));

    const reversalLines = lines.map((line: LedgerEntry) => ({
      accountId: line.accountId,
      projectId: line.projectId || undefined,
      description: `Reversal: ${line.description}`,
      debit: line.credit,
      credit: line.debit,
      currency: line.currency,
      exchangeRate: line.exchangeRate,
      metadata: { ...line.metadata, reversalOfLine: line.id },
    }));

    const reversal = await this.createJournal({
      date: reversalDate || entry.date,
      description: options?.description ?? `Reversal of journal ${entry.reference || entry.id}`,
      reference: options?.reference ?? `REV-${entry.reference || entry.id}`,
      counterpartyId: entry.counterpartyId || undefined,
      journalType: options?.journalType ?? entry.journalType,
      status: "posted",
      reversalOfId: journalId,
      lines: reversalLines,
    });

    await this.recordAudit({
      action: "journal.reversed",
      entityType: "journal",
      entityId: journalId,
      summary: `${entry.description} · reversed by ${reversal.journal.id}`,
      detail: { reversalId: reversal.journal.id, date: reversal.journal.date },
    });

    return { original, reversal: reversal.journal };
  }

  // ── Balance Application ─────────────────────────────────────────────────

  private async applyBalances(journalId: string): Promise<void> {
    const lines = await this.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.journalId, journalId));

    for (const line of lines) {
      const [account] = await this.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, line.accountId))
        .limit(1);

      if (!account) continue;

      const normal = getNormalBalance(account.type);
      const delta = d(line.debit).minus(line.credit).times(normal);

      // Add in the DATABASE, not "read, add and write": two simultaneous journals
      // on the same account lost one of the two (an earlier audit).
      await this.db
        .update(accounts)
        .set({
          currentBalance: sql`${accounts.currentBalance} + ${toDb(delta)}::numeric`,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, line.accountId));
    }
  }

  async recalculateAccountBalance(accountId: string): Promise<Decimal> {
    const [account] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account) throw new AccountingError("Account not found", 404);

    const result = await this.db
      .select({
        totalDebit: sql<string>`coalesce(sum(${ledgerEntries.debit}), 0)`,
        totalCredit: sql<string>`coalesce(sum(${ledgerEntries.credit}), 0)`,
      })
      .from(ledgerEntries)
      .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
      .where(and(eq(ledgerEntries.accountId, accountId), inArray(journals.status, IN_THE_BOOKS)));

    const balance = computeBalance(
      account.openingBalance,
      account.type,
      result[0].totalDebit,
      result[0].totalCredit
    );

    await this.db
      .update(accounts)
      .set({ currentBalance: toDb(balance), updatedAt: new Date() })
      .where(eq(accounts.id, accountId));

    return balance;
  }

  // ── T-Account View ──────────────────────────────────────────────────────

  async getTAccount(
    accountId: string,
    options?: {
      dateFrom?: string;
      dateTo?: string;
      projectId?: string;
      currency?: string;
    }
  ): Promise<{
    account: Account;
    openingBalance: Decimal;
    movements: Array<{
      date: string;
      description: string;
      reference?: string;
      journalId: string;
      projectId?: string;
      debit: Decimal;
      credit: Decimal;
      balance: Decimal;
      metadata?: Record<string, unknown>;
    }>;
    closingBalance: Decimal;
  }> {
    const [account] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account) throw new AccountingError("Account not found", 404);

    const conditions = [eq(ledgerEntries.accountId, accountId), inArray(journals.status, IN_THE_BOOKS)];

    if (options?.dateFrom) conditions.push(gte(journals.date, options.dateFrom));
    if (options?.dateTo) conditions.push(lte(journals.date, options.dateTo));
    if (options?.projectId) conditions.push(eq(ledgerEntries.projectId, options.projectId));
    if (options?.currency) conditions.push(eq(ledgerEntries.currency, options.currency));

    const rows = await this.db
      .select({
        id: ledgerEntries.id,
        date: journals.date,
        description: ledgerEntries.description,
        reference: journals.reference,
        journalId: journals.id,
        projectId: ledgerEntries.projectId,
        debit: ledgerEntries.debit,
        credit: ledgerEntries.credit,
        metadata: ledgerEntries.metadata,
      })
      .from(ledgerEntries)
      .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
      .where(and(...conditions))
      .orderBy(journals.date, journals.createdAt);

    let runningBalance = d(account.openingBalance);
    const movements = rows.map((row: any) => {
      const normal = getNormalBalance(account.type);
      runningBalance = runningBalance.plus(d(row.debit).minus(row.credit).times(normal));
      return {
        date: row.date,
        description: row.description,
        reference: row.reference,
        journalId: row.journalId,
        projectId: row.projectId,
        debit: d(row.debit),
        credit: d(row.credit),
        balance: runningBalance,
        metadata: row.metadata,
      };
    });

    return {
      account,
      openingBalance: d(account.openingBalance),
      movements,
      closingBalance: runningBalance,
    };
  }

  // ── Client funds accounts ────────────────────────────────────────────────────

  async getClientFundsAccountBalance(
    clientFundsAccountId: string,
    projectId?: string
  ): Promise<{
    account: Account;
    projectId?: string;
    balance: Decimal;
    movements: Array<{
      date: string;
      description: string;
      debit: Decimal;
      credit: Decimal;
      balance: Decimal;
      metadata?: Record<string, unknown>;
    }>;
  }> {
    const [account] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, clientFundsAccountId), eq(accounts.isClientFundsAccount, true)))
      .limit(1);

    if (!account) throw new AccountingError("Client funds account not found", 404);

    const tAccount = await this.getTAccount(clientFundsAccountId, projectId ? { projectId } : undefined);

    return {
      account,
      projectId,
      balance: tAccount.closingBalance,
      movements: tAccount.movements,
    };
  }

  // ── Disbursements ───────────────────────────────────────────────────────

  async createDisbursement(input: {
    projectId: string;
    description: string;
    amount: string | number | Decimal;
    paidFromAccountId: string;
    metadata?: Record<string, unknown>;
    date?: string;
    category?: string;
    externalRef?: string;
    createdBy?: string | null;
  }): Promise<{ disbursement: Disbursement; journal: Journal; lines: LedgerEntry[] }> {
    if (!d(input.amount).isPositive() || d(input.amount).isZero()) {
      throw new AccountingError("A disbursement must be greater than zero");
    }
    const [paidFrom] = await this.db
      .select({ isClientFunds: accounts.isClientFundsAccount })
      .from(accounts)
      .where(eq(accounts.id, input.paidFromAccountId))
      .limit(1);
    // Client funds leave through the client funds operations, which check the client's balance.
    if (paidFrom?.isClientFunds) {
      throw new AccountingError("Use a client funds disbursement to pay from a client funds account");
    }
    const [project] = await this.db
      .select({ clientId: projects.clientId })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!project) throw new AccountingError("Project not found", 404);

    const amountStr = toDb(d(input.amount));
    const date = input.date ?? dayjs().format("YYYY-MM-DD");
    const receivable = await this.accountIdFor("reimbursable");

    return this.atomic((service) =>
      service.insertDisbursement(input, { amountStr, date, receivable, clientId: project.clientId })
    );
  }

  private async insertDisbursement(
    input: Parameters<ContaService["createDisbursement"]>[0],
    resolved: { amountStr: string; date: string; receivable: string; clientId: string }
  ): Promise<{ disbursement: Disbursement; journal: Journal; lines: LedgerEntry[] }> {
    const { amountStr, date, receivable, clientId } = resolved;

    // 1. Create the disbursement journal
    const journalResult = await this.createJournal({
      date,
      description: input.description,
      counterpartyId: clientId,
      journalType: "disbursement",
      metadata: { ...input.metadata, projectId: input.projectId },
      status: "posted",
      createdBy: input.createdBy,
      lines: [
        {
          accountId: input.paidFromAccountId,
          projectId: input.projectId,
          description: `Paid: ${input.description}`,
          credit: amountStr,
        },
        {
          // We expect account 1250 "Disbursements Receivable" to exist
          accountId: receivable,
          projectId: input.projectId,
          description: `Receivable: ${input.description}`,
          debit: amountStr,
        },
      ],
    });

    const [disbursement] = await this.db
      .insert(disbursements)
      .values({
        projectId: input.projectId,
        journalId: journalResult.journal.id,
        description: input.description,
        amount: amountStr,
        status: "pending",
        date,
        category: input.category,
        externalRef: input.externalRef,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      })
      .returning();

    return { disbursement, journal: journalResult.journal, lines: journalResult.lines };
  }

  async billDisbursement(
    disbursementId: string
  ): Promise<{ journal: Journal; lines: LedgerEntry[] }> {
    const [disb] = await this.db
      .select()
      .from(disbursements)
      .where(eq(disbursements.id, disbursementId))
      .limit(1);

    if (!disb) throw new AccountingError("Disbursement not found", 404);
    if (disb.status !== "pending")
      throw new AccountingError("Disbursement already billed or paid", 409);

    // Atomic claim: two simultaneous billings created two journals. One already on an invoice,
    // draft included, is billed by that invoice.
    return this.atomic((service) => service.billInside(disb));
  }

  private async billInside(disb: Disbursement): Promise<{ journal: Journal; lines: LedgerEntry[] }> {
    const [claimed] = await this.db
      .update(disbursements)
      .set({ status: "billed", billedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(disbursements.id, disb.id),
          eq(disbursements.status, "pending"),
          isNull(disbursements.invoiceId)
        )
      )
      .returning({ id: disbursements.id });
    if (!claimed) throw new AccountingError("Disbursement already billed or paid", 409);

    const amountStr = toDb(d(disb.amount));
    const [project] = await this.db
      .select({ clientId: projects.clientId })
      .from(projects)
      .where(eq(projects.id, disb.projectId))
      .limit(1);

    const journalResult = await this.createJournal({
      date: dayjs().format("YYYY-MM-DD"),
      description: `Bill disbursement: ${disb.description}`,
      counterpartyId: project?.clientId,
      journalType: "disbursement_billed",
      status: "posted",
      lines: [
        {
          accountId: await this.accountIdFor("receivable"),
          projectId: disb.projectId,
          description: `Billed: ${disb.description}`,
          debit: amountStr,
        },
        {
          accountId: await this.accountIdFor("reimbursable"),
          projectId: disb.projectId,
          description: `Clear receivable: ${disb.description}`,
          credit: amountStr,
        },
      ],
    });

    return { journal: journalResult.journal, lines: journalResult.lines };
  }

  async payDisbursement(disbursementId: string): Promise<Disbursement> {
    const [disb] = await this.db
      .select()
      .from(disbursements)
      .where(eq(disbursements.id, disbursementId))
      .limit(1);

    if (!disb) throw new AccountingError("Disbursement not found", 404);

    // Only what was BILLED is paid (`pending → billed → paid`): before, a pending one
    // became paid with no journal (an earlier audit).
    const [updated] = await this.db
      .update(disbursements)
      .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
      .where(and(eq(disbursements.id, disbursementId), eq(disbursements.status, "billed")))
      .returning();
    if (!updated) throw new AccountingError("Only billed disbursements can be paid", 409);

    return updated;
  }

  async resolveAccountCode(code: string): Promise<string> {
    const [account] = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.code, code))
      .limit(1);

    if (!account)
      throw new AccountingError(`Required account code ${code} not found. Run seed first.`);
    return account.id;
  }

  // ── Reports ─────────────────────────────────────────────────────────────

  async getTrialBalance(options?: { dateFrom?: string; dateTo?: string }): Promise<
    Array<{
      account: Account;
      totalDebit: Decimal;
      totalCredit: Decimal;
      balance: Decimal;
    }>
  > {
    const allAccounts = await this.db.select().from(accounts).where(eq(accounts.isActive, true));

    // In series, not `Promise.all`: within a request `this.db` is the
    // RLS transaction, ONE connection, and parallel queries over it are not
    // allowed (kon SDK rule, docs/kons/README.md).
    const result: Array<{
      account: Account;
      totalDebit: Decimal;
      totalCredit: Decimal;
      balance: Decimal;
    }> = [];
    for (const acc of allAccounts as Account[]) {
      const conditions = [eq(ledgerEntries.accountId, acc.id), inArray(journals.status, IN_THE_BOOKS)];
      if (options?.dateFrom) conditions.push(gte(journals.date, options.dateFrom));
      if (options?.dateTo) conditions.push(lte(journals.date, options.dateTo));

      const [sums] = await this.db
        .select({
          totalDebit: sql<string>`coalesce(sum(${ledgerEntries.debit}), 0)`,
          totalCredit: sql<string>`coalesce(sum(${ledgerEntries.credit}), 0)`,
        })
        .from(ledgerEntries)
        .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
        .where(and(...conditions));
      const totalDebit = d(sums.totalDebit);
      const totalCredit = d(sums.totalCredit);
      const balance = computeBalance(acc.openingBalance, acc.type, totalDebit, totalCredit);

      result.push({ account: acc, totalDebit, totalCredit, balance });
    }

    return result;
  }

  async getBalanceSheet(asOfDate?: string): Promise<{
    assets: Array<{ account: Account; balance: Decimal }>;
    liabilities: Array<{ account: Account; balance: Decimal }>;
    equity: Array<{ account: Account; balance: Decimal }>;
    totalAssets: Decimal;
    totalLiabilities: Decimal;
    totalEquity: Decimal;
    /** Revenue minus expenses not yet closed into equity. */
    netIncome: Decimal;
    /** Liabilities, equity and net income: it equals `totalAssets` when the books balance. */
    totalLiabilitiesAndEquity: Decimal;
  }> {
    const trial = await this.getTrialBalance(asOfDate ? { dateTo: asOfDate } : undefined);

    const assets = trial
      .filter((t) => t.account.type === "asset")
      .map((t) => ({ account: t.account, balance: t.balance }));
    const liabilities = trial
      .filter((t) => t.account.type === "liability")
      .map((t) => ({ account: t.account, balance: t.balance }));
    const equity = trial
      .filter((t) => t.account.type === "equity")
      .map((t) => ({ account: t.account, balance: t.balance }));

    const totalLiabilities = liabilities.reduce((s, a) => s.plus(a.balance), zero());
    const totalEquity = equity.reduce((s, a) => s.plus(a.balance), zero());
    const netIncome = trial.reduce((s, t) => {
      if (t.account.type === "revenue") return s.plus(t.balance);
      if (t.account.type === "expense") return s.minus(t.balance);
      return s;
    }, zero());

    return {
      assets,
      liabilities,
      equity,
      totalAssets: assets.reduce((s, a) => s.plus(a.balance), zero()),
      totalLiabilities,
      totalEquity,
      netIncome,
      totalLiabilitiesAndEquity: totalLiabilities.plus(totalEquity).plus(netIncome),
    };
  }

  async getProfitAndLoss(options?: { dateFrom?: string; dateTo?: string }): Promise<{
    revenue: Array<{ account: Account; balance: Decimal }>;
    expenses: Array<{ account: Account; balance: Decimal }>;
    totalRevenue: Decimal;
    totalExpenses: Decimal;
    netIncome: Decimal;
  }> {
    const trial = await this.getTrialBalance(options);

    const revenue = trial
      .filter((t) => t.account.type === "revenue")
      .map((t) => ({ account: t.account, balance: t.balance }));
    const expenses = trial
      .filter((t) => t.account.type === "expense")
      .map((t) => ({ account: t.account, balance: t.balance }));

    const totalRevenue = revenue.reduce((s, a) => s.plus(a.balance), zero());
    const totalExpenses = expenses.reduce((s, a) => s.plus(a.balance), zero());

    return {
      revenue,
      expenses,
      totalRevenue,
      totalExpenses,
      netIncome: totalRevenue.minus(totalExpenses),
    };
  }

  /**
   * Revenue and expense per account and per month or quarter between two dates: the movement of each
   * period, without opening balances. Revenue counts credit less debit, expense debit less credit.
   * Every period of the range is listed, with zero where nothing moved. Amounts are decimal text.
   */
  async getProfitAndLossByPeriod(options: { dateFrom: string; dateTo: string; groupBy: "month" | "quarter" }) {
    const { dateFrom, dateTo, groupBy } = options;
    if (!isRealDate(dateFrom) || !isRealDate(dateTo)) {
      throw new AccountingError("dateFrom and dateTo must be real dates in YYYY-MM-DD");
    }
    if (dateFrom > dateTo) throw new AccountingError("dateFrom is after dateTo");

    const keyOf = (date: dayjs.Dayjs) =>
      groupBy === "month" ? date.format("YYYY-MM") : `${date.year()}-Q${Math.floor(date.month() / 3) + 1}`;
    const step = groupBy === "month" ? 1 : 3;
    const periods: string[] = [];
    let cursor = dayjs(dateFrom).startOf("month");
    if (groupBy === "quarter") cursor = cursor.month(Math.floor(cursor.month() / 3) * 3);
    while (!cursor.isAfter(dayjs(dateTo))) {
      periods.push(keyOf(cursor));
      if (periods.length > 120) throw new AccountingError("At most 120 periods: narrow the dates");
      cursor = cursor.add(step, "month");
    }

    const key =
      groupBy === "month"
        ? sql<string>`substr(${journals.date}, 1, 7)`
        : sql<string>`substr(${journals.date}, 1, 4) || '-Q' || ((substr(${journals.date}, 6, 2)::int + 2) / 3)::text`;
    const moved = await this.db
      .select({
        accountId: ledgerEntries.accountId,
        period: key,
        amount: sql<string>`coalesce(sum(CASE WHEN ${accounts.type} = 'revenue' THEN ${ledgerEntries.credit} - ${ledgerEntries.debit} ELSE ${ledgerEntries.debit} - ${ledgerEntries.credit} END), 0)`,
      })
      .from(ledgerEntries)
      .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
      .innerJoin(accounts, eq(ledgerEntries.accountId, accounts.id))
      .where(
        and(
          inArray(accounts.type, ["revenue", "expense"]),
          inArray(journals.status, IN_THE_BOOKS),
          gte(journals.date, dateFrom),
          lte(journals.date, dateTo)
        )
      )
      .groupBy(ledgerEntries.accountId, key);

    // Active accounts show even when nothing moved; an inactive one only if it did, so totals tie out.
    const movedIds = [...new Set(moved.map((m) => m.accountId))];
    const rows = await this.db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
      .from(accounts)
      .where(
        and(
          inArray(accounts.type, ["revenue", "expense"]),
          movedIds.length ? or(eq(accounts.isActive, true), inArray(accounts.id, movedIds)) : eq(accounts.isActive, true)
        )
      );
    rows.sort((a, b) => (a.type === b.type ? a.code.localeCompare(b.code) : a.type === "revenue" ? -1 : 1));

    let income = zero();
    let expense = zero();
    const list = rows.map((account) => {
      const amounts: Record<string, string> = {};
      let total = zero();
      for (const period of periods) {
        const amount = d(moved.find((m) => m.accountId === account.id && m.period === period)?.amount ?? 0);
        amounts[period] = amount.toFixed(4);
        total = total.plus(amount);
      }
      if (account.type === "revenue") income = income.plus(total);
      else expense = expense.plus(total);
      return { code: account.code, name: account.name, type: account.type, amounts, total: total.toFixed(4) };
    });
    const net = income.minus(expense);
    return {
      dateFrom,
      dateTo,
      groupBy,
      periods,
      accounts: list,
      totals: {
        income: income.toFixed(4),
        expense: expense.toFixed(4),
        net: net.toFixed(4),
        /** Net over income, as a percentage with one decimal. Null without income. */
        marginPct: income.greaterThan(0)
          ? net.dividedBy(income).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toNumber()
          : null,
      },
    };
  }
}
