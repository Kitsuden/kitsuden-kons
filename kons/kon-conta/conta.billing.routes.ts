/**
 * The billing operations of the kon: invoices, work, client funds, recurring fees, bank, close and reports.
 * ============================================================================
 *
 * Registered by `contaOperations` on the same registry and through the same `conta()` declaration
 * as the ledger routes, so they run behind the same session, accounting role, policy and body checks.
 *
 *   view        read anything
 *   write       every document and posting, closing a period included
 *   administer  settings, and reopening a closed period
 *
 * The rules themselves live in the services: a route validates the shape and calls one method.
 */

import { z } from "zod";

import { BillingService, INVOICE_SORTS } from "./conta.billing";
import { ContaReports } from "./conta.reports";
import {
  BILLING_TYPES,
  DEFAULT_ACCOUNT_CODES,
  LABEL_KEYS,
  RECURRING_FREQUENCIES,
  TARGET_PERIODS,
} from "./conta.schema";
import { isRealDate } from "./conta.service";
import type { ContaAction, Declaration, registry } from "./operations";
import type { ContaDb } from "./types";

// ── Shapes ──────────────────────────────────────────────────────────────────

const id = z.string().min(1).max(64);
const money = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, "Invalid amount");
const positiveMoney = money.refine((v) => /[1-9]/.test(v), "Must be greater than zero");
const signedMoney = z.string().regex(/^-?\d{1,15}(\.\d{1,4})?$/, "Invalid amount");
const ratio = z
  .string()
  .regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/, "A rate between 0 and 1, such as 0.07");
const positiveQuantity = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,4})?$/, "A quantity with at most four decimals")
  .refine((v) => /[1-9]/.test(v), "Must be greater than zero");
const unit = z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/, "A unit in lower case, such as hour or day");
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A date in YYYY-MM-DD")
  .refine(isRealDate, "Not a real date");
const label = (max: number) => z.string().min(1).max(max);
const quantity = z.string().regex(/^\d{1,8}(\.\d{1,4})?$/, "Invalid quantity");

const ParamId = z.object({ id: z.string().describe("Row id") });
const whole = (max: number, description: string) =>
  z.coerce.number().int().min(1).max(max).optional().describe(description);
const paged = {
  limit: whole(500, "Rows per page"),
  page: whole(1_000_000, "Page, from 1"),
};
const flag = (description: string) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true"))
    .describe(description);

const Row = z.object({ id: z.string() }).passthrough();
const WithRow = z.object({ data: Row }).passthrough();
const WithRows = z.object({ data: z.array(Row) }).passthrough();
const WithData = z.object({ data: z.record(z.string(), z.unknown()) }).passthrough();
const WithList = z.object({ data: z.array(z.record(z.string(), z.unknown())) }).passthrough();
const Done = z.object({ success: z.boolean() }).passthrough();
const WithPagination = z
  .object({
    data: z.array(Row),
    pagination: z
      .object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() })
      .passthrough(),
  })
  .passthrough();

const accountRole = z.enum(Object.keys(DEFAULT_ACCOUNT_CODES) as [keyof typeof DEFAULT_ACCOUNT_CODES]);

const settingsPatch = z.object({
  baseCurrency: z.string().regex(/^[A-Z]{3}$/).optional().describe("Currency of every document, ISO code. Must exist in list-currencies"),
  defaultTaxRate: ratio.optional().describe("Tax rate applied when an invoice does not bring one, 0 to 1"),
  taxRates: z.array(ratio).max(20).optional().describe("Rates offered when billing"),
  defaultPaymentTermsDays: z.number().int().min(0).max(3650).optional().describe("Days to pay when the client has no terms of its own"),
  invoicePrefix: label(16).optional().describe("Prefix of invoice numbers"),
  creditNotePrefix: label(16).optional().describe("Prefix of credit note numbers"),
  numberPadding: z.number().int().min(1).max(12).optional().describe("Digits of the document counter"),
  accountCodes: z
    .record(accountRole, label(50))
    .optional()
    .describe("Account code for each kind of movement, for a chart of accounts of your own"),
  bankFeeKeywords: z.array(label(40)).max(50).optional().describe("Words that mark a statement line as a bank charge"),
  labels: z
    .record(
      z.enum(LABEL_KEYS),
      z.object({ singular: label(60).describe("One, such as Project"), plural: label(60).describe("Many, such as Projects") })
    )
    .optional()
    .describe("Display names of project, resource, clientFunds, recurringFee and successFee for this installation"),
  billingTypes: z
    .array(z.enum(BILLING_TYPES))
    .min(1)
    .optional()
    .describe("Billing types offered: time, fixed, recurring, success"),
  issuer: z
    .object({
      name: z.string().max(255).optional().describe("Name shown on documents"),
      legalName: z.string().max(255).optional().describe("Registered name"),
      taxId: z.string().max(64).optional().describe("Tax id"),
      address: z.string().max(1000).optional().describe("Postal address, lines separated by newlines"),
      email: z.string().max(255).optional().describe("Email shown on documents"),
      phone: z.string().max(64).optional().describe("Phone shown on documents"),
      bankDetails: z.string().max(1000).optional().describe("Where to pay: bank, account, reference"),
      logoMediaId: z.string().max(128).optional().describe("Id of the logo image in the media library"),
      invoiceFooter: z.string().max(2000).optional().describe("Text at the foot of every invoice"),
    })
    .optional()
    .describe("Who issues the documents. Fields merge with what is set; an empty string clears one"),
  targets: z
    .array(
      z.object({
        metric: label(64).describe("What is measured, such as billed or collected"),
        period: z.enum(TARGET_PERIODS).describe("month, quarter or year"),
        amount: money.describe("Target amount per period"),
      })
    )
    .max(50)
    .optional()
    .describe("Targets the business measures itself against. Replaces the whole list"),
});

const closeBody = z.object({
  until: isoDate.describe("Last date of the period: nothing posts on or before it. Cannot be in the future"),
});
const reopenBody = z.object({
  until: isoDate.optional().describe("Keep the books closed up to this earlier date. Omit to lift the lock"),
});

const resourceBody = z.object({
  name: label(255).describe("Name of the person or the thing"),
  title: z.string().max(100).optional().describe("Role or kind, for display"),
  userId: z.string().min(1).max(128).optional().describe("A person's account id, when they have one"),
  externalRef: z.string().min(1).max(128).optional().describe("Its id in another system"),
  unit: unit.optional().describe("What the rates are per: hour by default, or day, unit, session…"),
  billingRate: money.describe("What a unit costs the client"),
  costRate: money.optional().describe("What a unit costs the business"),
});
const resourcePatch = resourceBody.partial().extend({
  isActive: z.boolean().optional().describe("An inactive resource stays on old work and is not listed"),
});

const workBody = z.object({
  projectId: id.optional().describe("Project from list-projects"),
  projectExternalRef: z.string().min(1).max(128).optional().describe("Instead of projectId: the project's id in another system"),
  resourceId: id.optional().describe("Resource from list-resources"),
  resourceUserId: z.string().min(1).max(128).optional().describe("Instead of resourceId: the account id of a person"),
  date: isoDate.optional().describe("Day of the work. Today by default"),
  description: label(2000).describe("What was done"),
  quantity: positiveQuantity.describe("How much, in the resource's unit, such as 1.50 hours"),
  unit: unit.optional().describe("Must be the resource's unit when given"),
  billingRate: money.optional().describe("Overrides the resource's rate for this entry"),
  externalRef: z.string().min(1).max(128).optional().describe("Id of the source record: recording it twice returns the same entry"),
});
const workPatch = z.object({
  date: isoDate.optional().describe("Day of the work"),
  description: label(2000).optional().describe("What was done"),
  quantity: positiveQuantity.optional().describe("How much, in the resource's unit"),
  billingRate: money.optional().describe("Rate of this entry"),
});

const expenseBody = z.object({
  projectId: id.optional().describe("Project from list-projects"),
  projectExternalRef: z.string().min(1).max(128).optional().describe("Instead of projectId: the project's id in another system"),
  description: label(2000).describe("What was paid"),
  amount: positiveMoney.describe("Amount"),
  date: isoDate.optional().describe("Day it was paid. Today by default"),
  category: z.string().max(100).optional().describe("Kind of expense, such as travel"),
  paidFrom: id.optional().describe("An account id, or `client_funds` to pay from the funds held for the client. The operating bank by default"),
  externalRef: z.string().min(1).max(128).optional().describe("Id of the source record: recording it twice returns the same expense"),
});

const invoiceLine = z.object({
  kind: z.enum(["fee", "expense"]).optional().describe("A fee is revenue and taxed; an expense is passed on at cost. Fee by default"),
  description: label(2000).describe("Line text"),
  quantity: quantity.optional().describe("Quantity. 1 by default"),
  unitPrice: money.describe("Price per unit"),
  resourceId: id.optional().describe("Who did the work"),
  date: isoDate.optional().describe("Day of the work"),
});
const invoiceBody = z.object({
  clientId: id.describe("Client from list-counterparties"),
  projectId: id.optional().describe("Project of that client, required for expense lines"),
  concept: z.string().max(500).optional().describe("Heading of the invoice"),
  feeType: z.enum(BILLING_TYPES).optional().describe("Decides the revenue account. The project's billing type by default"),
  revenueAccountId: id.optional().describe("Overrides the revenue account"),
  issueDate: isoDate.optional().describe("Date of the invoice. Today by default"),
  termsDays: z.number().int().min(0).max(3650).optional().describe("Days to pay. The client's terms, then the default in settings"),
  taxRate: ratio.optional().describe("Tax on fees net of discount, 0 to 1. The default in settings otherwise"),
  discount: money.optional().describe("Amount taken off the fees"),
  lines: z.array(invoiceLine).max(500).optional().describe("Free lines"),
  workEntryIds: z.array(id).max(1000).optional().describe("Unbilled work entries to bill: lines come from the entries"),
  disbursementIds: z.array(id).max(1000).optional().describe("Pending disbursements to bill: lines come from them"),
  issue: z.boolean().optional().describe("Issue it now instead of leaving a draft"),
  paidFromAccountId: id.optional().describe("Account that paid the expense lines not recorded yet. The operating bank by default"),
  externalRef: z.string().min(1).max(128).optional().describe("Its id in another system"),
});
const invoicePatch = invoiceBody
  .omit({ clientId: true, projectId: true, issue: true, paidFromAccountId: true, externalRef: true })
  .partial();
const issueBody = z.object({
  date: isoDate.optional().describe("Date of the invoice. Today by default"),
  paidFromAccountId: id.optional().describe("Account that paid the expense lines not recorded yet"),
});
const voidBody = z.object({
  reason: z.string().max(1000).optional().describe("Why it is voided"),
  date: isoDate.optional().describe("Date of the credit note. Today by default"),
});
const paymentBody = z.object({
  amount: positiveMoney.describe("Amount paid: anything up to the balance due"),
  date: isoDate.optional().describe("Day of the payment. Today by default"),
  source: z.enum(["account", "client_funds"]).optional().describe("`client_funds` applies the funds held for the client. `account` by default"),
  accountId: id.optional().describe("Own account the money went into. The operating bank by default"),
  method: z.string().max(100).optional().describe("Transfer, check, cash…"),
  reference: z.string().max(255).optional().describe("Bank or check reference"),
  attachmentMediaId: z.string().min(1).max(128).optional().describe("A file kept with the payment, such as a receipt: its id in the media library"),
});
const reversePaymentBody = z.object({
  date: isoDate.optional().describe("Date of the reversal. Today by default"),
  reason: z.string().max(1000).optional().describe("Why, such as a returned check"),
});
const reminderBody = z.object({
  channel: label(50).describe("How it went out, such as email"),
  date: isoDate.optional().describe("Day it went out. Today by default"),
  note: z.string().max(1000).optional().describe("Free text"),
});
const remindersBody = reminderBody.extend({
  invoiceIds: z.array(id).min(1).max(500).describe("Invoices the reminder went out for"),
});
const deliveryBody = z.object({
  event: z.enum(["sent", "viewed"]).describe("What happened"),
  at: z.string().datetime({ offset: true }).optional().describe("When, in ISO 8601. Now by default"),
});

const clientFundsBody = z.object({
  clientId: id.describe("Client whose funds these are"),
  projectId: id.optional().describe("Project of that client"),
  amount: positiveMoney.describe("Amount"),
  date: isoDate.optional().describe("Day of the movement. Today by default"),
  description: z.string().max(2000).optional().describe("What it is for"),
  reference: z.string().max(255).optional().describe("Bank or check reference"),
  payee: z.string().max(255).optional().describe("Who receives the money"),
});

const recurringFeeBody = z.object({
  clientId: id.describe("Client from list-counterparties"),
  projectId: id.optional().describe("Project whose work counts against the recurring fee"),
  concept: label(500).describe("What it covers"),
  amount: positiveMoney.describe("Amount per period"),
  quantityIncluded: z.string().regex(/^\d{1,8}(\.\d{1,4})?$/).optional().describe("Quantity the amount includes, in `unit`"),
  unit: unit.optional().describe("Unit of the included quantity. Hour by default"),
  frequency: z.enum(RECURRING_FREQUENCIES).optional().describe("monthly, quarterly, semiannual or annual. Monthly by default"),
  nextDate: isoDate.optional().describe("First date to bill. Today by default"),
  externalRef: z.string().min(1).max(128).optional().describe("Its id in another system"),
});
const recurringFeePatch = recurringFeeBody
  .omit({ clientId: true, projectId: true, externalRef: true })
  .partial()
  .extend({ isActive: z.boolean().optional().describe("False pauses it") });
const runBody = z.object({
  date: isoDate.optional().describe("Bill what is due by this date, dated this date. Today by default"),
});

const successFeeBody = z.object({
  projectId: id.describe("Project the fee depends on"),
  baseAmount: money.describe("Amount the fee is a share of"),
  percentage: ratio.describe("Share of the base amount earned, 0 to 1"),
  probability: ratio.optional().describe("Estimated chance of winning, 0 to 1"),
  stage: z.string().max(255).optional().describe("Where it stands"),
  expectedDate: isoDate.optional().describe("When it is expected to end"),
  externalRef: z.string().min(1).max(128).optional().describe("Its id in another system"),
});
const successFeePatch = successFeeBody.omit({ projectId: true, externalRef: true }).partial();
const settleBody = z.object({
  outcome: z.enum(["won", "lost"]).describe("Won bills the fee; lost posts nothing"),
  achievedAmount: positiveMoney.optional().describe("What was achieved: the fee is its percentage"),
  feeAmount: positiveMoney.optional().describe("The fee itself, when it is not the percentage"),
  date: isoDate.optional().describe("Date of the settlement. Today by default"),
});

const bankImportBody = z.object({
  accountId: id.optional().describe("Asset account of the statement. The operating bank by default"),
  lines: z
    .array(
      z.object({
        date: isoDate.describe("Date on the statement"),
        description: label(1000).describe("Text on the statement"),
        reference: z.string().max(255).optional().describe("Bank reference: with it, importing twice adds nothing"),
        amount: signedMoney.describe("Signed: money in is positive"),
      })
    )
    .min(1)
    .max(5000)
    .describe("The statement's lines, already parsed"),
});
const bankMatchBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("invoice").describe("Money in that pays an invoice, in full or in part"),
    invoiceId: id.describe("Invoice it pays"),
  }),
  z.object({ kind: z.literal("fee").describe("A bank charge") }),
  z.object({
    kind: z.literal("client_funds").describe("Money in that belongs to a client"),
    clientId: id.describe("Client whose funds these are"),
    projectId: id.optional().describe("Project of that client"),
  }),
  z.object({
    kind: z.literal("journal").describe("Something the books already have"),
    journalId: id.describe("Posted journal that moves this account by the same amount"),
  }),
]);
const reconcileSuggestedBody = z.object({
  accountId: id.optional().describe("Only this account's lines. All accounts by default"),
});

const asOfQuery = z.object({
  asOf: isoDate.optional().describe("Report as of this date. Today by default"),
});

/** The `conta()` of `contaOperations`: session, accounting role and policy for one operation. */
type ContaDeclare = (
  actions: ContaAction | ContaAction[],
  declaration: Omit<Declaration, "access" | "permission" | "before">
) => Declaration;

export function registerBillingOperations(
  app: ReturnType<typeof registry>,
  conta: ContaDeclare,
  db: ContaDb
): void {
  const billing = new BillingService(db);
  const reports = new ContaReports(db);
  const NOT_FOUND = "KITSUDEN_E_NOT_FOUND" as const;
  const CONFLICT = "KITSUDEN_E_CONFLICT" as const;

  // ── Settings and periods ────────────────────────────────────────────────
  app.get(
    "/settings",
    conta("view", {
      id: "get-settings",
      summary: "Accounting settings",
      description:
        "Currency, default tax rate, numbering, payment terms, the closed date, the account code used for each kind of movement, the billing types offered, the display `labels` (what this installation calls a project, a resource, client funds, a recurring fee, a success fee), the `issuer` printed on documents and the `targets`. Read access to the ledger.",
      output: { schema: WithData },
    }),
    async (c) => c.json({ data: await billing.getSettings() })
  );

  app.patch(
    "/settings",
    conta(["write", "administer"], {
      id: "update-settings",
      summary: "Change accounting settings",
      description:
        "Changes the tax rate, currency, numbering, terms, account codes, bank charge keywords, labels, billing types offered, the `issuer` (merged field by field) or the `targets` (replaced as a list). 400 if a currency or account code does not exist. Recorded in the audit trail. To close a period use close-period. Admin only.",
      sensitive: true,
      input: { body: settingsPatch },
      output: { schema: WithData },
    }),
    async (c, input) => c.json({ data: await billing.updateSettings(input.body) })
  );

  app.get(
    "/periods",
    conta("view", {
      id: "get-period-status",
      summary: "Closed date and close checklist",
      description:
        "The date the books are closed up to, and what to check before closing up to `until`: statement lines still pending, client funds, draft invoices, trial balance. Read access to the ledger.",
      input: { query: z.object({ until: isoDate.optional().describe("Checklist for this date. Today by default") }) },
      output: { schema: WithData },
    }),
    async (c, input) => c.json({ data: await billing.getPeriodStatus(input.query.until) })
  );

  app.post(
    "/periods/close",
    conta("write", {
      id: "close-period",
      summary: "Close a period",
      description:
        "Nothing can be posted on or before `until` from now on. It only moves forward (409 otherwise) and cannot be in the future (400). The checklist comes back as information, it does not block. Write access to the ledger.",
      sensitive: true,
      input: { body: closeBody },
      output: { schema: WithData },
      errors: [CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.closePeriod(input.body.until) })
  );

  app.post(
    "/periods/reopen",
    conta(["write", "administer"], {
      id: "reopen-period",
      summary: "Reopen a closed period",
      description:
        "Lifts the lock, or moves it back to the earlier date `until`. Recorded in the audit trail. 409 if nothing is closed. Admin only.",
      sensitive: true,
      input: { body: reopenBody },
      output: { schema: WithData },
      errors: [CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.reopenPeriod(input.body.until) })
  );

  // ── Resources ─────────────────────────────────────────────────────────
  app.get(
    "/resources",
    conta("view", {
      id: "list-resources",
      summary: "List resources",
      description:
        "People and things billed per unit, with their unit and their billing and cost rates. `includeInactive=true` adds the inactive ones. Read access to the ledger.",
      input: { query: z.object({ includeInactive: flag("Also list inactive resources") }) },
      output: { schema: WithRows },
    }),
    async (c, input) => c.json({ data: await billing.listResources(input.query) })
  );

  app.post(
    "/resources",
    conta("write", {
      id: "create-resource",
      summary: "Create a resource",
      description:
        "Adds a person, or anything billed per unit such as a machine or a room, with the rate per unit and what a unit costs the business. 409 if the account or external reference is already linked. Write access to the ledger.",
      input: { body: resourceBody },
      output: { status: 201, schema: WithRow },
      errors: [CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.createResource(input.body) }, 201)
  );

  app.patch(
    "/resources/:id",
    conta("write", {
      id: "update-resource",
      summary: "Edit a resource",
      description:
        "Changes a resource's details or rates. Work already recorded keeps the rates of its day. 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId, body: resourcePatch },
      output: { schema: WithRow },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.updateResource(input.params.id, input.body) })
  );

  // ── Work entries ────────────────────────────────────────────────────────
  app.get(
    "/work-entries",
    conta("view", {
      id: "list-work-entries",
      summary: "List work entries",
      description:
        "Work entries, newest first, optionally by `projectId`, `resourceId`, `externalRef`, date range, or only `unbilled=true`. Read access to the ledger.",
      input: {
        query: z.object({
          projectId: id.optional().describe("Only this project"),
          resourceId: id.optional().describe("Only this resource"),
          externalRef: z.string().max(128).optional().describe("The entry with this external reference"),
          unbilled: flag("Only work no invoice has claimed"),
          dateFrom: isoDate.optional().describe("From this date"),
          dateTo: isoDate.optional().describe("Up to this date"),
          ...paged,
        }),
      },
      output: { schema: WithRows },
    }),
    async (c, input) => c.json({ data: await billing.listWorkEntries(input.query) })
  );

  app.post(
    "/work-entries",
    conta("write", {
      id: "record-work-entry",
      summary: "Record work on a project",
      description:
        "Records work as quantity times rate, with the resource's current rates unless `billingRate` is given. Posts nothing: it waits as work in progress until an invoice bills it. With `externalRef`, repeating it returns the same entry and `created: false`. 404 if the project or resource does not exist. Write access to the ledger.",
      input: { body: workBody },
      output: { status: 201, schema: WithData, otherStatuses: [200] },
      errors: [NOT_FOUND],
    }),
    async (c, input) => {
      const { entry, created } = await billing.recordWorkEntry(input.body);
      return c.json({ data: { ...entry, created } }, created ? 201 : 200);
    }
  );

  app.patch(
    "/work-entries/:id",
    conta("write", {
      id: "update-work-entry",
      summary: "Edit an unbilled work entry",
      description: "Changes a work entry no invoice has claimed. 409 if it is on an invoice; 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId, body: workPatch },
      output: { schema: WithRow },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.updateWorkEntry(input.params.id, input.body) })
  );

  app.delete(
    "/work-entries/:id",
    conta("write", {
      id: "delete-work-entry",
      summary: "Delete an unbilled work entry",
      description: "Deletes a work entry no invoice has claimed. 409 if it is on an invoice; 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId },
      output: { schema: Done },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => {
      await billing.deleteWorkEntry(input.params.id);
      return c.json({ success: true });
    }
  );

  // ── Expenses ────────────────────────────────────────────────────────────
  app.post(
    "/expenses",
    conta("write", {
      id: "record-expense",
      summary: "Record an expense on a project",
      description:
        "Paid by the business: posts against the paying account and waits to be billed, as a disbursement. With `paidFrom: \"client_funds\"`: taken from the funds held for the client, nothing left to bill, and 409 if it overdraws them. With `externalRef`, repeating it records once. 404 if the project does not exist. Write access to the ledger.",
      sensitive: true,
      input: { body: expenseBody },
      output: { status: 201, schema: WithData, otherStatuses: [200] },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => {
      const result = await billing.recordExpense(input.body);
      return c.json({ data: result }, result.created ? 201 : 200);
    }
  );

  // ── Invoices ────────────────────────────────────────────────────────────
  app.get(
    "/invoices",
    conta("view", {
      id: "list-invoices",
      summary: "List invoices",
      description:
        "Invoices, newest first or by `sort` (issueDate, dueDate, daysOverdue, balance, total) and `order` (asc, desc). Each row has `balance`, `displayStatus`, `daysOverdue`, `clientName`, `projectName`, `projectNumber`, `reminderCount`, `lastReminderOn` and `paymentCount` (payments not reversed). Filter by `status` (draft, pending, partial, overdue, paid, void, or open for anything still owed), `clientId`, `projectId`, `feeType`, `responsibleResourceId` (the projects that resource runs), issue date range, due date range, or `q` over number, concept and client. `summary` adds up `total`, `paid` and `balance` over every page of the filter. `include=counts` adds `counts` per status over the same filter without `status`. Read access to the ledger.",
      input: {
        query: z.object({
          status: z.enum(["draft", "pending", "partial", "overdue", "paid", "void", "open"]).optional().describe("Status as the client sees it"),
          clientId: id.optional().describe("Only this client"),
          projectId: id.optional().describe("Only this project"),
          feeType: z.enum(BILLING_TYPES).optional().describe("Only this billing type"),
          responsibleResourceId: id.optional().describe("Only invoices of the projects this resource runs"),
          dateFrom: isoDate.optional().describe("Issued from this date"),
          dateTo: isoDate.optional().describe("Issued up to this date"),
          dueFrom: isoDate.optional().describe("Due from this date"),
          dueTo: isoDate.optional().describe("Due up to this date"),
          q: z.string().max(200).optional().describe("Search text"),
          asOf: isoDate.optional().describe("Date that decides what is overdue. Today by default"),
          sort: z.enum(INVOICE_SORTS).optional().describe("Sort by this. Newest issue date first by default"),
          order: z.enum(["asc", "desc"]).optional().describe("Sort direction. desc by default"),
          include: z.enum(["counts"]).optional().describe("counts: also the number of invoices per status"),
          ...paged,
        }),
      },
      output: { schema: WithPagination },
    }),
    async (c, input) => c.json(await billing.listInvoices(input.query))
  );

  app.get(
    "/invoices/:id",
    conta("view", {
      id: "get-invoice",
      summary: "Invoice detail",
      description:
        "One invoice with its lines, payments and reminders. `include=journals` adds `journals`: its issue, credit note, payment and payment reversal journals, each with its lines as account code, name, debit and credit. 404 if it does not exist. Read access to the ledger.",
      input: {
        params: ParamId,
        query: z.object({
          include: z.enum(["journals"]).optional().describe("journals: also the journals behind the invoice"),
        }),
      },
      output: { schema: WithRow },
      errors: [NOT_FOUND],
    }),
    async (c, input) =>
      c.json({ data: await billing.getInvoice(input.params.id, { journals: input.query.include === "journals" }) })
  );

  app.post(
    "/invoices",
    conta("write", {
      id: "create-invoice",
      summary: "Create an invoice",
      description:
        "Creates a draft, which posts nothing, from free `lines` and from unbilled `workEntryIds` and `disbursementIds`, which leave work in progress. `issue: true` issues it right away. Tax applies to fees net of `discount`; expenses pass at cost. 400 if there is nothing to bill; 409 if something is already billed or belongs to another project or client. Write access to the ledger.",
      input: { body: invoiceBody },
      output: { status: 201, schema: WithRow },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.createInvoice(input.body) }, 201)
  );

  app.patch(
    "/invoices/:id",
    conta("write", {
      id: "update-invoice-draft",
      summary: "Edit a draft invoice",
      description:
        "Changes a draft. Sending `lines`, `workEntryIds` or `disbursementIds` replaces all three, and what is left out goes back to work in progress. 409 if it is not a draft. Write access to the ledger.",
      input: { params: ParamId, body: invoicePatch },
      output: { schema: WithRow },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.updateDraft(input.params.id, input.body) })
  );

  app.post(
    "/invoices/:id/issue",
    conta("write", {
      id: "issue-invoice",
      summary: "Issue a draft invoice",
      description:
        "Gives it the next number and posts receivable against revenue, reimbursable expenses and tax. An expense line with no recorded disbursement also records the advance. 409 if it is not a draft or the date is in a closed period. Write access to the ledger.",
      sensitive: true,
      input: { params: ParamId, body: issueBody },
      output: { schema: WithRow },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.issueInvoice(input.params.id, input.body) })
  );

  app.post(
    "/invoices/:id/void",
    conta("write", {
      id: "void-invoice",
      summary: "Void an invoice",
      description:
        "A draft is deleted. An issued invoice is cancelled with a credit note that reverses its journal, and its work and expenses go back to work in progress. 409 while it has live payments (reverse-payment first), or if the date is in a closed period. Write access to the ledger.",
      sensitive: true,
      input: { params: ParamId, body: voidBody },
      output: { schema: WithData },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.voidInvoice(input.params.id, input.body) })
  );

  app.post(
    "/invoices/:id/payments",
    conta("write", {
      id: "record-payment",
      summary: "Record a payment on an invoice",
      description:
        "Records a full or partial payment and posts it. `source: \"client_funds\"` applies the funds held for the client. `attachmentMediaId` keeps a file with it, such as a receipt. 409 if the amount exceeds the balance due, the client funds do not cover it, the invoice is not issued, or the date is in a closed period. Returns `{ payment, invoice }`. Write access to the ledger.",
      sensitive: true,
      input: { params: ParamId, body: paymentBody },
      output: { status: 201, schema: WithData },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.recordPayment(input.params.id, input.body) }, 201)
  );

  app.post(
    "/payments/:id/reverse",
    conta("write", {
      id: "reverse-payment",
      summary: "Reverse a payment",
      description:
        "Undoes a payment that did not happen, such as a returned check: reverses its journal and restores the balance due and any client funds. A statement line matched to it goes back to pending. 409 if already reversed or the date is in a closed period. Write access to the ledger.",
      sensitive: true,
      input: { params: ParamId, body: reversePaymentBody },
      output: { schema: WithData },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.reversePayment(input.params.id, input.body) })
  );

  app.post(
    "/invoices/:id/reminders",
    conta("write", {
      id: "add-invoice-reminder",
      summary: "Record a payment reminder",
      description: "Records that a reminder went out on `channel`. It sends nothing. 409 if the invoice is not issued. Write access to the ledger.",
      input: { params: ParamId, body: reminderBody },
      output: { status: 201, schema: WithRow },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.addReminder(input.params.id, input.body) }, 201)
  );

  app.post(
    "/invoices/reminders",
    conta("write", {
      id: "add-invoice-reminders",
      summary: "Record a payment reminder on many invoices",
      description:
        "Records that the same reminder went out on `channel` for each of `invoiceIds` (1 to 500). It sends nothing. Each invoice stands alone: one not found or not issued is listed in `failed` with its `reason`, and the others are recorded. Returns `{ recorded, failed }`, `recorded` being how many were recorded. Write access to the ledger.",
      input: { body: remindersBody },
      output: { status: 201, schema: WithData },
    }),
    async (c, input) => c.json({ data: await billing.addReminders(input.body) }, 201)
  );

  app.post(
    "/invoices/:id/delivery",
    conta("write", {
      id: "mark-invoice-delivery",
      summary: "Record that an invoice was sent or viewed",
      description: "Stores when the invoice was sent or when the client opened it. It sends nothing. 409 if the invoice is not issued. Write access to the ledger.",
      input: { params: ParamId, body: deliveryBody },
      output: { schema: WithRow },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) =>
      c.json({ data: await billing.markDelivery(input.params.id, input.body.event, input.body.at) })
  );

  // ── Client funds ──────────────────────────────────────────────────
  app.post(
    "/client-funds/deposits",
    conta("write", {
      id: "client-funds-deposit",
      summary: "Receive client funds",
      description:
        "Posts money received into the client funds bank against what is owed back to the client. 409 if the date is in a closed period; 404 if the client does not exist. Returns the journal and the new `balance`. Write access to the ledger.",
      sensitive: true,
      input: { body: clientFundsBody },
      output: { status: 201, schema: WithData },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.clientFundsDeposit(input.body) }, 201)
  );

  app.post(
    "/client-funds/disbursements",
    conta("write", {
      id: "client-funds-disburse",
      summary: "Pay out of client funds",
      description:
        "Pays a third party from a client's funds. 409 if it exceeds what that client holds: funds of another client cannot be used. 409 too if the date is in a closed period. Returns the journal and the new `balance`. Write access to the ledger.",
      sensitive: true,
      input: { body: clientFundsBody },
      output: { status: 201, schema: WithData },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.clientFundsDisburse(input.body) }, 201)
  );

  app.post(
    "/client-funds/refunds",
    conta("write", {
      id: "client-funds-refund",
      summary: "Return funds to a client",
      description:
        "Returns unused funds to the client. 409 if it exceeds what the client holds or the date is in a closed period. Returns the journal and the new `balance`. Write access to the ledger.",
      sensitive: true,
      input: { body: clientFundsBody },
      output: { status: 201, schema: WithData },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.clientFundsRefund(input.body) }, 201)
  );

  app.get(
    "/client-funds",
    conta("view", {
      id: "list-client-funds",
      summary: "Client funds per client",
      description:
        "What is held for each client, read from the ledger, with the agreed minimum, whether it is below it and the top-up to ask for. Read access to the ledger.",
      output: { schema: WithList },
    }),
    async (c) => c.json({ data: await billing.clientFundsByClient() })
  );

  app.get(
    "/client-funds/transactions",
    conta("view", {
      id: "list-client-funds-transactions",
      summary: "Client funds statement",
      description:
        "Client funds movements, newest first, with their signed `amount` and the client's running `balance`, optionally for one `clientId` and date range. Read access to the ledger.",
      input: {
        query: z.object({
          clientId: id.optional().describe("Only this client"),
          dateFrom: isoDate.optional().describe("From this date"),
          dateTo: isoDate.optional().describe("Up to this date"),
          limit: whole(5000, "Most movements returned"),
        }),
      },
      output: { schema: WithRows },
    }),
    async (c, input) => c.json({ data: await billing.clientFundsTransactions(input.query) })
  );

  app.get(
    "/client-funds/reconciliation",
    conta("view", {
      id: "get-client-funds-reconciliation",
      summary: "Client funds three-way check",
      description:
        "Client funds bank, client funds liability and the sum of client balances, and whether all three agree. Read access to the ledger.",
      input: { query: asOfQuery },
      output: { schema: WithData },
    }),
    async (c, input) => c.json({ data: await billing.clientFundsReconciliation(input.query.asOf) })
  );

  // ── RecurringFees ───────────────────────────────────────────────────────────
  app.get(
    "/recurring-fees",
    conta("view", {
      id: "list-recurring-fees",
      summary: "List recurring fees",
      description:
        "Recurring fees ordered by next date, each with the quantity used in its period and whether it is due, plus the monthly recurring revenue and how many are due. Read access to the ledger.",
      input: {
        query: z.object({
          clientId: id.optional().describe("Only this client"),
          active: flag("Only active, or only paused"),
          asOf: isoDate.optional().describe("Date that decides what is due. Today by default"),
        }),
      },
      output: { schema: WithRows },
    }),
    async (c, input) => c.json(await billing.listRecurringFees(input.query))
  );

  app.post(
    "/recurring-fees",
    conta("write", {
      id: "create-recurring-fee",
      summary: "Create a recurring fee",
      description: "Sets up a recurring fee. It bills nothing until it is run. 404 if the client or project does not exist. Write access to the ledger.",
      input: { body: recurringFeeBody },
      output: { status: 201, schema: WithRow },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.createRecurringFee(input.body) }, 201)
  );

  app.patch(
    "/recurring-fees/:id",
    conta("write", {
      id: "update-recurring-fee",
      summary: "Edit or pause a recurring fee",
      description: "Changes a recurring fee's amount, quantity included, frequency or next date, or pauses it with `isActive: false`. 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId, body: recurringFeePatch },
      output: { schema: WithRow },
      errors: [NOT_FOUND],
    }),
    async (c, input) => c.json({ data: await billing.updateRecurringFee(input.params.id, input.body) })
  );

  app.post(
    "/recurring-fees/run",
    conta("write", {
      id: "run-recurring-fees",
      summary: "Bill the recurring fees that are due",
      description:
        "Issues one invoice for each active recurring fee due by `date` and moves it to its next period. Running it again bills nothing new. A recurring fee that cannot be billed is listed in `failed` and the others go on. Write access to the ledger.",
      sensitive: true,
      input: { body: runBody },
      output: { schema: WithData },
    }),
    async (c, input) => c.json({ data: await billing.runRecurringFees(input.body) })
  );

  app.post(
    "/recurring-fees/:id/bill",
    conta("write", {
      id: "bill-recurring-fee",
      summary: "Bill one recurring fee now",
      description: "Issues the invoice of the recurring fee's next period, due or not, and moves it on. 409 if it is paused or the date is in a closed period. Write access to the ledger.",
      sensitive: true,
      input: { params: ParamId, body: runBody },
      output: { status: 201, schema: WithData },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.billRecurringFee(input.params.id, input.body) }, 201)
  );

  // ── Success fees ────────────────────────────────────────────────────
  app.get(
    "/success-fees",
    conta("view", {
      id: "list-success-fees",
      summary: "List success fees",
      description:
        "Fees that depend on a result, each with its amount if won and that fee weighted by probability, plus the totals of the open ones. Read access to the ledger.",
      input: {
        query: z.object({
          clientId: id.optional().describe("Only this client"),
          status: z.enum(["open", "won", "lost"]).optional().describe("Only this status"),
        }),
      },
      output: { schema: WithRows },
    }),
    async (c, input) => c.json(await billing.listSuccessFees(input.query))
  );

  app.post(
    "/success-fees",
    conta("write", {
      id: "create-success-fee",
      summary: "Create a success fee",
      description: "Records a fee that depends on a result. It posts nothing until it is settled. 404 if the project does not exist. Write access to the ledger.",
      input: { body: successFeeBody },
      output: { status: 201, schema: WithRow },
      errors: [NOT_FOUND],
    }),
    async (c, input) => c.json({ data: await billing.createSuccessFee(input.body) }, 201)
  );

  app.patch(
    "/success-fees/:id",
    conta("write", {
      id: "update-success-fee",
      summary: "Edit a success fee",
      description: "Changes an open success fee's base amount, percentage, probability, stage or expected date. 404 if it does not exist or is settled. Write access to the ledger.",
      input: { params: ParamId, body: successFeePatch },
      output: { schema: WithRow },
      errors: [NOT_FOUND],
    }),
    async (c, input) => c.json({ data: await billing.updateSuccessFee(input.params.id, input.body) })
  );

  app.post(
    "/success-fees/:id/settle",
    conta("write", {
      id: "settle-success-fee",
      summary: "Settle a success fee",
      description:
        "Won: issues an invoice for the percentage of `achievedAmount`, or for `feeAmount`. Lost: closes it and posts nothing. 409 if it is already settled or the date is in a closed period. Write access to the ledger.",
      sensitive: true,
      input: { params: ParamId, body: settleBody },
      output: { schema: WithData },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.settleSuccessFee(input.params.id, input.body) })
  );

  // ── Bank reconciliation ─────────────────────────────────────────────────
  app.post(
    "/bank-lines/import",
    conta("write", {
      id: "import-bank-lines",
      summary: "Import statement lines",
      description:
        "Loads lines of a bank statement, already parsed, for one asset account. A line with the same date, reference and amount is skipped, so importing a statement twice adds nothing. Posts nothing. Returns `imported` and `skipped`. Write access to the ledger.",
      input: { body: bankImportBody },
      output: { status: 201, schema: WithData },
      errors: [NOT_FOUND],
    }),
    async (c, input) => c.json({ data: await billing.importBankLines(input.body) }, 201)
  );

  app.get(
    "/bank-lines",
    conta("view", {
      id: "list-bank-lines",
      summary: "List statement lines",
      description:
        "Statement lines, newest first. Each pending line brings a `suggestion` of what it probably is, with its confidence, or null. `pending=true` lists only those. Read access to the ledger.",
      input: {
        query: z.object({
          accountId: id.optional().describe("Only this account"),
          pending: flag("Only lines not reconciled yet"),
          ...paged,
        }),
      },
      output: { schema: WithRows },
    }),
    async (c, input) => c.json({ data: await billing.listBankLines(input.query) })
  );

  app.get(
    "/bank-lines/summary",
    conta("view", {
      id: "get-bank-summary",
      summary: "Book against statement",
      description:
        "For one account (the operating bank by default): balance in the books, balance on the statement, the difference, and how many lines remain. Read access to the ledger.",
      input: { query: z.object({ accountId: id.optional().describe("Account to check") }) },
      output: { schema: WithData },
    }),
    async (c, input) => c.json({ data: await billing.bankSummary(input.query.accountId) })
  );

  app.get(
    "/bank-lines/:id/suggestion",
    conta("view", {
      id: "suggest-bank-match",
      summary: "Suggest a match for a statement line",
      description:
        "What this line probably is: an invoice (exact balance, client's name, or both) or a bank charge, with its confidence. `data` is null when nothing fits. 409 if already reconciled. Read access to the ledger.",
      input: { params: ParamId },
      output: { schema: z.object({ data: z.record(z.string(), z.unknown()).nullable() }).passthrough() },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.suggestForLine(input.params.id) })
  );

  app.post(
    "/bank-lines/reconcile-suggested",
    conta("write", {
      id: "reconcile-suggested-lines",
      summary: "Accept the high-confidence suggestions",
      description:
        "Reconciles every pending line whose suggestion has high confidence. A line that fails stays pending and is listed in `failed`. Write access to the ledger.",
      sensitive: true,
      input: { body: reconcileSuggestedBody },
      output: { schema: WithData },
    }),
    async (c, input) => c.json({ data: await billing.reconcileSuggested(input.body) })
  );

  app.post(
    "/bank-lines/:id/reconcile",
    conta("write", {
      id: "reconcile-bank-line",
      summary: "Reconcile a statement line",
      description:
        "Says what the line is and posts it if the books do not have it: `invoice` records a payment, `fee` a bank charge, `client_funds` a deposit of funds held for a client, `journal` links an entry already posted. 409 if already reconciled, the amounts disagree or the date is in a closed period. Write access to the ledger.",
      sensitive: true,
      input: { params: ParamId, body: bankMatchBody },
      output: { schema: WithRow },
      errors: [NOT_FOUND, CONFLICT],
    }),
    async (c, input) => c.json({ data: await billing.reconcileLine(input.params.id, input.body) })
  );

  // ── Audit trail ─────────────────────────────────────────────────────────
  app.get(
    "/audit",
    conta("view", {
      id: "list-audit-trail",
      summary: "Audit trail",
      description:
        "Every accounting action, newest first: who, when, what. It cannot be edited. Filter by `action`, `entityType`, `entityId`, date range or `q`. Read access to the ledger.",
      input: {
        query: z.object({
          action: z.string().max(64).optional().describe("Such as invoice.issued or period.closed"),
          entityType: z.string().max(64).optional().describe("Such as invoice or journal"),
          entityId: z.string().max(128).optional().describe("The row it refers to"),
          q: z.string().max(200).optional().describe("Search text"),
          dateFrom: isoDate.optional().describe("From this date"),
          dateTo: isoDate.optional().describe("Up to this date"),
          ...paged,
        }),
      },
      output: { schema: WithPagination },
    }),
    async (c, input) => c.json(await billing.listAudit(input.query))
  );

  // ── Attention ───────────────────────────────────────────────────────────
  app.get(
    "/attention",
    conta("view", {
      id: "get-attention",
      summary: "What needs attention",
      description:
        "One call for a start page: `overdue` invoices (count, amount and the 20 oldest with `invoiceId`, `number`, `clientName`, `balance`, `daysOverdue`), `severe` (overdue more than `severeDays`, 45 by default), `drafts` (count and total), `recurringDue` (active recurring fees due by `asOf`), `fundsBelowMinimum` (clients whose funds are below their minimum), `bankLinesPending` and `closedUntil`. `responsibleResourceId` narrows invoices, recurring fees and clients to the projects that resource runs. Read access to the ledger.",
      input: {
        query: asOfQuery.extend({
          responsibleResourceId: id.optional().describe("Only what belongs to the projects this resource runs"),
          severeDays: whole(3650, "Days overdue past which an invoice counts as severe. 45 by default"),
        }),
      },
      output: { schema: WithData },
    }),
    async (c, input) => c.json({ data: await reports.attention(input.query) })
  );

  // ── Reports ─────────────────────────────────────────────────────────────
  app.get(
    "/reports/aging",
    conta("view", {
      id: "get-aging",
      summary: "Receivables by age",
      description:
        "What clients owe by days overdue, as of `asOf`. `ledgerDifference` is the receivable account less the invoices: not zero when a disbursement was billed outside an invoice. Read access to the ledger.",
      input: { query: asOfQuery },
      output: { schema: WithData },
    }),
    async (c, input) => c.json({ data: await reports.aging(input.query.asOf) })
  );

  app.get(
    "/reports/aging-by-client",
    conta("view", {
      id: "get-aging-by-client",
      summary: "Receivables by age, per client",
      description: "The same as get-aging for each client, with its open invoices, largest first. Read access to the ledger.",
      input: { query: asOfQuery },
      output: { schema: WithList },
    }),
    async (c, input) => c.json({ data: await reports.agingByClient(input.query.asOf) })
  );

  app.get(
    "/reports/wip",
    conta("view", {
      id: "get-wip",
      summary: "Work in progress",
      description:
        "Work and expenses no invoice has claimed, per project and per resource, with what has waited over 30 days. Filtering by resource leaves expenses out. Read access to the ledger.",
      input: {
        query: asOfQuery.extend({
          resourceId: id.optional().describe("Only this resource"),
          projectId: id.optional().describe("Only this project"),
        }),
      },
      output: { schema: WithData },
    }),
    async (c, input) => c.json({ data: await reports.wip(input.query) })
  );

  app.get(
    "/reports/dso",
    conta("view", {
      id: "get-dso",
      summary: "Days to collect",
      description: "Average days from issue to last payment over the invoices fully paid in the last `windowDays` (90 by default). Read access to the ledger.",
      input: {
        query: asOfQuery.extend({ windowDays: whole(3660, "Days to look back") }),
      },
      output: { schema: WithData },
    }),
    async (c, input) => c.json({ data: await reports.dso(input.query) })
  );

  app.get(
    "/reports/monthly-series",
    conta("view", {
      id: "get-monthly-series",
      summary: "Billed, collected and spent per month",
      description: "For the last `months` (6 by default): fees billed net of discount, money collected and expenses in the ledger. Read access to the ledger.",
      input: {
        query: asOfQuery.extend({ months: whole(60, "How many months") }),
      },
      output: { schema: WithList },
    }),
    async (c, input) => c.json({ data: await reports.monthlySeries(input.query) })
  );

  app.get(
    "/reports/profitability/projects",
    conta("view", {
      id: "get-project-profitability",
      summary: "Profitability per project",
      description:
        "Quantity worked, billed and unbilled per unit, realization by value, work in progress, revenue, cost and margin of each project. Read access to the ledger.",
      input: {
        query: z.object({
          responsibleResourceId: id.optional().describe("Only the projects this person runs"),
        }),
      },
      output: { schema: WithList },
    }),
    async (c, input) => c.json({ data: await reports.profitabilityByProject(input.query) })
  );

  app.get(
    "/reports/profitability/resources",
    conta("view", {
      id: "get-resource-profitability",
      summary: "Profitability per resource",
      description:
        "Quantity worked, billed and unbilled in the resource's unit, realization by value, work in progress, billed value, cost and margin of each resource. Read access to the ledger.",
      output: { schema: WithList },
    }),
    async (c) => c.json({ data: await reports.profitabilityByResource() })
  );

  app.get(
    "/reports/billing-by-client",
    conta("view", {
      id: "get-billing-by-client",
      summary: "Billing per client",
      description: "Fees billed, money collected, balance owed and collection rate of each client. Read access to the ledger.",
      output: { schema: WithList },
    }),
    async (c) => c.json({ data: await reports.billingByClient() })
  );

  app.get(
    "/reports/billing-by-category",
    conta("view", {
      id: "get-billing-by-category",
      summary: "Billing per category",
      description: "Fees billed, invoices, projects and share of each category. Read access to the ledger.",
      output: { schema: WithList },
    }),
    async (c) => c.json({ data: await reports.billingByCategory() })
  );

  app.get(
    "/reports/resource-performance",
    conta("view", {
      id: "get-resource-performance",
      summary: "Billing per resource",
      description:
        "For each resource, the projects they run and the invoices of those projects or with a line of theirs: billed, collected, pending, collection rate. Read access to the ledger.",
      output: { schema: WithList },
    }),
    async (c) => c.json({ data: await reports.resourcePerformance() })
  );
}
