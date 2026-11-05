/**
 * Store — authorization policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the policies.
 *
 * THE DISTINCTION THAT PREVENTS THE LEAK
 *
 * Two questions coexist here that are NOT the same:
 *
 *   · "can this employee list the orders?"  → backoffice, this policy
 *   · "can this buyer see THEIR order?"     → does NOT go through here
 *
 * The buyer is not a system user: they are identified by email and arrive
 * with a link. If the two were mixed, giving someone access to "their" order would end up
 * giving them permission to list everyone's — that is, the entire customer
 * base with their addresses.
 *
 * That is why `view` on an order NEVER looks at the buyer's email. That path
 * lives in the public route, with its own token.
 */
import {
  actsAsUserIn,
  type AuthzUser,
  definePolicy,
  isEffectiveAdmin,
  isEffectiveStaff,
} from "@kitsuden/engine";

export interface ProductResource {
  id: string;
  active?: boolean;
}

export interface OrderResource {
  id: string;
  status?: string;
}

export interface PromotionResource {
  id: string;
  active?: boolean;
}

/**
 * EFFECTIVE team and admin: the human role, or an agent with the whole kon
 * (`admin`, `ecommerce:*`, `kon:ecommerce:*`). Common engine rule.
 */
const isTeam = (u: AuthzUser | null) => isEffectiveStaff(u, "ecommerce");
const isAdmin = (u: AuthzUser | null) => isEffectiveAdmin(u, "ecommerce");

/**
 * The panel routes on a specific row (`/admin/products/:id`…). Before, they
 * were opened by the host's `requireAuth`, which lets an AGENT through only
 * as an account with `user:act`, `admin` or some ecommerce scope
 * (`agent-as-user.ts`); the row's policy is checked afterward, in the
 * handler. SDK operations do not go through that rule, so it is repeated
 * here, as is.
 */
const actAsUser = actsAsUserIn("ecommerce");

export function registerShopPolicies(): void {
  definePolicy<ProductResource>("shop-product", {
    // The published catalog is public: it is what is sold. An inactive
    // product is a draft and only the team sees it.
    view: (user, item) => item.active !== false || isTeam(user),
    create: (user) => isTeam(user),
    update: (user) => isTeam(user),
    // Deleting a product leaves orders pointing at an id that no longer exists.
    // It survives because the line stores the name and price, but it is an
    // administrator's decision.
    delete: (user) => isAdmin(user),
    actAsUser,
  });

  definePolicy<OrderResource>("shop-order", {
    // It never compares with the buyer's email. See the explanation above.
    view: (user) => isTeam(user),

    // Creating orders CAN be done by anyone: it is the purchase. The public
    // route validates the content; authorization is not the barrier here.
    create: () => true,

    // Changing state is operating the store: manufacturing, marking ready, shipping.
    update: (user) => isTeam(user),

    // An order is an accounting document. It is not deleted: it is cancelled or
    // refunded, which leaves a trace. Not even the admin.
    delete: () => false,
    actAsUser,
  });

  definePolicy<PromotionResource>("shop-promotion", {
    // A discount code is money off: the team sees and manages them. The buyer only ever sends a
    // code with an order and never lists them.
    view: (user) => isTeam(user),
    create: (user) => isTeam(user),
    update: (user) => isTeam(user),
    // Orders have the code frozen: it is switched off, never deleted.
    delete: () => false,
    actAsUser,
  });
}

registerShopPolicies();
