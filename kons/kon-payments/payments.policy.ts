/**
 * Kitsuden Payments — authorization policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "payments" policy.
 *
 * Billing belongs to ONE person. Neither the team (editor) nor another account
 * opens the portal, cancels or pays on behalf of someone else: the resource carries the owner
 * `userId` and it is compared with the session. The site admin neither:
 * managing a customer's billing is done in the provider's panel,
 * not by impersonating them here.
 */
import { actsAsUserIn, type AuthzUser, definePolicy } from "@kitsuden/engine";

export interface PaymentResource {
  userId?: string | null;
}

/**
 * An AGENT (role `agent`) is not an account that pays: its id is that of its
 * identity, not a person's. Without this condition, any agent
 * key —with only `mcp:connect`— passed `isTheirs` with its own id and opened
 * checkouts in its name (an earlier audit, e2e test). If someone truly wants it,
 * they grant it EXPLICITLY with the `payments:checkout` scope (the engine looks at it
 * when the rule says no).
 */
const isTheirs = (u: AuthzUser | null, r: PaymentResource) =>
  u?.role !== "agent" && Boolean(u?.id) && Boolean(r?.userId) && r.userId === u?.id;

export function registerPaymentsPolicy(): void {
  definePolicy<PaymentResource>("payments", {
    checkout: (u, r) => isTheirs(u, r),
    portal: (u, r) => isTheirs(u, r),
    cancel: (u, r) => isTheirs(u, r),

    /**
     * The routes that used to require only a session (the status of my subscription). They were
     * opened by the host's `requireAuth`, which lets an AGENT through only
     * as an account with `user:act`, `admin` or some payments scope
     * (`agent-as-user.ts`). SDK operations do not go through that
     * rule, so it is repeated here, as is.
     */
    actAsUser: actsAsUserIn("payments"),
  });
}

registerPaymentsPolicy();
