import { defineKonSdk, messageOf } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";
import { sql } from "drizzle-orm";
import type { Hono } from "hono";

import { contaOperations, createContaRouter } from "./conta.routes";
import { ContaService } from "./conta.service";
import { KON_ID } from "./operations";

// Re-export schema for schema-merger
export * from "./conta.schema";

// "conta" policy (accounting role) — registered on import.
export { registerContaPolicy, type ContaResource } from "./conta.policy";

// Re-export shared types
export type { ContaDb } from "./types";

// Re-export engine for advanced usage
export {
  ContaService,
  AccountingError,
  validateLedgerLines,
  applyJournalTemplate,
  type ValidationResult,
  type TemplateVariables,
} from "./conta.service";

export { BillingService, computeInvoiceTotals, invoiceDisplayStatus, suggestBankMatch } from "./conta.billing";
export { ContaReports } from "./conta.reports";
export {
  ensureProject,
  ensureClient,
  clientStatement,
  recordProjectWork,
  recordProjectExpense,
  applyContaPreset,
} from "./conta.bridge";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export { contaOperations, createContaRouter };

export function createKonConta(ctx: KonContext): Hono {
  return createContaRouter(ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`contaOperations`), with its OpenAPI and its MCP tool.
 *
 * `createRouter` is replaced by the usual one (`createKonConta`): the operations
 * router with the kon's `onError`, which gives business errors
 * (`AccountingError`) their status and message and never lets Postgres
 * text out (http-errors.ts).
 */
const definition = defineKonSdk({
  id: KON_ID,
  name: "Accounting",
  version: manifest.version,
  description:
    "General Ledger Engine with double entry, multi-currency, journal templates and JSONB metadata, plus what a business that bills clients runs through it: invoices, payments, work by quantity and rate, recurring fees, success fees, client funds, bank reconciliation, period close and an audit trail.",
  icon: "Landmark",
  mountPath: "/api/conta",
  operations: (ctx: KonContext) => contaOperations(ctx),

  tables: konTables,

  admin: {
    category: "data",
    views: [
      { id: "accounts", type: "grid", title: "Accounts", table: "conta_accounts" },
      { id: "journals", type: "grid", title: "Journals", table: "conta_journals" },
      { id: "ledger", type: "grid", title: "Ledger lines", table: "conta_ledger_entries" },
      { id: "projects", type: "grid", title: "Projects", table: "conta_projects" },
      { id: "templates", type: "grid", title: "Templates", table: "conta_journal_templates" },
      { id: "invoices", type: "grid", title: "Invoices", table: "conta_invoices" },
      { id: "work-entries", type: "grid", title: "Work entries", table: "conta_work_entries" },
      { id: "recurring-fees", type: "grid", title: "Recurring fees", table: "conta_recurring_fees" },
      { id: "bank-lines", type: "grid", title: "Bank statement", table: "conta_bank_lines" },
      { id: "audit", type: "grid", title: "Audit trail", table: "conta_audit_log" },
    ],
  },

  dependencies: {
    kons: [],
    core: ["auth"],
  },

  hooks: {
    /**
     * Startup only CHECKS. Tables come from the kon's migrations, which the host's runner applies
     * (`kitsuden kon add`, the migration step of a deploy); a kon never runs them itself. The default
     * currencies and chart of accounts are seeded once, on the first start that finds no account,
     * so an admin who renames or removes a default account does not see it come back on the next
     * boot. To seed again on purpose: `POST /api/conta/seed` (`seed-chart-of-accounts`).
     */
    onStartup: async (ctx: KonContext) => {
      try {
        const missing: string[] = [];
        for (const table of konTables) {
          if (!(await ctx.db.tableExists(table))) missing.push(table);
        }
        if (missing.length > 0) {
          ctx.logger.warn("[Conta] Tables missing: run the kon's migrations", { missing });
          return;
        }

        const result = await ctx.db.instance.execute(
          sql`SELECT EXISTS (SELECT 1 FROM conta_accounts) AS "hasAccounts"`
        );
        const row = (result as { rows?: Array<{ hasAccounts?: unknown }> }).rows?.[0];
        if (row?.hasAccounts === true || row?.hasAccounts === "t") return;

        await new ContaService(ctx.db.instance).seedDefaultAccounts();
        ctx.logger.info("[Conta] Default currencies and chart of accounts seeded (first start)");
      } catch (err: unknown) {
        ctx.logger.error("[Conta] Startup check failed", { error: messageOf(err) });
      }
    },
    onEnable: async (ctx: KonContext) => {
      ctx.logger.info("✅ Kon Conta enabled");
    },
    onDisable: async (ctx: KonContext) => {
      ctx.logger.info("🛑 Kon Conta disabled");
    },
  },
});

export const kon: KonDefinition = { ...definition, createRouter: createKonConta };

export default kon;
