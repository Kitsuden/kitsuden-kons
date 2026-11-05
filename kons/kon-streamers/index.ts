/**
 * @kitsuden/kon-streamers — Streamer Management (Modern)
 *
 * Streamer management with Twitch/YouTube/Kick sync:
 * - Streamers (profiles, platform integration)
 * - Game associations (what they play)
 * - Live status tracking
 *
 * Layer: Kon Core (Nivel 3 — loaded via module-loader)
 * Mount: /api/streamers
 *
 * The version is in package.json (copied to kon.json).
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonDefinition, KonContext } from "@kitsuden/shared";
import type { Hono } from "hono";

import { KON_ID } from "./operations";
import { createStreamersRouter, streamersOperations } from "./streamers.routes";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

// Re-export schema for schema-merger
export * from "./streamers.schema";

// ═══════════════════════════════════════════════════════════════════════════════
// Tables
// ═══════════════════════════════════════════════════════════════════════════════

const tables = ["streamers", "games_to_streamers"];

// ═══════════════════════════════════════════════════════════════════════════════
// Router Factory
// ═══════════════════════════════════════════════════════════════════════════════

export function createKonStreamers(ctx: KonContext): Hono {
  return createStreamersRouter(ctx);
}

// Re-export router creator (legacy compatibility)
export { createStreamersRouter, streamersOperations };

// ═══════════════════════════════════════════════════════════════════════════════
// Kon Definition
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`streamersOperations`), with its OpenAPI, its MCP tool and its fine-grained scope.
 */
export const kon: KonDefinition = defineKonSdk({
  id: KON_ID,
  name: "Streamers",
  version: manifest.version,
  description: "Streamer management with Twitch/YouTube/Kick sync and game associations",
  icon: "Video",
  mountPath: "/api/streamers",
  operations: (ctx: KonContext) => streamersOperations(ctx),

  tables: konTables,

  // kon.json `admin` is the one list of admin views; the definition copies it.
  admin: {
    category: manifest.admin.category as "esports",
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid",
      title: v.title,
      table: v.table,
    })),
  },

  dependencies: {
    kons: ["kon-games", "kon-media"], // Needs games and media
    core: ["auth"],
  },

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("📺 Streamers kon initialized");

      // Verify required tables
      const requiredTables = ["streamers", "games_to_streamers"];
      const missingTables: string[] = [];

      for (const table of requiredTables) {
        const exists = await ctx.db.tableExists(table);
        if (!exists) {
          missingTables.push(table);
        }
      }

      if (missingTables.length > 0) {
        ctx.logger.warn(`⚠️ Streamers tables not found: ${missingTables.join(", ")}`);
      } else {
        ctx.logger.info("✅ All streamers tables verified");
      }
    },

    onEnable: async (ctx) => {
      ctx.logger.info("📺 Streamers kon enabled");
    },

    onDisable: async (ctx) => {
      ctx.logger.info("📺 Streamers kon disabled");
    },
  },
});

// Default export
export default kon;

// Legacy exports for compatibility
export const streamersModuleRoutes = createKonStreamers;
