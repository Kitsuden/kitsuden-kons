/**
 * @kitsuden/kon-analytics — Content analytics
 *
 * Counts VIEWS per subject and day, without cookies, without IP and without identifying
 * anyone. Used by the front page (the most viewed games), the blog (which guide is read)
 * and esports (which tournament is followed).
 *
 * Layer: Kon (Nivel 3 — loaded with the module-loader)
 * Mount: /api/analytics
 *
 * @version 1.0.0
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonDefinition, KonContext } from "@kitsuden/shared";
import type { Hono } from "hono";

import {
  analyticsOperations,
  createAnalyticsRouter,
  KON_ID,
  ANALYTICS_LIMITS,
} from "./analytics.routes";

export * from "./analytics.schema";
export {
  analyticsOperations,
  isBot,
  KON_ID,
  ANALYTICS_LIMITS,
  SUBJECT_TABLE,
} from "./analytics.routes";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

const tables = ["analytics_views"];

export function createKonAnalytics(ctx: KonContext): Hono {
  return createAnalyticsRouter(ctx);
}

export { createAnalyticsRouter };

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`analyticsOperations`), with its OpenAPI, its MCP tool and its fine-grained scope.
 */
export const kon: KonDefinition = defineKonSdk({
  id: KON_ID,
  name: "Analytics",
  version: manifest.version,
  description: "Views per subject and day, without cookies or personal data",
  icon: "BarChart3",
  mountPath: "/api/analytics",
  operations: (ctx: KonContext) => analyticsOperations(ctx),

  tables: konTables,

  // `hit` is public and writes: without its own limit it ran under the general
  // 300/min, which is meant for READING. See `ANALYTICS_LIMITS`.
  rateLimits: ANALYTICS_LIMITS,

  // kon.json `admin` is the one list of admin views; the definition copies it.
  admin: {
    category: manifest.admin.category as "content",
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid",
      title: v.title,
      table: v.table,
    })),
  },

  dependencies: {
    kons: [],
    core: [],
  },

  hooks: {
    onStartup: async (ctx) => {
      const exists = await ctx.db.tableExists("analytics_views");
      if (!exists) {
        ctx.logger.warn("⚠️ Table analytics_views is missing: run scripts/migrate.ts");
      } else {
        ctx.logger.info("📊 Analytics ready");
      }
    },
  },
});

export default kon;
