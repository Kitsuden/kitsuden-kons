/**
 * @kitsuden/kon-agile — Agile Project Management (Modern)
 *
 * Professional agile management system with:
 * - Projects, States, Issues (Core)
 * - Cycles (Sprints - Time tracking)
 * - Modules (Epics - Scope tracking)
 * - Intakes (Triage for AI with human approval)
 * - Squads with a scrum master, agents as teammates with a work queue (1.3)
 * - Labels, checklists, custom fields, saved views, initiatives, dashboard (1.3)
 *
 * Layer: Kon Core (Nivel 3 — loaded via module-loader)
 * Mount: /api/agile
 *
 * @version 1.3.1
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";
import type { Hono } from "hono";

import { createAgileRouter, allAgileOperations, agileShared } from "./agile.routes";
import { AGENT_TOOLS } from "./operations";

// ═══════════════════════════════════════════════════════════════════════════════
// Schema Exports
// ═══════════════════════════════════════════════════════════════════════════════

export {
  // Enums
  issueTypeEnum,
  issuePriorityEnum,
  cycleStatusEnum,
  moduleStatusEnum,
  intakeStatusEnum,
  linkTypeEnum,
  estimateTypeEnum,
  stateGroupEnum,
  // Tables
  agileProjects,
  agileProjectMembers,
  PROJECT_ROLES,
  agileStates,
  agileIssues,
  agileCycles,
  agileModules,
  agileIntakes,
  agileComments,
  agileLabels,
  agileEstimates,
  agileModuleIssues,
  agileIssueLabels,
  agileIssueLinks,
  agileActivityLog,
  agileSquads,
  agileSquadMembers,
  agileInitiatives,
  agileChecklistItems,
  agileCustomFields,
  agileSavedViews,
  agileNotifications,
  agileAgentSchedules,
  agileAgentWork,
  // Relations
  agileProjectsRelations,
  agileStatesRelations,
  agileIssuesRelations,
  agileCyclesRelations,
  agileModulesRelations,
  agileIntakesRelations,
  agileCommentsRelations,
  agileLabelsRelations,
  agileModuleIssuesRelations,
  agileIssueLabelsRelations,
  agileIssueLinksRelations,
  agileActivityLogRelations,
} from "./agile.schema";

// ═══════════════════════════════════════════════════════════════════════════════
// Type Exports
// ═══════════════════════════════════════════════════════════════════════════════

export type {
  AgileProject,
  AgileProjectMember,
  ProjectRole,
  NewAgileProject,
  AgileState,
  NewAgileState,
  AgileIssue,
  NewAgileIssue,
  AgileCycle,
  NewAgileCycle,
  AgileModule,
  NewAgileModule,
  AgileIntake,
  NewAgileIntake,
  AgileComment,
  NewAgileComment,
  AgileLabel,
  NewAgileLabel,
  AgileEstimate,
  NewAgileEstimate,
  AgileIssueLink,
  NewAgileIssueLink,
  AgileActivityLog,
  NewAgileActivityLog,
  AgileSquad,
  AgileSquadMember,
  AgileInitiative,
  AgileChecklistItem,
  AgileCustomField,
  AgileSavedView,
  AgileNotification,
  AgileAgentSchedule,
  AgileAgentWork,
} from "./agile.schema";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

// ═══════════════════════════════════════════════════════════════════════════════
// Kon Definition (Modern DI Pattern)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Factory function that creates the router with Dependency Injection
 * Used by the module-loader to mount the kon
 */
export function createKonAgile(ctx: KonContext): Hono {
  return createAgileRouter(ctx);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Periodic work (1.3): auto-archive, auto-close of cycles, agent schedules
// ═══════════════════════════════════════════════════════════════════════════════
//
// The core has no scheduler for kons, so this is the kon-newsletter pattern: an interval started
// in `onStartup`, a busy flag so ticks do not overlap, `unref()` so it never keeps the process
// alive, and conditional UPDATEs inside `tick` so several workers do not repeat the work.
// It runs outside any request, as the system (`ctx.db.background`).

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickBusy = false;
const TICK_MS = 60_000;

function startTicker(ctx: KonContext): void {
  if (tickTimer) return;
  const background = ctx.db.background ?? (<T>(fn: () => T) => fn());
  tickTimer = setInterval(() => {
    if (tickBusy) return;
    tickBusy = true;
    void background(async () => {
      try {
        const done = await agileShared(ctx).workflow.tick();
        if (done.archived || done.cyclesClosed || done.scheduled) {
          ctx.logger.info("📋 Agile periodic work", done);
        }
      } catch (err) {
        // Tables not migrated yet, or the database down: the next tick retries.
        ctx.logger.warn("📋 Agile periodic work failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        tickBusy = false;
      }
    });
  }, TICK_MS);
  tickTimer.unref?.();
}

function stopTicker(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

/**
 * Full kon definition for automatic registration
 * Compatible with the module-loader v3 system
 */
/**
 * With the kon SDK (phase D fixes, 2026-10-25): the two operations
 * an agent uses —reading the board and proposing an intake— are declared in
 * `agile.operations.ts` and the core publishes REST, OpenAPI and the
 * MCP tools `agile_read_board` / `agile_submit_intake` from them.
 *
 * Since 2026-10-26 the rest of the routes are operations too (agile.routes.ts,
 * REST only): there is no `legacyRoutes` any more. They go AFTER the two MCP ones, the same
 * resolution order as when they were legacy.
 *
 * `createRouter` is replaced by `createAgileRouter`: the operations router
 * with the usual `onError` (http-errors.ts), which translates Postgres
 * SQLSTATEs to 409/400 without internal details.
 */
const definition = defineKonSdk({
  id: "kon-agile",
  name: "Agile Tracker",
  version: manifest.version,
  description: "Agile management system with human approval for AI suggestions",
  icon: "Kanban",
  mountPath: "/api/agile",

  operations: (ctx: KonContext) => allAgileOperations(ctx),

  // Lifecycle hooks
  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("📋 Agile kon initialized");

      // Check main tables
      const requiredTables = [
        "agile_projects",
        "agile_states",
        "agile_issues",
        "agile_cycles",
        "agile_modules",
        "agile_intakes",
      ];

      for (const table of requiredTables) {
        const exists = await ctx.db.tableExists(table);
        if (!exists) {
          ctx.logger.warn(`⚠️ Table '${table}' not found. Run migrations!`);
        }
      }
      startTicker(ctx);
    },

    onEnable: async (ctx) => {
      ctx.logger.info("📋 Agile Tracker enabled");
    },

    onDisable: async (ctx) => {
      stopTicker();
      ctx.logger.info("📋 Agile Tracker disabled");
    },
  },

  // Admin UI configuration
  admin: {
    category: "system",
    // The panel reads views from kon.json; the definition copies that one list. The `workspace`
    // view is a Web Component built from ./admin-src (Svelte + tallao) into ./admin: project
    // settings and automation, members and agents, states, labels and fields, planning, squads
    // and schedules, intakes, the agent work queue, issue audit and history.
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid" | "element",
      title: v.title,
      table: v.table,
      element: v.element,
      src: v.src,
    })),
  },

  // Tables it manages
  tables: konTables,

  // Dependencies
  dependencies: {
    kons: [],
    core: ["auth"],
  },
});

export const kon: KonDefinition = { ...definition, createRouter: createAgileRouter };

// Policy "agile_project" (project membership) — registered on import.
export { registerAgilePolicy, type ProjectResource } from "./agile.policy";

// ═══════════════════════════════════════════════════════════════════════════════
// MCP: there is no `mcp.ts` any more. The tools come from the SDK operations
// (agile.operations.ts); see there for why.
// ═══════════════════════════════════════════════════════════════════════════════

export { agileOperationsList } from "./agile.operations";

// ═══════════════════════════════════════════════════════════════════════════════
// Metadata
// ═══════════════════════════════════════════════════════════════════════════════

export const konMetadata = {
  id: "kon-agile",
  name: "Agile Tracker",
  version: manifest.version,
  description: "Agile management system with human approval for AI suggestions",
  mountPath: "/api/agile",
  layer: 3,
  features: [
    "project-management",
    "custom-workflows",
    "kanban-board",
    "sprint-management",
    "epic-tracking",
    "ai-triage",
    "human-approval",
    "mcp-integration",
    "squads",
    "agent-teammates",
    "saved-views",
    "dashboards",
    "initiatives",
  ],
  tables: konTables,
  mcpTools: ["agile_read_board", "agile_submit_intake", ...Object.values(AGENT_TOOLS).map((t) => t.name)],
};

// Legacy exports for compatibility
export { createAgileRouter as agileRoutes };
export { createAgileRouter as agileModuleRoutes };
