/**
 * Formulas — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "formulas" policy.
 *
 * Formula systems are EDITORIAL CONTENT: they are published by the site's team
 * and read by everyone. That is why `view` is open and writing requires a role
 * — a badly edited formula system breaks all the calculators that
 * depend on it at once.
 */
import { actsAsUserIn, definePolicy } from "@kitsuden/engine";

export function registerFormulasPolicy(): void {
  definePolicy<{ id: string }>("formulas", {
    view: () => true,
    create: (user) => user?.role === "admin" || user?.role === "editor",
    update: (user) => user?.role === "admin" || user?.role === "editor",
    delete: (user) => user?.role === "admin",

    /**
     * The routes that used to ask only for a session (evaluating a system). They were opened by the
     * host's `requireAuth`, which lets an AGENT through only as an account with
     * `user:act`, `admin` or some formulas scope
     * (`agent-as-user.ts`). The SDK operations do not go through that
     * rule, so it is repeated here, as is.
     */
    actAsUser: actsAsUserIn("formulas"),
  });
}

registerFormulasPolicy();
