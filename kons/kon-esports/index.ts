/**
 * @kitsuden/kon-esports — Esports Tournament System (Modern)
 *
 * Complete esports competitive ecosystem with:
 * - Players (profiles, management)
 * - Teams (rosters, organization)
 * - Tournaments (bracket generation)
 * - Matches (tracking, results)
 *
 * Layer: Kon Core (Nivel 3 — loaded via module-loader)
 * Mount: /api/esports
 *
 * @version 1.0.0
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonDefinition, KonContext } from "@kitsuden/shared";
import type { Hono } from "hono";

import { createEsportsRouter, esportsOperations } from "./esports.routes";
import { KON_ID } from "./operations";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

// Re-export schema for schema-merger
export * from "./esports.schema";

// The bracket engine and its persistence are PUBLIC to the kon: `kon-broadcast`
// closes sets from the overlay and has to advance the same bracket. Without this, the
// only way to integrate would be to reimplement the advancement, which is exactly what
// must not exist in duplicate.
export * from "./bracket";
export * from "./bracket.persistence";
export * from "./roundrobin";
export * from "./roundrobin.persistence";
export * from "./checkin";
export * from "./phases";

// ═══════════════════════════════════════════════════════════════════════════════
// Tables
// ═══════════════════════════════════════════════════════════════════════════════

const tables = [
  "esports_players",
  "esports_teams",
  "esports_players_to_teams",
  "esports_tournaments",
  "esports_tournament_participants",
  "esports_matches",
];

// ═══════════════════════════════════════════════════════════════════════════════
// Router Factory
// ═══════════════════════════════════════════════════════════════════════════════

export function createKonEsports(ctx: KonContext): Hono {
  return createEsportsRouter(ctx);
}

// Re-export DI wrapper (legacy compatibility)
export { createEsportsRouter };

// ═══════════════════════════════════════════════════════════════════════════════
// Kon Definition
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`esportsOperations`), with its OpenAPI, its MCP tool and its fine-grained scope.
 *
 * `createRouter` is replaced by the usual one: the operations router
 * wrapped in `withValidatedIds` and `withHiddenDrafts`, which look at the PATH
 * of any route (id that is not a uuid → 404, draft tournament → 404) before
 * the operation gets to run.
 */
const definition = defineKonSdk({
  id: KON_ID,
  name: "Esports Tournaments",
  version: manifest.version,
  description:
    "Complete esports competitive ecosystem with players, teams, tournaments, and matches",
  icon: "Trophy",
  mountPath: "/api/esports",
  operations: (ctx: KonContext) => esportsOperations(ctx),

  tables: konTables,

  // Public writes or writes from any account (an earlier audit): without
  // their own limit, a script filled a tournament's slots with guests with
  // invented emails, occupied other people's aliases or flooded teams and invitations.
  rateLimits: [
    {
      path: "/public/tournament/:id/register-guest",
      limit: 5,
      window: 600,
      message: "Too many registrations in a row.",
    },
    { path: "/public/tournament/:id/register", limit: 10, window: 600 },
    { path: "/public/tournament/:id/register-team", limit: 10, window: 600 },
    { path: "/public/teams", limit: 10, window: 3600, message: "Too many teams created." },
    { path: "/public/teams/:id/invites", limit: 30, window: 3600 },
    { path: "/match/:matchId/report", limit: 30, window: 600 },
  ],

  // kon.json `admin` is the one list of admin views; the definition copies it. The TO booth
  // (`to-panel`) is a framework-agnostic Web Component the admin loads at runtime; the grids
  // are for checking data.
  admin: {
    category: manifest.admin.category as "esports",
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid" | "element",
      title: v.title,
      ...("table" in v ? { table: v.table } : {}),
      ...("element" in v ? { element: v.element, src: v.src } : {}),
    })),
  },

  dependencies: {
    kons: ["kon-games", "kon-media"], // Needs games for tournament game selection, media for avatars/logos
    core: ["auth"],
  },

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("🏆 Esports kon initialized");

      // Verify required tables
      const requiredTables = [
        "esports_players",
        "esports_teams",
        "esports_tournaments",
        "esports_matches",
      ];
      const missingTables: string[] = [];

      for (const table of requiredTables) {
        const exists = await ctx.db.tableExists(table);
        if (!exists) {
          missingTables.push(table);
        }
      }

      if (missingTables.length > 0) {
        ctx.logger.warn(`⚠️ Esports tables not found: ${missingTables.join(", ")}`);
      } else {
        ctx.logger.info("✅ All esports tables verified");
      }
    },

    onEnable: async (ctx) => {
      ctx.logger.info("🏆 Esports kon enabled");
    },

    onDisable: async (ctx) => {
      ctx.logger.info("🏆 Esports kon disabled");
    },
  },
});

export const kon: KonDefinition = { ...definition, createRouter: createKonEsports };

// Default export
export default kon;

// Legacy exports for compatibility
export const esportsModuleRoutes = createKonEsports;
