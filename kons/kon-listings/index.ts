/**
 * @kitsuden/kon-listings — Listings and portal feeds
 *
 * Mount: /api/listings. The router, the OpenAPI and the MCP tools come from the operations in
 * listings.routes.ts. Version and tables come from kon.json, the one place they are written.
 *
 * Listings of any kind (verticals/: real estate, vehicles, jobs), a public search for the
 * agency's own site, inquiries from that site, and the XML feeds portals such as Trovit and Mitula
 * read (portals/: one mapping per portal, as data).
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";

import manifest from "./kon.json" with { type: "json" };
import { createListingsRouter, INQUIRY_EVENT, listingsOperations } from "./listings.routes";

export * from "./listings.schema";
export { registerListingsPolicy, isStaff } from "./listings.policy";
export { buildFeed, loadPortals, portals, xmlText } from "./listings.feeds";
export { attributeIssues, loadVerticals, publishIssues, verticals } from "./listings.verticals";
export { createListingsRouter, INQUIRY_EVENT, listingsOperations };

export const kon: KonDefinition = defineKonSdk({
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  icon: manifest.icon,
  mountPath: manifest.mount.path,
  operations: (ctx: KonContext) => listingsOperations(ctx),
  tables: manifest.tables.map((t) => t.name),
  rateLimits: [
    // A public form: enough for a person, not for a script filling the team's inbox.
    {
      path: "/:id/inquiries",
      limit: 5,
      window: 600,
      message: "Too many inquiries from this address. Try again in a few minutes.",
    },
    // Portals read once a day; this only stops someone hammering a leaked URL.
    { path: "/feed/*", limit: 60, window: 60, message: "Too many feed reads." },
  ],
  admin: {
    category: "content",
    views: [
      { id: "grid-listings", type: "grid", title: "Listings", table: "listings_items" },
      { id: "grid-feeds", type: "grid", title: "Portal feeds", table: "listings_feeds" },
      { id: "grid-inquiries", type: "grid", title: "Inquiries", table: "listings_inquiries" },
    ],
  },
  dependencies: { kons: [], core: ["auth"] },
});

export default kon;
