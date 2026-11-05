/**
 * Comments — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "comments" policy.
 *
 * Reading is public — a thread only registered users see adds nothing to a
 * wiki page — writing asks for a session, and editing or deleting belongs to the author or to
 * whoever moderates.
 *
 * `update` belongs to the author **and nobody else**, not even the admin: a moderator
 * who could rewrite someone else's comment could put words in another's mouth.
 * That is what `moderate` is for, which changes the STATE without touching the text.
 */
import { definePolicy, type AuthzUser } from "@kitsuden/engine";

export interface CommentResource {
  id?: string;
  authorId?: string | null;
  status?: string | null;
}

function isPerson(user: AuthzUser | null): boolean {
  return Boolean(user?.id) && user?.role !== "agent";
}

export function registerCommentsPolicy(): void {
  definePolicy<CommentResource>("comments", {
    view: () => true,

    /**
     * A PERSON with a session. An agent (`role: "agent"`) does not get in just for having an
     * id: it needs the scope (`comments:create`, `comments:*` or `admin`), which
     * `can()` grants in the engine. Before, an agent with only `mcp:connect`
     * posted on the site (phase D).
     */
    create: (user: AuthzUser | null) => isPerson(user),

    // Voting, likewise: a person with a session, or an agent with `comments:vote`/`comments:*`.
    vote: (user: AuthzUser | null) => isPerson(user),

    // Author only. A moderator hides, does not rewrite.
    update: (user, item) => Boolean(user) && !!item.authorId && item.authorId === user?.id,

    delete: (user, item) =>
      user?.role === "admin" ||
      user?.role === "editor" ||
      (!!item.authorId && item.authorId === user?.id),

    moderate: (user: AuthzUser | null) => user?.role === "admin" || user?.role === "editor",
  });
}

registerCommentsPolicy();
