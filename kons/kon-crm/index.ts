/**
 * @kitsuden/kon-crm — CRM & Pipeline Management (Kon)
 *
 * Complete CRM system with:
 * - Companies (accounts)
 * - Contacts (people)
 * - Pipelines & Stages
 * - Deals with Kanban view
 * - Activities (calls, emails, meetings, tasks)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE:
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is a Business Kon (Layer 3) that receives all dependencies via
 * injected context. It does NOT import from apps/api/src.
 *
 *   ┌─────────────────────────────────────────┐
 *   │  Kon Loader (apps/api/src)         │
 *   │  ├─ Creates KonContext             │
 *   │  ├─ Calls createRouter(ctx)             │
 *   │  └─ Mounts at /api/crm                  │
 *   └─────────────────────────────────────────┘
 *                   │
 *                   ▼ injects
 *   ┌─────────────────────────────────────────┐
 *   │  kon-crm (this package)            │
 *   │  ├─ Routes (crm.routes.ts)              │
 *   │  ├─ Schema (crm.schema.ts)              │
 *   │  └─ Uses ctx.db, ctx.auth, ctx.logger   │
 *   └─────────────────────────────────────────┘
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonDefinition, KonContext } from "@kitsuden/shared";

import { CRM_TOOLSETS } from "./crm.agents";
import { createCRMRouter, crmOperations } from "./crm.routes";
import { KON_ID } from "./operations";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

// Re-export schema and types
export * from "./crm.schema";

// Re-export router factory
export { createCRMRouter, crmOperations } from "./crm.routes";

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The admin views are kon.json's `admin.views`, the list the admin registry serves. A second list
 * here had drifted from it (no settings or setup views, another category, another title).
 */
type AdminView = NonNullable<NonNullable<Parameters<typeof defineKonSdk>[0]["admin"]>["views"]>[number];
const adminConfig = {
  // kon.json says `business`; the admin registry files every kon category it does not know under
  // `data`, which is the closest value this type allows.
  category: "data" as const,
  views: manifest.admin.views.map(
    (v): AdminView => ({
      id: v.id,
      type: v.type as AdminView["type"],
      title: v.title,
      ...("table" in v ? { table: v.table } : {}),
      ...("element" in v ? { element: v.element, src: v.src } : {}),
    })
  ),
};

// ═══════════════════════════════════════════════════════════════════════════
// HOOKS
// ═══════════════════════════════════════════════════════════════════════════

const hooks = {
  /**
   * Startup only CHECKS. Tables come from the kon's migrations, which the host's runner applies
   * (`kitsuden kon add`, the migration step of a deploy); a kon never runs them itself. It used
   * to: with a table missing it read every `.sql` under the working directory and executed it,
   * outside the runner's ledger (so the runner would apply them again) and as the application
   * role, which cannot create tables.
   */
  onStartup: async (ctx: KonContext) => {
    // The kon's emails: registered in the shared Mailer, without touching the host.
    const { mail } = await import("@kitsuden/engine");
    const { registerCrmMails } = await import("./crm.mails");
    registerCrmMails(mail);
    ctx.logger.info("[CRM] Mailables registered");

    try {
      const missing: string[] = [];
      for (const table of konTables) {
        if (!(await ctx.db.tableExists(table))) missing.push(table);
      }
      if (missing.length > 0) {
        ctx.logger.warn("[CRM] Tables missing: run the kon's migrations", { missing });
        return;
      }
      ctx.logger.info("[CRM] ✓ All tables verified");
    } catch (err) {
      ctx.logger.error("[CRM] Failed to verify tables", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * onShutdown: Cleanup
   */
  onShutdown: async (ctx: KonContext) => {
    ctx.logger.info("[CRM] Shutting down...");
  },

  /**
   * onEnable: Setup when enabled
   */
  onEnable: async (ctx: KonContext) => {
    ctx.logger.info("[CRM] Enabled");
  },

  /**
   * onDisable: Cleanup when disabled
   */
  onDisable: async (ctx: KonContext) => {
    ctx.logger.info("[CRM] Disabled - routes will be removed");
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// KON DEFINITION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`crmOperations`), with its OpenAPI, its MCP tool and its fine-grained scope
 * `kon:crm:<id>`.
 *
 * `createRouter` is replaced by the usual one (`createCRMRouter`): the
 * operations router behind `rlsContext`, which leaves each route the request's `db`
 * and session, and with `respondError` for what is not an
 * `AppError`.
 */
const definition = defineKonSdk({
  // Identity
  id: KON_ID,
  name: "CRM & Pipeline",
  version: manifest.version,
  description:
    "Complete CRM system with contacts, companies, deal pipelines, and activity management.",

  // Icon
  icon: "Briefcase",

  // Mount point
  mountPath: "/api/crm",

  // SDK operations (the router is set by `createCRMRouter`, below)
  operations: (ctx: KonContext) => crmOperations(ctx),

  // Admin configuration
  admin: adminConfig,

  // Tables it manages
  tables: konTables,

  // Forms and the client portal have no account behind them. Inbound email comes from a few provider
  // addresses, already signed, in bursts: it gets its own, wider limit (every matching rule applies, so no
  // catch-all `/public/*` here).
  rateLimits: [
    { path: "/public/forms/*", limit: 20, window: 60, message: "Too many attempts. Try again in a minute." },
    { path: "/public/portal", limit: 20, window: 60, message: "Too many attempts. Try again in a minute." },
    { path: "/public/inbound/*", limit: 300, window: 60, message: "Too many emails at once. The provider will retry." },
  ],

  // Groups of tools for agents, asked for as `kon:crm/<group>` (see crm.agents.ts).
  mcpToolsets: CRM_TOOLSETS,

  // Dependencies
  // Dependencies: kon.json's (kon-conta is optional, `optionalKons`, reached by a runtime import)
  dependencies: {
    kons: manifest.dependencies.kons,
    core: manifest.dependencies.core,
  },

  // Hooks
  hooks,
});

export const kon: KonDefinition = {
  ...definition,
  createRouter: (ctx: KonContext) => createCRMRouter(ctx),
};

// Default export
export default kon;

// Legacy exports for compatibility
export const crmRoutes = createCRMRouter;

// ── Deduplication and capture (added when closing the CRM's gaps) ──
export {
  normalizeEmail,
  normalizePhone,
  normalizeName,
  scorePair,
  findDuplicates,
  planMerge,
  DUPLICATE_THRESHOLD,
} from "./crm.dedupe";
export type { ContactLike, Candidate, PlanFusion } from "./crm.dedupe";

export { planCapture } from "./crm.capture";
export type { FormSubmission, CapturePlan, CaptureOptions } from "./crm.capture";
