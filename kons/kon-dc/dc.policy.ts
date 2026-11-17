/**
 * Discord — authorization policy
 * ============================================================================
 * Deny-by-default: an action with no rule is denied. Importing this module registers the policy
 * "dc-bot". `registerDcPolicy()` exists because tests call `resetAuthz()`.
 *
 *   · the kon's team → reads and changes servers, modules and blueprints. That is a human admin or
 *                      editor, or an agent that opens the whole kon (`dc:*`, `kon:dc:*`,
 *                      `admin`): `isEffectiveStaff`. A fine scope (`kon:dc:<operation>`)
 *                      opens that one operation.
 *   · nobody else    → nothing. There is no public data in this kon: the public face of a bot is
 *                      Discord itself.
 *
 * Two callers are not users and are authorized by the route, not here:
 *   · Discord, on `POST /interactions`: the Ed25519 signature is the authentication;
 *   · the gateway worker, on `/gateway/*`: an agent key with only those operations' fine scopes
 *     (`kon:dc:gateway-config`, `kon:dc:ingest-gateway-events`), or a human admin.
 */
import { actsAsUserIn, definePolicy, isEffectiveStaff, type AuthzUser } from "@kitsuden/engine";

export const RESOURCE = "dc-bot";

export function isStaff(user: AuthzUser | null): boolean {
  return isEffectiveStaff(user, "dc");
}

export function registerDcPolicy(): void {
  definePolicy<unknown>(RESOURCE, {
    view: (user) => isStaff(user),
    create: (user) => isStaff(user),
    update: (user) => isStaff(user),
    delete: (user) => isStaff(user),
    actAsUser: actsAsUserIn("dc"),
  });
}

registerDcPolicy();
