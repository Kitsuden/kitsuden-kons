/**
 * Connections — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "connections" policy.
 *
 * Two kinds of connection, two kinds of owner:
 *
 *   user          a person's own account. They connect, see, refresh and revoke it; nobody else does,
 *                 an admin included (row security, migrations/0001_connections.sql).
 *   organization  the installation's account, used by kons for everyone. An admin manages it.
 *
 * An AGENT acts on connections only as the person it acts for (`actsAsUserIn`), and never starts an OAuth
 * consent or stores a key on its own: connecting an account is a person's decision.
 */
import { actsAsUserIn, type AuthzUser, definePolicy } from "@kitsuden/engine";

export interface ConnectionResource {
  scope?: "user" | "organization";
  ownerId?: string | null;
}

const isPerson = (user: AuthzUser | null) => Boolean(user?.id) && user?.role !== "agent";

export function registerConnectionsPolicy(): void {
  definePolicy<ConnectionResource>("connections", {
    view: (user, item) =>
      item.scope === "organization" ? user?.role === "admin" : Boolean(user?.id) && item.ownerId === user?.id,
    create: (user) => isPerson(user),
    update: (user, item) =>
      item.scope === "organization" ? user?.role === "admin" : isPerson(user) && item.ownerId === user?.id,
    delete: (user, item) =>
      item.scope === "organization" ? user?.role === "admin" : isPerson(user) && item.ownerId === user?.id,
    manageOrganization: (user) => user?.role === "admin",
    actAsUser: actsAsUserIn("connections"),
  });
}

registerConnectionsPolicy();
