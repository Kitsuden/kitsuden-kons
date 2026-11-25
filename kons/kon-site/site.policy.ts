/**
 * Site — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "site" policy.
 *
 * A site's configuration is public (every visitor's page draws it) and so is the host → site
 * answer. The list of domains and sites is for the site team, and writing is for admins only:
 * pointing a domain at another site, or swapping the logo, changes what every visitor sees.
 */
import { definePolicy } from "@kitsuden/engine";

const staff = (user: { role?: string } | null | undefined) =>
  user?.role === "admin" || user?.role === "editor";

export function registerSitePolicy(): void {
  definePolicy<{ id: string }>("site", {
    view: () => true,
    list: (user) => staff(user),
    create: (user) => user?.role === "admin",
    update: (user) => user?.role === "admin",
    delete: (user) => user?.role === "admin",
  });
}

registerSitePolicy();
