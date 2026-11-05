/**
 * Kitsuden CMS — Employee Directory (DI Version)
 *
 * REST API for employee profiles, departments, positions,
 * and organizational hierarchy.
 *
 * MIGRATED: Now uses Dependency Injection via KonContext
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";
import { Hono } from "hono";

import { createDirectoryRouter, directoryOperations } from "./directory.routes";
import * as schema from "./directory.schema";
import { KON_ID } from "./operations";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./directory.schema";
export { createDirectoryRouter, directoryOperations };

function createDirectoryKonRouter(ctx: KonContext): Hono {
  return createDirectoryRouter(ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`directoryOperations`), with its OpenAPI, its MCP tool and its fine-grained scope
 * `kon:directory:<id>`.
 *
 * `createRouter` is replaced by the usual one (`createDirectoryRouter`): the
 * operations router behind `rlsContext`, which leaves each route the request's
 * `db` and session, and with `respondError` for what is not an
 * `AppError`.
 */
const definition = defineKonSdk({
  id: KON_ID,
  name: "Employee Directory",
  version: manifest.version,
  description: "Employee profiles, departments, positions, and organizational hierarchy",
  icon: "Contact",
  operations: (ctx: KonContext) => directoryOperations(ctx),
  tables: konTables,
  dependencies: {
    kons: ["kon-media"],
    core: ["auth"],
  },
  mountPath: "/api/directory",
  hooks: {
    onEnable: async (ctx) => {
      ctx.logger.info("✅ Directory kon enabled");
    },
    onDisable: async (ctx) => {
      ctx.logger.info("⛔ Directory kon disabled");
    },
  },
  admin: {
    category: "system",
    views: [
      { id: "grid-employees", type: "grid", title: "Employees", table: "directory_employees" },
      {
        id: "grid-departments",
        type: "grid",
        title: "Departments",
        table: "directory_departments",
      },
      { id: "grid-positions", type: "grid", title: "Positions", table: "directory_positions" },
      {
        id: "grid-organizations",
        type: "grid",
        title: "Organizations",
        table: "directory_organizations",
      },
    ],
  },
});

export const kon: KonDefinition = { ...definition, createRouter: createDirectoryKonRouter };

export { schema };
export default kon;
