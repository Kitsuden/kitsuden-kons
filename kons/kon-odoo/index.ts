/**
 * @kitsuden/kon-odoo — Odoo as the ERP behind a shop
 *
 * Mount: /api/odoo. Built with the kon SDK: the router, the OpenAPI and the MCP tools come from
 * the operations in odoo.routes.ts.
 *
 *   Odoo ──signed notice──▶ queue ──read back──▶ mirror ──▶ public catalog (no call to Odoo)
 *                                                  │
 *                                                  ├──▶ events (`odoo:*`) for other kons
 *                                                  └──▶ signed purge notice for the site
 *   shop ──create-order──▶ queue ──▶ Odoo (`sale.order`), read back for its number and totals
 *
 * Odoo owns the facts. This kon keeps a copy to read from, so the public never reaches the ERP,
 * and writes to Odoo only what a customer did: an order, and the customer it belongs to.
 *
 * Version and tables come from kon.json, the one place they are written.
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";

import manifest from "./kon.json" with { type: "json" };
import { PROVIDER, registerOdooProvider } from "./odoo.connection";
import { odooEvents } from "./odoo.events";
import { odooSchedules, registerOdooQueues } from "./odoo.queues";
import { createOdooRouter, odooOperations } from "./odoo.routes";
import { listenToPayments } from "./odoo.checkout";
import { startFullSync } from "./odoo.sync";

export * from "./odoo.schema";
export { registerOdooPolicy, isStaff } from "./odoo.policy";
export { createOdooRouter, odooOperations, registerOdooQueues, odooSchedules, odooEvents };
export { setOdooClientForTests } from "./odoo.connection";
export { createOdooClient, OdooError } from "./odoo.client";

const listening = new WeakSet<object>();

/**
 * A connection to Odoo was just stored: read the catalog now instead of waiting for the night.
 * The first page of the walk also asks Odoo what it has installed.
 */
function followConnection(ctx: KonContext): void {
  if (!ctx.events?.on || listening.has(ctx.events)) return;
  listening.add(ctx.events);
  ctx.events.on("connections:connection.created", (data: unknown) => {
    if ((data as { provider?: string } | null)?.provider !== PROVIDER) return;
    const run = async () => {
      const asSystem = ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());
      await asSystem(() => startFullSync(ctx));
    };
    const start = () =>
      run().catch((error: unknown) =>
        ctx.logger.warn("kon-odoo: could not start the first sync", {
          reason: error instanceof Error ? error.message : String(error),
        })
      );
    void (ctx.db.background ? ctx.db.background(start) : start());
  });
}

const definition = defineKonSdk({
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  icon: manifest.icon,
  mountPath: manifest.mount.path,
  operations: (ctx: KonContext) => odooOperations(ctx),
  tables: manifest.tables.map((t) => t.name),

  rateLimits: [
    // The catalog is anyone's and is read from this Kitsuden's own tables.
    { path: "/catalog/*", limit: 600, window: 60 },
    // Odoo sends notices in batches; a flood is refused rather than queued.
    { path: "/webhook", limit: 300, window: 60, failClosed: true },
    // An order ends as a write in the ERP.
    { path: "/orders", limit: 60, window: 60, failClosed: true },
    { path: "/carts/*", limit: 600, window: 60, failClosed: true },
    // These two call Odoo while the caller waits.
    { path: "/wallet", limit: 60, window: 60, failClosed: true },
    { path: "/connection/check", limit: 6, window: 60, failClosed: true },
  ],

  mcpToolsets: {
    catalog: ["list-products", "get-product", "list-categories"],
    orders: ["create-cart", "get-cart", "set-cart-line", "checkout-cart", "create-order", "get-order", "list-orders", "get-wallet"],
    operations: ["get-status", "check-connection", "start-sync", "list-conflicts", "resolve-conflict"],
  },

  events: odooEvents,
  secretColumns: [
    { table: "odoo_settings", column: "webhook_secret" },
    { table: "odoo_settings", column: "purge_secret" },
  ],

  admin: {
    category: "tools",
    views: manifest.admin.views.map((view) =>
      view.type === "element"
        ? { id: view.id, type: "element" as const, title: view.title, element: view.element, src: view.src }
        : { id: view.id, type: "grid" as const, title: view.title, table: view.table }
    ),
  },

  dependencies: { kons: [], core: ["auth"] },

  hooks: {
    onStartup: async (ctx) => {
      registerOdooQueues(ctx);
      followConnection(ctx);
      // kon-payments, if installed, announces payments; the ones for Odoo orders settle them.
      listenToPayments(ctx);
      const problem = registerOdooProvider(ctx);
      if (problem) {
        ctx.logger.warn(`⚠️ kon-odoo mounted but cannot reach Odoo: ${problem}`);
      } else {
        ctx.logger.info("✅ kon-odoo ready");
      }
    },
  },
});

/**
 * The schedules are spread on, as kon-crm does with its events: a Kitsuden older than kon
 * schedules ignores the field instead of refusing the kon.
 */
export const kon: KonDefinition = { ...definition, ...({ schedules: odooSchedules } as object) };

export default kon;
