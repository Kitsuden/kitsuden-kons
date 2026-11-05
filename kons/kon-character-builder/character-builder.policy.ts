/**
 * Builder — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "builder" policy.
 *
 * Two natures coexist under the same policy because the resource says so:
 * a DEFINITION is editorial (a role to write); a BUILD is personal (its
 * owner rules). `view` distinguishes by `visibility` — a private build is seen by
 * no one else, and that is the contract promised to whoever saves it.
 */
import { type AuthzUser, actsAsUserIn, definePolicy, isEffectiveAdmin, isEffectiveStaff } from "@kitsuden/engine";


/**
 * EFFECTIVE team and admin: the human role, or an agent with the whole kon
 * (`admin`, `character-builder:*`, `kon:character-builder:*`). Common engine rule
 * (effective actor). An agent with `builder:publishDefinition` still
 * passes through the action's scope, as always.
 */
export const isBuilderTeam = (u: AuthzUser | null) => isEffectiveStaff(u, "character-builder");
const esAdminBuilder = (u: AuthzUser | null) => isEffectiveAdmin(u, "character-builder");

export interface BuilderResource {
  id: string;
  visibility?: string | null;
  ownerId?: string | null;
  /** Only on DEFINITIONS: `draft` | `published`. */
  published?: string | null;
}

export function registerBuilderPolicy(): void {
  definePolicy<BuilderResource>("builder", {
    /**
     * ── THE LEAK THIS CLOSES ─────────────────────────────────────────────────
     *
     * It used to say "without `visibility` it is a definition: editorial and public", and
     * with that a `draft` definition was readable by anyone who merely
     * knew its slug: a half-built builder, with its formulas and data,
     * before it was announced.
     *
     * It is the FOURTH time this family appears in this repo (blog, games,
     * esports and now builder): a publication state that exists in the table
     * and that public reads do not check.
     */
    view: (user: AuthzUser | null, item) => {
      const staff = isBuilderTeam(user);

      // A DEFINITION carries no `visibility`; its state is `published`.
      if (item.visibility === undefined || item.visibility === null) {
        return item.published === "published" || staff;
      }

      // A BUILD is personal: its owner rules.
      return (
        item.visibility === "public" ||
        item.visibility === "unlisted" ||
        esAdminBuilder(user) ||
        (!!item.ownerId && item.ownerId === user?.id)
      );
    },

    // Anyone with a session can save a build: it is THEIR build.
    create: (user) => Boolean(user),
    /**
     * Create or overwrite a DEFINITION (the site's official builder): it is
     * editorial. An agent passes with the `builder:publishDefinition` scope
     * (or `builder:*`, `admin`), as in the rest of the actions.
     */
    publishDefinition: (user) => isBuilderTeam(user),
    update: (user, item) => esAdminBuilder(user) || (!!item.ownerId && item.ownerId === user?.id),
    delete: (user, item) => esAdminBuilder(user) || (!!item.ownerId && item.ownerId === user?.id),

    /**
     * Act as any account (save a build, vote, validate a
     * definition). People with a session, all of them. An AGENT, only with the host's
     * rule for `requireAuth` — `user:act`, `admin` or some scope
     * of the kon (`agent-as-user.ts`)—. SDK operations do not go through
     * that rule, so it is repeated here, as is. (`builder:actAsUser`
     * and `builder:*` also grant it: it is the policy's scope.)
     */
    actAsUser: actsAsUserIn("character-builder"),
  });
}

registerBuilderPolicy();
