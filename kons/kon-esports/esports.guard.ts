/**
 * Esports authorization guards
 * ============================================================================
 *
 * A single place that decides "this is done by the organization", so that
 * adding a new route does not mean remembering all over again.
 *
 * It is separate from the policy because they are two different things: the
 * policy is the RULE (can this user?), and this is the middleware that
 * enforces it and responds.
 */

import { can, type AuthzUser } from "@kitsuden/engine";
import type { Context, MiddlewareHandler, Next } from "hono";

import "./esports.policy.js";

/**
 * Organization only.
 *
 * It goes AFTER `requireAuth` and not in its place: `requireAuth` resolves the
 * session (and returns 401 if there is none), and this decides whether that
 * session is in charge here.
 */
export const requireStaff: MiddlewareHandler = async (c: Context, next: Next) => {
  const user = (c.get("user") ?? null) as AuthzUser | null;
  if (!(await can(user, "manage", {}, "esports"))) {
    return c.json({ error: "Only the organization can do this." }, 403);
  }
  return next();
};

/**
 * Checks an action on a specific participant (my check-in, my withdrawal).
 *
 * Returns the ready-made error or `null` if it can proceed, instead of being
 * middleware: these routes need to load the row to decide, and loading it
 * twice would be worse than calling this in the middle.
 */
export async function denyUnless(
  c: Context,
  action: string,
  participant: { registeredByUserId?: string | null } | null
): Promise<Response | null> {
  const user = (c.get("user") ?? null) as AuthzUser | null;
  if (await can(user, action, participant ?? {}, "esports")) return null;
  return c.json({ error: "You cannot do this on that participant." }, 403);
}
