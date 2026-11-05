/**
 * TierList — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "tierlist" policy.
 *
 * The two natures share a policy because the RESOURCE tells them apart:
 *
 *   · A TEMPLATE (`kind: "template"`) is editorial: public to read,
 *     role to write. A mistake in the patch's tier list is seen by everyone
 *     at once.
 *   · A PERSONAL list belongs to its owner. It is read if it is theirs or if they are admin —
 *     sharing a personal list is done with its CODE, which does not go through
 *     here because it does not expose the row, only the distribution.
 */
import { definePolicy, type AuthzUser } from "@kitsuden/engine";

export interface TierListResource {
  id: string;
  kind?: string | null;
  ownerId?: string | null;
}

export function registerTierlistPolicy(): void {
  definePolicy<TierListResource>("tierlist", {
    view: (user: AuthzUser | null, item) =>
      item.kind !== "personal" ||
      user?.role === "admin" ||
      (!!item.ownerId && item.ownerId === user?.id),

    // Forking a template can be done by anyone with a session: it is THEIR list.
    // A PERSON with a session. An agent (`role: "agent"`) needs its scope
    // (`tierlist:create`, `tierlist:*`, `admin`), which `can()` grants:
    // before, one with only `mcp:connect` could fork (an earlier audit).
    create: (user) => Boolean(user?.id) && user?.role !== "agent",

    /**
     * Publishing or rewriting a TEMPLATE (PUT /templates) is editorial: a game's
     * official tier list is seen by everyone at once. Before, the role
     * was checked by hand in the route, and an agent with `tierlist:*` (the scope that
     * the agent guide documents) could place and sync but not
     * publish. As a policy action, the `tierlist:publish` scope grants it.
     */
    publish: (user) => user?.role === "admin" || user?.role === "editor",

    update: (user, item) =>
      user?.role === "admin" ||
      user?.role === "editor" ||
      (!!item.ownerId && item.ownerId === user?.id),

    delete: (user, item) => user?.role === "admin" || (!!item.ownerId && item.ownerId === user?.id),
  });
}

registerTierlistPolicy();
