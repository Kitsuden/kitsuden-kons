/**
 * Odoo — authorization policy
 * ============================================================================
 * Deny-by-default: an action with no rule is denied. Importing this module registers the
 * policies. `registerOdooPolicy()` exists because tests call `resetAuthz()`.
 *
 *   · `odoo-catalog`  anyone, signed in or not, reads the published catalog. Nobody writes it
 *                     through the API: it is Odoo's, and only the sync changes it.
 *   · `odoo-order`    the kon's team reads and takes orders. An order is taken on a customer's
 *                     behalf by the shop's own backend, with an agent key that opens this kon;
 *                     a signed-in visitor has no order routes here.
 *   · `odoo-admin`    the kon's team sees the state of the connection and changes the settings.
 *
 * "The kon's team" is a human admin or editor, or an agent that opens the whole kon
 * (`odoo:*`, `kon:odoo:*`, `admin`): `isEffectiveStaff`.
 *
 * Account sign-up is public: "having a session" gives nothing by itself.
 */
import { actsAsUserIn, definePolicy, isEffectiveStaff, type AuthzUser } from "@kitsuden/engine";

export function isStaff(user: AuthzUser | null): boolean {
  return isEffectiveStaff(user, "odoo");
}

export function registerOdooPolicy(): void {
  definePolicy<unknown>("odoo-catalog", {
    view: () => true,
    actAsUser: actsAsUserIn("odoo"),
  });
  definePolicy<unknown>("odoo-order", {
    view: (user) => isStaff(user),
    create: (user) => isStaff(user),
  });
  definePolicy<unknown>("odoo-admin", {
    view: (user) => isStaff(user),
    update: (user) => isStaff(user),
  });
}

registerOdooPolicy();
