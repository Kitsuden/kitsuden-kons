/**
 * Members — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "member" policy.
 *
 * MIND the distinction, which is what prevents a leak of personal data:
 *
 *   - This policy governs the BACKOFFICE: which team member can list,
 *     edit or delete members.
 *   - A READER's access to paid content does NOT go through here, but through
 *     `members.access.ts`. They are two different questions: "can this editor
 *     see this subscriber's record?" and "can this subscriber read this post?".
 *
 * Mixing them would end up giving a member permission to list the other
 * members — that is, the entire email list.
 */
import { definePolicy, isEffectiveAdmin, isEffectiveStaff, type AuthzUser } from "@kitsuden/engine";

/**
 * EFFECTIVE team and management: the human role, or an agent with the whole kon
 * (`admin`, `members:*`, `kon:members:*`). Common engine rule (effective-actor).
 */
const team = (user: AuthzUser | null) => isEffectiveStaff(user, "members");
const address = (user: AuthzUser | null) => isEffectiveAdmin(user, "members");

export interface MemberResource {
  id: string;
  /** Linked CMS user, if any. Almost always null. */
  authUserId?: string | null;
}

export function registerMembersPolicy(): void {
  definePolicy<MemberResource>("member", {
    // The member list is the business's email database: not seen by
    // just anyone with an account. A member can see THEIR OWN record.
    view: (user: AuthzUser | null, item) =>
      team(user) || (!!item.authUserId && item.authUserId === user?.id),

    create: (user) => team(user),
    update: (user) => team(user),

    // Deleting a member destroys their payment and consent history.
    delete: (user) => address(user),
  });

  // Tiers are pricing configuration: management only.
  definePolicy<{ id: string }>("member-tier", {
    view: () => true, // the public portal needs to show the plans
    create: (user) => address(user),
    update: (user) => address(user),
    delete: (user) => address(user),
  });
}

registerMembersPolicy();
