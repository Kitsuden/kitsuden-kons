/**
 * Conta — General Ledger Engine
 *
 * Architecture:
 *   - Journals      = Entry headers (date, description, metadata)
 *   - LedgerEntries = Double-entry lines (account_id, debit, credit, currency)
 *   - T-Accounts    = Aggregated views ONLY (no separate table)
 *
 * Moldable by design:
 *   - metadata (JSONB) carries domain-specific data (case_id, store_id, etc.)
 *   - journal_templates translate business events into ledger entries
 *   - currencies are first-class citizens on every ledger line
 */

import { createId } from "@paralleldrive/cuid2";
import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  numeric,
  integer,
  boolean,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  bigint,
} from "drizzle-orm/pg-core";

// ═══════════════════════════════════════════════════════════════════════════
// Enums
// ═══════════════════════════════════════════════════════════════════════════

export const accountTypeEnum = pgEnum("conta_account_type", [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
]);

export const entryStatusEnum = pgEnum("conta_entry_status", ["draft", "posted", "reversed"]);

export const counterpartyTypeEnum = pgEnum("conta_counterparty_type", [
  "client",
  "vendor",
  "bank",
  "other",
]);

export const projectStatusEnum = pgEnum("conta_project_status", ["open", "closed", "on_hold"]);

export const disbursementStatusEnum = pgEnum("conta_disbursement_status", [
  "pending",
  "billed",
  "paid",
]);

export const journalTypeEnum = pgEnum("conta_journal_type", [
  "standard",
  "client_funds_deposit",
  "client_funds_disbursement",
  "disbursement",
  "disbursement_billed",
  "invoice",
  "credit_note",
  "payment",
  "client_funds_refund",
  "client_funds_application",
  "bank_fee",
]);

/**
 * Who is asking, taken from the request's RLS context. A column default, so the database fills it
 * in and neither a route nor a client can write somebody else's id there.
 */
const currentUser = sql`NULLIF(current_setting('app.current_user_id', true), '')`;

// ═══════════════════════════════════════════════════════════════════════════
// Currencies
// ═══════════════════════════════════════════════════════════════════════════

export const currencies = pgTable("conta_currencies", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  decimalPlaces: integer("decimal_places").default(2).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Counterparties
// ═══════════════════════════════════════════════════════════════════════════

export const counterparties = pgTable(
  "conta_counterparties",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    name: text("name").notNull(),
    email: text("email"),
    taxId: text("tax_id"),
    type: counterpartyTypeEnum("type").notNull(),
    contactName: text("contact_name"),
    /** Days to pay. Null: the default in `conta_settings`. */
    paymentTermsDays: integer("payment_terms_days"),
    /** Funds balance below which the client is asked to top up. */
    fundsMinimum: numeric("funds_minimum", { precision: 19, scale: 4 }).default("0").notNull(),
    externalRef: text("external_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_cp_type").on(t.type),
    index("idx_conta_cp_tax").on(t.taxId),
    uniqueIndex("idx_conta_cp_external_ref").on(t.externalRef),
  ]
);

export const counterpartiesRelations = relations(counterparties, ({ many }) => ({
  projects: many(projects),
  journals: many(journals),
}));

// ═══════════════════════════════════════════════════════════════════════════
// Projects
// ═══════════════════════════════════════════════════════════════════════════

export const BILLING_TYPES = ["time", "fixed", "recurring", "success"] as const;
export type BillingType = (typeof BILLING_TYPES)[number];

export const projects = pgTable(
  "conta_projects",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    clientId: text("client_id")
      .notNull()
      .references(() => counterparties.id),
    number: text("number").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    status: projectStatusEnum("status").default("open").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** Id of this project in another system, for example a CRM deal id. */
    externalRef: text("external_ref"),
    billingType: text("billing_type").$type<BillingType>().default("time").notNull(),
    category: text("category"),
    responsibleResourceId: text("responsible_resource_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_projects_client").on(t.clientId),
    index("idx_conta_projects_status").on(t.status),
    index("idx_conta_projects_responsible").on(t.responsibleResourceId),
    uniqueIndex("idx_conta_projects_external_ref").on(t.externalRef),
  ]
);

export const projectsRelations = relations(projects, ({ one, many }) => ({
  client: one(counterparties, {
    fields: [projects.clientId],
    references: [counterparties.id],
  }),
  ledgerEntries: many(ledgerEntries),
  disbursements: many(disbursements),
}));

// ═══════════════════════════════════════════════════════════════════════════
// Accounts (Chart of Accounts)
// ═══════════════════════════════════════════════════════════════════════════

export const accounts = pgTable(
  "conta_accounts",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    type: accountTypeEnum("type").notNull(),
    parentAccountId: text("parent_account_id"),
    openingBalance: numeric("opening_balance", { precision: 19, scale: 4 }).default("0").notNull(),
    currentBalance: numeric("current_balance", { precision: 19, scale: 4 }).default("0").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    isClientFundsAccount: boolean("is_client_funds_account").default(false).notNull(),
    level: integer("level").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_accounts_type").on(t.type),
    index("idx_conta_accounts_parent").on(t.parentAccountId),
    index("idx_conta_accounts_active").on(t.isActive),
    index("idx_conta_accounts_client_funds").on(t.isClientFundsAccount),
  ]
);

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  parent: one(accounts, {
    fields: [accounts.parentAccountId],
    references: [accounts.id],
  }),
  children: many(accounts),
  ledgerEntries: many(ledgerEntries),
}));

// ═══════════════════════════════════════════════════════════════════════════
// Journal Templates (Moldable Business Logic)
// ═══════════════════════════════════════════════════════════════════════════

export const journalTemplates = pgTable(
  "conta_journal_templates",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    name: text("name").notNull(),
    description: text("description"),
    templateType: text("template_type").notNull(),
    rules: jsonb("rules").notNull().$type<
      Array<{
        accountCode: string;
        side: "debit" | "credit";
        amountFormula: string; // e.g. "total", "total * 0.07", "amount"
        description?: string;
      }>
    >(),
    requiredMetadata: jsonb("required_metadata").default([]).$type<string[]>(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_templates_type").on(t.templateType),
    index("idx_conta_templates_active").on(t.isActive),
  ]
);

// ═══════════════════════════════════════════════════════════════════════════
// Journals (Entry Headers)
// ═══════════════════════════════════════════════════════════════════════════

export const journals = pgTable(
  "conta_journals",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    date: text("date").notNull(),
    description: text("description").notNull(),
    reference: text("reference"),
    counterpartyId: text("counterparty_id").references(() => counterparties.id),
    totalAmount: numeric("total_amount", { precision: 19, scale: 4 }).default("0").notNull(),
    status: entryStatusEnum("status").default("draft").notNull(),
    journalType: journalTypeEnum("journal_type").default("standard").notNull(),
    templateId: text("template_id").references(() => journalTemplates.id),
    metadata: jsonb("metadata").default({}).$type<Record<string, unknown>>(),
    reversalOfId: text("reversal_of_id"),
    createdBy: text("created_by").default(currentUser),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_journals_date").on(t.date),
    index("idx_conta_journals_status").on(t.status),
    index("idx_conta_journals_type").on(t.journalType),
    index("idx_conta_journals_counterparty").on(t.counterpartyId),
    index("idx_conta_journals_template").on(t.templateId),
  ]
);

export const journalsRelations = relations(journals, ({ one, many }) => ({
  counterparty: one(counterparties, {
    fields: [journals.counterpartyId],
    references: [counterparties.id],
  }),
  template: one(journalTemplates, {
    fields: [journals.templateId],
    references: [journalTemplates.id],
  }),
  ledgerEntries: many(ledgerEntries),
  reversalOf: one(journals, {
    fields: [journals.reversalOfId],
    references: [journals.id],
  }),
}));

// ═══════════════════════════════════════════════════════════════════════════
// Ledger Entries (Double-Entry Lines)
// ═══════════════════════════════════════════════════════════════════════════

export const ledgerEntries = pgTable(
  "conta_ledger_entries",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    journalId: text("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    projectId: text("project_id").references(() => projects.id),
    description: text("description"),
    debit: numeric("debit", { precision: 19, scale: 4 }).default("0").notNull(),
    credit: numeric("credit", { precision: 19, scale: 4 }).default("0").notNull(),
    currency: text("currency")
      .notNull()
      .references(() => currencies.code)
      .default("USD"),
    exchangeRate: numeric("exchange_rate", { precision: 19, scale: 8 }).default("1").notNull(),
    metadata: jsonb("metadata").default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_ledger_journal").on(t.journalId),
    index("idx_conta_ledger_account").on(t.accountId),
    index("idx_conta_ledger_project").on(t.projectId),
    index("idx_conta_ledger_currency").on(t.currency),
    index("idx_conta_ledger_created").on(t.createdAt),
  ]
);

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  journal: one(journals, {
    fields: [ledgerEntries.journalId],
    references: [journals.id],
  }),
  account: one(accounts, {
    fields: [ledgerEntries.accountId],
    references: [accounts.id],
  }),
  project: one(projects, {
    fields: [ledgerEntries.projectId],
    references: [projects.id],
  }),
  currencyRef: one(currencies, {
    fields: [ledgerEntries.currency],
    references: [currencies.code],
  }),
}));

// ═══════════════════════════════════════════════════════════════════════════
// Disbursements
// ═══════════════════════════════════════════════════════════════════════════

export const disbursements = pgTable(
  "conta_disbursements",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    journalId: text("journal_id").references(() => journals.id),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    status: disbursementStatusEnum("status").default("pending").notNull(),
    date: text("date").notNull(),
    category: text("category"),
    /** The invoice that bills it, draft included. Null: still in work in progress. */
    invoiceId: text("invoice_id"),
    externalRef: text("external_ref"),
    createdBy: text("created_by").default(currentUser),
    billedAt: timestamp("billed_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_disb_project").on(t.projectId),
    index("idx_conta_disb_status").on(t.status),
    index("idx_conta_disb_journal").on(t.journalId),
    index("idx_conta_disb_invoice").on(t.invoiceId),
    uniqueIndex("idx_conta_disb_external_ref").on(t.externalRef),
  ]
);

export const disbursementsRelations = relations(disbursements, ({ one }) => ({
  project: one(projects, {
    fields: [disbursements.projectId],
    references: [projects.id],
  }),
  journal: one(journals, {
    fields: [disbursements.journalId],
    references: [journals.id],
  }),
}));

// ═══════════════════════════════════════════════════════════════════════════
// Accounting permissions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Who can get into the accounting, besides `admin`s.
 *
 * The account role (`auth_users.role`) only distinguishes admin/editor/user, and
 * sign-up is public: "having a session" cannot mean "seeing the general ledger".
 * This table is the "accounting role": an admin manages it from
 * `/api/conta/permissions` and the `conta` policy and the RLS policies
 * (via `conta_current_role()`) consult it.
 *
 *   · contable → reads and writes (journals, accounts, expenses…)
 *   · consulta → read only (audit, management)
 */
export const CONTA_ROLES = ["accountant", "viewer"] as const;
export type ContaRole = (typeof CONTA_ROLES)[number];

export const contaPermissions = pgTable("conta_permissions", {
  userId: text("user_id").primaryKey(),
  role: text("role").$type<ContaRole>().notNull(),
  grantedBy: text("granted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The accounts each kind of movement posts to, by code. A business with its own chart of accounts
 * changes the codes here, not the code.
 */
export const DEFAULT_ACCOUNT_CODES = {
  cash: "1000",
  operatingBank: "1100",
  clientFundsBank: "1150",
  receivable: "1200",
  reimbursable: "1250",
  clientFundsLiability: "2100",
  taxPayable: "2200",
  feeRevenue: "4000",
  recurringFeeRevenue: "4100",
  successFeeRevenue: "4200",
  bankCharges: "6100",
} as const;
export type AccountRole = keyof typeof DEFAULT_ACCOUNT_CODES;

/**
 * What an installation calls things. The code says project, resource, client funds, recurring fee
 * and success fee. A workshop may show Job, Machine and Deposit, a training centre Course, Room
 * and Prepayment: the API returns these labels and a front end shows them.
 */
export const LABEL_KEYS = ["project", "resource", "clientFunds", "recurringFee", "successFee"] as const;
export type LabelKey = (typeof LABEL_KEYS)[number];
export type Labels = Record<LabelKey, { singular: string; plural: string }>;
export const DEFAULT_LABELS: Labels = {
  project: { singular: "Project", plural: "Projects" },
  resource: { singular: "Resource", plural: "Resources" },
  clientFunds: { singular: "Client funds", plural: "Client funds" },
  recurringFee: { singular: "Recurring fee", plural: "Recurring fees" },
  successFee: { singular: "Success fee", plural: "Success fees" },
};

/**
 * Who issues the documents, as printed on them. Every field is optional text: an installation fills
 * what its documents show. `logoMediaId` is the id of an image in the media library.
 */
export const ISSUER_KEYS = [
  "name",
  "legalName",
  "taxId",
  "address",
  "email",
  "phone",
  "bankDetails",
  "logoMediaId",
  "invoiceFooter",
] as const;
export type IssuerKey = (typeof ISSUER_KEYS)[number];
export type Issuer = Partial<Record<IssuerKey, string>>;

/** A goal the business measures itself against: an amount of some metric per month, quarter or year. */
export const TARGET_PERIODS = ["month", "quarter", "year"] as const;
export type TargetPeriod = (typeof TARGET_PERIODS)[number];
export interface Target {
  /** What is measured, named by the installation: billed, collected, worked… */
  metric: string;
  period: TargetPeriod;
  /** Decimal text, like every amount. */
  amount: string;
}

/** One row (`id = 'default'`), created by the migration. The tax rate lives here, not in code. */
export const contaSettings = pgTable("conta_settings", {
  id: text("id").primaryKey().default("default"),
  baseCurrency: text("base_currency").default("USD").notNull(),
  defaultTaxRate: numeric("default_tax_rate", { precision: 7, scale: 6 }).default("0").notNull(),
  /** Rates offered when billing, as decimal text ("0.07"). */
  taxRates: jsonb("tax_rates").default([]).notNull().$type<string[]>(),
  defaultPaymentTermsDays: integer("default_payment_terms_days").default(30).notNull(),
  invoicePrefix: text("invoice_prefix").default("INV").notNull(),
  creditNotePrefix: text("credit_note_prefix").default("CN").notNull(),
  numberPadding: integer("number_padding").default(4).notNull(),
  /** Last closed date: nothing posts on or before it. Null: no period is closed. */
  lockedUntil: text("locked_until"),
  accountCodes: jsonb("account_codes").default({}).notNull().$type<Partial<Record<AccountRole, string>>>(),
  bankFeeKeywords: jsonb("bank_fee_keywords").default([]).notNull().$type<string[]>(),
  /** Display names, merged over `DEFAULT_LABELS`. */
  labels: jsonb("labels").default({}).notNull().$type<Partial<Labels>>(),
  /** The billing types this installation offers. Projects and invoices only take these. */
  billingTypes: jsonb("billing_types").default([...BILLING_TYPES]).notNull().$type<BillingType[]>(),
  /** Who issues the documents. Fields merge on update: changing one keeps the others. */
  issuer: jsonb("issuer").default({}).notNull().$type<Issuer>(),
  /** Targets, replaced as a whole on update. */
  targets: jsonb("targets").default([]).notNull().$type<Target[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Gapless numbering per document kind and year. */
export const numberSequences = pgTable("conta_number_sequences", {
  key: text("key").primaryKey(),
  nextValue: bigint("next_value", { mode: "number" }).notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Resources and work entries
// ═══════════════════════════════════════════════════════════════════════════

export const resources = pgTable(
  "conta_resources",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    /** A person's account, when the resource is a person who has one. */
    userId: text("user_id"),
    externalRef: text("external_ref"),
    name: text("name").notNull(),
    title: text("title"),
    /** What the rates are per: hour by default, or day, unit, session… */
    unit: text("unit").default("hour").notNull(),
    billingRate: numeric("billing_rate", { precision: 19, scale: 4 }).default("0").notNull(),
    costRate: numeric("cost_rate", { precision: 19, scale: 4 }).default("0").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_conta_resources_user").on(t.userId),
    uniqueIndex("idx_conta_resources_external_ref").on(t.externalRef),
  ]
);

export const workEntries = pgTable(
  "conta_work_entries",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    date: text("date").notNull(),
    description: text("description").notNull(),
    /** How much, in `unit`: billed as quantity times `billingRate`. */
    quantity: numeric("quantity", { precision: 12, scale: 4 }).notNull(),
    /** The resource's unit when it was recorded. */
    unit: text("unit").default("hour").notNull(),
    /** Rates as they were that day: changing a resource's rate does not rewrite old work. */
    billingRate: numeric("billing_rate", { precision: 19, scale: 4 }).notNull(),
    costRate: numeric("cost_rate", { precision: 19, scale: 4 }).default("0").notNull(),
    /** The invoice that bills it, draft included. Null: unbilled work in progress. */
    invoiceId: text("invoice_id"),
    /** Id in another system, for example a CRM activity. Recording it twice returns the same row. */
    externalRef: text("external_ref"),
    createdBy: text("created_by").default(currentUser),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_work_project").on(t.projectId),
    index("idx_conta_work_resource").on(t.resourceId),
    index("idx_conta_work_invoice").on(t.invoiceId),
    index("idx_conta_work_date").on(t.date),
    uniqueIndex("idx_conta_work_external_ref").on(t.externalRef),
  ]
);

// ═══════════════════════════════════════════════════════════════════════════
// Invoices
// ═══════════════════════════════════════════════════════════════════════════

export const INVOICE_STATUSES = ["draft", "issued", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const invoices = pgTable(
  "conta_invoices",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    /** Null until it is issued: a draft has no number. */
    number: text("number").unique(),
    status: text("status").$type<InvoiceStatus>().default("draft").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => counterparties.id),
    projectId: text("project_id").references(() => projects.id),
    concept: text("concept").notNull(),
    feeType: text("fee_type").$type<BillingType>().default("time").notNull(),
    revenueAccountId: text("revenue_account_id")
      .notNull()
      .references(() => accounts.id),
    currency: text("currency").notNull(),
    issueDate: text("issue_date").notNull(),
    dueDate: text("due_date").notNull(),
    termsDays: integer("terms_days").notNull(),
    taxRate: numeric("tax_rate", { precision: 7, scale: 6 }).default("0").notNull(),
    discount: numeric("discount", { precision: 19, scale: 4 }).default("0").notNull(),
    fees: numeric("fees", { precision: 19, scale: 4 }).default("0").notNull(),
    expenses: numeric("expenses", { precision: 19, scale: 4 }).default("0").notNull(),
    feesNet: numeric("fees_net", { precision: 19, scale: 4 }).default("0").notNull(),
    tax: numeric("tax", { precision: 19, scale: 4 }).default("0").notNull(),
    total: numeric("total", { precision: 19, scale: 4 }).default("0").notNull(),
    amountPaid: numeric("amount_paid", { precision: 19, scale: 4 }).default("0").notNull(),
    journalId: text("journal_id").references(() => journals.id),
    voidJournalId: text("void_journal_id").references(() => journals.id),
    creditNoteNumber: text("credit_note_number").unique(),
    voidReason: text("void_reason"),
    voidedOn: text("voided_on"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    /** Where it came from: manual, wip, recurringFee, successFee. */
    source: text("source").default("manual").notNull(),
    externalRef: text("external_ref"),
    createdBy: text("created_by").default(currentUser),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_invoices_status").on(t.status),
    index("idx_conta_invoices_client").on(t.clientId),
    index("idx_conta_invoices_project").on(t.projectId),
    index("idx_conta_invoices_issue_date").on(t.issueDate),
    index("idx_conta_invoices_due_date").on(t.dueDate),
  ]
);

export const invoiceLines = pgTable(
  "conta_invoice_lines",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    position: integer("position").default(0).notNull(),
    kind: text("kind").$type<"fee" | "expense">().default("fee").notNull(),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 4 }).default("1").notNull(),
    unit: text("unit"),
    unitPrice: numeric("unit_price", { precision: 19, scale: 4 }).default("0").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).default("0").notNull(),
    resourceId: text("resource_id").references(() => resources.id),
    lineDate: text("line_date"),
    workEntryId: text("work_entry_id"),
    disbursementId: text("disbursement_id"),
  },
  (t) => [
    index("idx_conta_invoice_lines_invoice").on(t.invoiceId),
    index("idx_conta_invoice_lines_resource").on(t.resourceId),
  ]
);

export const invoicePayments = pgTable(
  "conta_invoice_payments",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    date: text("date").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    source: text("source").$type<"account" | "client_funds">().default("account").notNull(),
    /** The account the money went into. */
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    method: text("method"),
    reference: text("reference"),
    journalId: text("journal_id")
      .notNull()
      .references(() => journals.id),
    reversalJournalId: text("reversal_journal_id").references(() => journals.id),
    reversedOn: text("reversed_on"),
    bankLineId: text("bank_line_id"),
    /** A file kept with the payment, such as a receipt: its id in the media library. */
    attachmentMediaId: text("attachment_media_id"),
    createdBy: text("created_by").default(currentUser),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_payments_invoice").on(t.invoiceId),
    index("idx_conta_payments_date").on(t.date),
  ]
);

export const invoiceReminders = pgTable(
  "conta_invoice_reminders",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    channel: text("channel").notNull(),
    note: text("note"),
    createdBy: text("created_by").default(currentUser),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_conta_reminders_invoice").on(t.invoiceId)]
);

// ═══════════════════════════════════════════════════════════════════════════
// Recurring fees and success fees
// ═══════════════════════════════════════════════════════════════════════════

export const RECURRING_FREQUENCIES = ["monthly", "quarterly", "semiannual", "annual"] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

export const recurringFees = pgTable(
  "conta_recurring_fees",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    clientId: text("client_id")
      .notNull()
      .references(() => counterparties.id),
    projectId: text("project_id").references(() => projects.id),
    concept: text("concept").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    /** Work included in the amount, in `unit`. Reported against, never billed on its own. */
    quantityIncluded: numeric("quantity_included", { precision: 12, scale: 4 }).default("0").notNull(),
    unit: text("unit").default("hour").notNull(),
    frequency: text("frequency").$type<RecurringFrequency>().default("monthly").notNull(),
    nextDate: text("next_date").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    since: text("since").notNull(),
    lastInvoiceId: text("last_invoice_id").references(() => invoices.id),
    externalRef: text("external_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_recurring_fees_client").on(t.clientId),
    index("idx_conta_recurring_fees_due").on(t.isActive, t.nextDate),
  ]
);

export const successFees = pgTable(
  "conta_success_fees",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    clientId: text("client_id")
      .notNull()
      .references(() => counterparties.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    baseAmount: numeric("base_amount", { precision: 19, scale: 4 }).notNull(),
    /** Share of the base amount, 0 to 1. */
    percentage: numeric("percentage", { precision: 7, scale: 6 }).notNull(),
    /** Estimated chance of winning, 0 to 1. */
    probability: numeric("probability", { precision: 7, scale: 6 }).default("0").notNull(),
    stage: text("stage"),
    expectedDate: text("expected_date"),
    status: text("status").$type<"open" | "won" | "lost">().default("open").notNull(),
    achievedAmount: numeric("achieved_amount", { precision: 19, scale: 4 }),
    settledOn: text("settled_on"),
    invoiceId: text("invoice_id").references(() => invoices.id),
    externalRef: text("external_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_success_fees_client").on(t.clientId),
    index("idx_conta_success_fees_status").on(t.status),
  ]
);

// ═══════════════════════════════════════════════════════════════════════════
// Bank statement lines
// ═══════════════════════════════════════════════════════════════════════════

export const BANK_MATCH_KINDS = ["invoice", "fee", "client_funds", "journal", "transfer"] as const;
export type BankMatchKind = (typeof BANK_MATCH_KINDS)[number];

export const bankLines = pgTable(
  "conta_bank_lines",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    /** The account in the chart this statement belongs to. */
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    date: text("date").notNull(),
    description: text("description").notNull(),
    reference: text("reference"),
    /** Signed: money in is positive. */
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    matchKind: text("match_kind").$type<BankMatchKind>(),
    matchLabel: text("match_label"),
    matchId: text("match_id"),
    journalId: text("journal_id").references(() => journals.id),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconciledBy: text("reconciled_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_conta_bank_lines_account").on(t.accountId),
    index("idx_conta_bank_lines_date").on(t.date),
    uniqueIndex("idx_conta_bank_lines_identity").on(t.accountId, t.date, t.reference, t.amount),
  ]
);

// ═══════════════════════════════════════════════════════════════════════════
// Audit trail
// ═══════════════════════════════════════════════════════════════════════════

/** Append-only: RLS has no UPDATE or DELETE policy on this table. */
export const auditLog = pgTable(
  "conta_audit_log",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    actorId: text("actor_id").default(currentUser),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    detail: jsonb("detail").default({}).notNull().$type<Record<string, unknown>>(),
  },
  (t) => [
    index("idx_conta_audit_at").on(t.at),
    index("idx_conta_audit_action").on(t.action),
    index("idx_conta_audit_entity").on(t.entityType, t.entityId),
  ]
);

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type ContaPermission = typeof contaPermissions.$inferSelect;

export type Currency = typeof currencies.$inferSelect;
export type NewCurrency = typeof currencies.$inferInsert;

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export type Counterparty = typeof counterparties.$inferSelect;
export type NewCounterparty = typeof counterparties.$inferInsert;

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type JournalTemplate = typeof journalTemplates.$inferSelect;
export type NewJournalTemplate = typeof journalTemplates.$inferInsert;

export type Journal = typeof journals.$inferSelect;
export type NewJournal = typeof journals.$inferInsert;

export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;

export type Disbursement = typeof disbursements.$inferSelect;
export type NewDisbursement = typeof disbursements.$inferInsert;

export type ContaSettings = typeof contaSettings.$inferSelect;
export type Resource = typeof resources.$inferSelect;
export type WorkEntry = typeof workEntries.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type InvoicePayment = typeof invoicePayments.$inferSelect;
export type InvoiceReminder = typeof invoiceReminders.$inferSelect;
export type RecurringFee = typeof recurringFees.$inferSelect;
export type SuccessFee = typeof successFees.$inferSelect;
export type BankLine = typeof bankLines.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
