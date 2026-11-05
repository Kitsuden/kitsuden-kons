/**
 * @kitsuden/kon-booking — Booking Engine (Modern Kon)
 *
 * Room and resource reservation system with conflict detection.
 *
 * Layer: Kon (Nivel 3 — loaded via module-loader)
 * Mount: /api/booking
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";
import type { Hono } from "hono";

import { bookingOperations, createBookingRouter } from "./booking.routes";
import * as schema from "./booking.schema";
import { KON_ID } from "./operations";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

// Re-export schema for external use
export * from "./booking.schema";
export { bookingOperations, createBookingRouter };

/**
 * Create router with dependency injection
 */
function createBookingKonRouter(ctx: KonContext): Hono {
  return createBookingRouter(ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`bookingOperations`), with its OpenAPI, its MCP tool and its fine-grained scope
 * `kon:booking:<id>`.
 *
 * `createRouter` is replaced by the usual one (`createBookingRouter`): the
 * operations router behind `rlsContext`, which leaves each route the request's
 * `db` and the session, and with `respondError` for whatever is not an
 * `AppError`.
 */
const definition = defineKonSdk({
  id: KON_ID,
  name: "Booking Engine",
  version: manifest.version,
  description: "Room and resource booking system with conflict detection",
  icon: "Calendar",

  operations: (ctx: KonContext) => bookingOperations(ctx),

  // Tables this kon manages
  tables: konTables,

  // Lifecycle hooks
  hooks: {
    onEnable: async (ctx) => {
      ctx.logger.info("✅ Booking kon enabled");
    },

    onDisable: async (ctx) => {
      ctx.logger.info("⛔ Booking kon disabled");
    },

    onStartup: async (ctx) => {
      /**
       * Tables are NOT created here. They are created by the kon's migrations.
       *
       * ── WHY IT WAS REMOVED ───────────────────────────────────────────────
       *
       * There was a `runMigrations(ctx)` with twenty-five embedded `CREATE TABLE IF NOT
       * EXISTS`, and it CANNOT work in production: the API connects
       * with a role that has no CREATE privilege on the schema — which is
       * precisely what makes RLS isolation effective.
       *
       * And it failed silently by design. Its `executeSQL` helper caught the
       * error, wrote a log line and returned `false`; nobody looked at that
       * `false`. At real startup twenty-five errors
       * "permission denied for schema public" were visible among hundreds of lines, and the kon
       * considered itself started.
       *
       * All those tables are now created by the files in `migrations/`, which are
       * applied with the admin role, are recorded in
       * `kitsuden_migrations` and fail LOUDLY if something goes wrong.
       *
       * The check below is kept: if the tables are not there, it
       * has to be said. Guarded by `tests/unit/kons-do-not-create-tables.test.ts`.
       */

      // Check tables
      const requiredTables = ["booking_rooms", "booking_reservations"];
      const missingTables: string[] = [];

      for (const table of requiredTables) {
        const exists = await ctx.db.tableExists(table);
        if (!exists) {
          missingTables.push(table);
        }
      }

      if (missingTables.length > 0) {
        ctx.logger.warn(`⚠️ Booking tables not found: ${missingTables.join(", ")}`);
      } else {
        ctx.logger.info("📅 Booking tables verified");
      }
    },
  },

  // Admin UI configuration
  // kon.json `admin` is the one list of admin views; the definition copies it.
  admin: {
    category: manifest.admin.category as "data",
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid",
      title: v.title,
      table: v.table,
    })),
  },

  // Dependencies
  dependencies: {
    kons: ["kon-media"],
    core: ["auth"],
  },

  // Mount point
  mountPath: "/api/booking",
});

export const kon: KonDefinition = { ...definition, createRouter: createBookingKonRouter };

// Export schema
export { schema };

// Default export for simpler imports
export default kon;
