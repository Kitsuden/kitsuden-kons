/**
 * How another kon reaches the ledger without depending on it
 * ============================================================================
 *
 * The same pattern as the ledger bridge in kon-payments: a runtime import with the path in a
 * variable, so a site without kon-conta still compiles, and a tolerant catch.
 *
 *     const contaBridge = "../kon-conta/conta.bridge";
 *     const { ensureProject, recordProjectWork } = await import(contaBridge);
 *     await ctx.db.asSystem(async () => {
 *       await ensureProject(ctx.db.instance, {
 *         externalRef: deal.id,
 *         name: deal.title,
 *         client: { externalRef: company.id, name: company.name },
 *       });
 *       await recordProjectWork(ctx.db.instance, {
 *         projectExternalRef: deal.id,
 *         resourceUserId: user.id,
 *         quantity: "1.50",
 *         description: "Call with the client",
 *         externalRef: activity.id,
 *         createdBy: user.id,
 *       });
 *     });
 *
 * WHO MAY CALL. The ledger's RLS only lets the accounting team write. A person who records work
 * from another kon usually is not on it, so that kon decides whether they may, and then calls
 * inside `ctx.db.asSystem`. `createdBy` keeps the real author in the audit trail: as the system the
 * database cannot tell who it was. Called with a user's own context, an account without an
 * accounting role gets a database refusal, not a bypass.
 *
 * IDEMPOTENT. With `externalRef`, calling twice records once and answers `created: false`, so a
 * retry in the calling kon cannot bill the same work or expense twice. `ensureProject` and
 * `ensureClient` called again bring the row up to date with what they are given.
 *
 * STABLE. These functions and their inputs are the contract other kons build on: add optional
 * fields, never rename or remove one.
 */

import { Decimal } from "decimal.js";
import { and, desc, eq, sql } from "drizzle-orm";

import { BillingService, invoiceDisplayStatus, today } from "./conta.billing";
import {
  BILLING_TYPES,
  LABEL_KEYS,
  contaSettings,
  counterparties,
  invoices,
  projects,
  resources,
  type BillingType,
  type Counterparty,
  type Labels,
  type Project,
} from "./conta.schema";
import { AccountingError, ContaService, d, toDb } from "./conta.service";
import type { ContaDb } from "./types";

export interface EnsureProjectInput {
  /** The project's id in the calling kon, such as a CRM deal id. */
  externalRef: string;
  name: string;
  /** The project's number. `EXT-<externalRef>` by default. */
  number?: string;
  billingType?: BillingType;
  category?: string;
  /**
   * The account of the person who runs it: the resource with this `userId` becomes the project's
   * responsible. A user with no resource leaves the responsible as it is.
   */
  responsibleResourceUserId?: string;
  client: { externalRef: string; name: string; email?: string; taxId?: string };
}

export interface EnsureClientInput {
  /** The client's id in the calling kon, such as a CRM company id. */
  externalRef: string;
  name: string;
  email?: string;
  taxId?: string;
  /** Days to pay. Null or absent: the default in settings. */
  paymentTermsDays?: number;
  /** Funds balance below which the client is asked to top up. */
  fundsMinimum?: string | number;
}

export interface ClientStatementInput {
  clientExternalRef: string;
}

export interface ProjectWorkInput {
  projectExternalRef: string;
  /** The account of the person who did it, linked to a resource with `userId`. */
  resourceUserId?: string;
  /** How much, in the resource's unit. */
  quantity: string | number;
  /** Must be the resource's unit when given. */
  unit?: string;
  description: string;
  date?: string;
  externalRef?: string;
  createdBy?: string | null;
}

export interface ProjectExpenseInput {
  projectExternalRef: string;
  amount: string | number;
  description: string;
  date?: string;
  category?: string;
  /** An account id, or `client_funds` to pay from the funds held for the client. */
  paidFrom?: string;
  externalRef?: string;
  createdBy?: string | null;
}

export interface ContaPreset {
  /** Display names, merged over what is set: `{ project: { singular: "Job", plural: "Jobs" } }`. */
  labels?: Partial<Labels>;
  /** The billing types offered. */
  billingTypes?: BillingType[];
}

/**
 * The project for a record in another kon, created the first time it is asked for. The client is
 * found by its own external reference and created if it is new. Called again, it brings the
 * project's name, billing type, category and responsible up to date with what it is given, and
 * changes nothing when they already match.
 */
export async function ensureProject(dbValue: unknown, input: EnsureProjectInput) {
  const db = dbValue as ContaDb;
  if (!input.externalRef || !input.client?.externalRef) {
    throw new AccountingError("A project and its client need an external reference");
  }
  return db.transaction(async (tx) => {
    const conta = new ContaService(tx as unknown as ContaDb);
    const responsibleResourceId = await responsibleFor(tx as unknown as ContaDb, input.responsibleResourceUserId);
    const [existing] = await tx.select().from(projects).where(eq(projects.externalRef, input.externalRef)).limit(1);
    if (existing) {
      const patch: Partial<Project> = {};
      if (input.name && input.name !== existing.name) patch.name = input.name;
      if (input.billingType && input.billingType !== existing.billingType) {
        await conta.assertBillingType(input.billingType);
        patch.billingType = input.billingType;
      }
      if (input.category !== undefined && input.category !== existing.category) patch.category = input.category;
      if (responsibleResourceId && responsibleResourceId !== existing.responsibleResourceId) {
        patch.responsibleResourceId = responsibleResourceId;
      }
      if (Object.keys(patch).length === 0) return { project: existing, created: false };
      const [project] = await tx
        .update(projects)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(projects.id, existing.id))
        .returning();
      return { project, created: false };
    }
    if (input.billingType) await conta.assertBillingType(input.billingType);

    const [known] = await tx
      .select()
      .from(counterparties)
      .where(eq(counterparties.externalRef, input.client.externalRef))
      .limit(1);
    const client =
      known ??
      (
        await tx
          .insert(counterparties)
          .values({
            name: input.client.name,
            email: input.client.email,
            taxId: input.client.taxId,
            type: "client",
            externalRef: input.client.externalRef,
          })
          .returning()
      )[0];

    const [project] = await tx
      .insert(projects)
      .values({
        clientId: client.id,
        number: input.number ?? `EXT-${input.externalRef}`,
        name: input.name,
        externalRef: input.externalRef,
        billingType: input.billingType,
        category: input.category,
        responsibleResourceId,
      })
      .returning();
    return { project, created: true };
  });
}

/** The resource linked to an account, or undefined when there is none: not knowing it is not an error. */
async function responsibleFor(db: ContaDb, userId: string | undefined): Promise<string | undefined> {
  if (!userId) return undefined;
  const [row] = await db.select({ id: resources.id }).from(resources).where(eq(resources.userId, userId)).limit(1);
  return row?.id;
}

/**
 * The client for a record in another kon, created the first time it is asked for with type
 * `client`. Called again, it brings the fields it is given up to date and leaves the others alone.
 */
export async function ensureClient(dbValue: unknown, input: EnsureClientInput) {
  const db = dbValue as ContaDb;
  if (!input.externalRef) throw new AccountingError("A client needs an external reference");
  if (!input.name) throw new AccountingError("A client needs a name");
  if (
    input.paymentTermsDays !== undefined &&
    (!Number.isInteger(input.paymentTermsDays) || input.paymentTermsDays < 0 || input.paymentTermsDays > 3650)
  ) {
    throw new AccountingError("paymentTermsDays must be a whole number of days from 0 to 3650");
  }
  let fundsMinimum: Decimal | undefined;
  if (input.fundsMinimum !== undefined) {
    try {
      fundsMinimum = d(input.fundsMinimum);
    } catch {
      throw new AccountingError("fundsMinimum must be an amount");
    }
    if (fundsMinimum.isNegative() || fundsMinimum.decimalPlaces() > 4) {
      throw new AccountingError("fundsMinimum must be zero or more, with at most four decimals");
    }
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(counterparties)
      .where(eq(counterparties.externalRef, input.externalRef))
      .limit(1);
    if (!existing) {
      const [client] = await tx
        .insert(counterparties)
        .values({
          name: input.name,
          email: input.email,
          taxId: input.taxId,
          type: "client",
          externalRef: input.externalRef,
          paymentTermsDays: input.paymentTermsDays,
          ...(fundsMinimum ? { fundsMinimum: toDb(fundsMinimum) } : {}),
        })
        .returning();
      return { client, created: true };
    }
    const patch: Partial<Counterparty> = {};
    if (input.name !== existing.name) patch.name = input.name;
    if (input.email !== undefined && input.email !== existing.email) patch.email = input.email;
    if (input.taxId !== undefined && input.taxId !== existing.taxId) patch.taxId = input.taxId;
    if (input.paymentTermsDays !== undefined && input.paymentTermsDays !== existing.paymentTermsDays) {
      patch.paymentTermsDays = input.paymentTermsDays;
    }
    if (fundsMinimum && !fundsMinimum.equals(existing.fundsMinimum)) patch.fundsMinimum = toDb(fundsMinimum);
    if (Object.keys(patch).length === 0) return { client: existing, created: false };
    const [client] = await tx
      .update(counterparties)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(counterparties.id, existing.id))
      .returning();
    return { client, created: false };
  });
}

/**
 * What a client owes, for another kon to show: the balance due over every issued invoice, and the
 * newest 100 of them. Drafts and void invoices are left out. An unknown client owes nothing.
 * Amounts are decimal text, as everywhere in the kon.
 */
export async function clientStatement(dbValue: unknown, input: ClientStatementInput) {
  const db = dbValue as ContaDb;
  const empty = { balanceDue: toDb(new Decimal(0)), invoices: [] as StatementInvoice[] };
  if (!input.clientExternalRef) return empty;
  const [client] = await db
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(eq(counterparties.externalRef, input.clientExternalRef))
    .limit(1);
  if (!client) return empty;

  const issued = and(eq(invoices.clientId, client.id), eq(invoices.status, "issued"));
  const [due] = await db
    .select({ balance: sql<string>`coalesce(sum(${invoices.total} - ${invoices.amountPaid}), 0)` })
    .from(invoices)
    .where(issued);
  const rows = await db
    .select()
    .from(invoices)
    .where(issued)
    .orderBy(desc(invoices.issueDate), desc(invoices.number))
    .limit(100);
  const asOf = today();
  return {
    balanceDue: toDb(d(due?.balance ?? 0)),
    invoices: rows.map(
      (row): StatementInvoice => ({
        number: row.number,
        issueDate: row.issueDate,
        dueDate: row.dueDate,
        total: toDb(d(row.total)),
        balance: toDb(d(row.total).minus(row.amountPaid)),
        status: invoiceDisplayStatus(row, asOf),
      })
    ),
  };
}

/** One invoice in `clientStatement`. `status` is the display status: pending, partial, overdue or paid. */
export interface StatementInvoice {
  number: string | null;
  issueDate: string;
  dueDate: string;
  total: string;
  balance: string;
  status: ReturnType<typeof invoiceDisplayStatus>;
}

/** Records work on a project, as quantity times the resource's rate. It waits until an invoice bills it. */
export function recordProjectWork(db: unknown, input: ProjectWorkInput) {
  return new BillingService(db as ContaDb).recordWorkEntry(input);
}

/** Records an expense on a project, paid by the business or (`paidFrom: "client_funds"`) from the client's funds. */
export function recordProjectExpense(db: unknown, input: ProjectExpenseInput) {
  return new BillingService(db as ContaDb).recordExpense(input);
}

/** JSON with object keys sorted, so two values with the same content give the same text. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sort(value));
}

/**
 * Sets what an installation calls things and which billing types it offers. Idempotent: applying
 * the same preset again writes nothing and records nothing.
 */
export async function applyContaPreset(dbValue: unknown, preset: ContaPreset) {
  const db = dbValue as ContaDb;
  for (const key of Object.keys(preset.labels ?? {})) {
    if (!(LABEL_KEYS as readonly string[]).includes(key)) throw new AccountingError(`Unknown label: ${key}`);
  }
  for (const type of preset.billingTypes ?? []) {
    if (!(BILLING_TYPES as readonly string[]).includes(type)) throw new AccountingError(`Unknown billing type: ${type}`);
  }
  if (preset.billingTypes && preset.billingTypes.length === 0) {
    throw new AccountingError("At least one billing type must be offered");
  }
  const [row] = await db.select().from(contaSettings).limit(1);
  if (!row) throw new AccountingError("Accounting settings are missing: run the kon's migrations");

  const labels = { ...row.labels, ...(preset.labels ?? {}) };
  const billingTypes = preset.billingTypes ? [...new Set(preset.billingTypes)] : row.billingTypes;
  // jsonb stores object keys in its own order: compare by content, not by text.
  const same =
    canonical(labels) === canonical(row.labels) && canonical(billingTypes) === canonical(row.billingTypes);
  if (same) return { changed: false, settings: await new ContaService(db).getSettings() };

  const settings = await new BillingService(db).updateSettings({
    ...(preset.labels ? { labels: preset.labels } : {}),
    ...(preset.billingTypes ? { billingTypes } : {}),
  });
  return { changed: true, settings };
}
