/**
 * Per-request context of the kon: who asks and with which connection.
 * ============================================================================
 *
 * The RLS policies of `directory_employees`/`directory_employee_documents`
 * compare the row with `current_setting('app.current_user_id')`. For them to filter, each request has to carry
 * its user set in the transaction.
 *
 * That is now done by the HOST for all kons: it mounts
 * `withTransactionalRLS()` in front of the router and `ctx.db.instance` resolves,
 * inside the request, to that transaction with `set_config(…, true)`. Before, the
 * kon opened its own transaction here, just like booking, crm and directory
 * separately; now this file only keeps the shape of the routes (`dbDe`,
 * `userOf`) so as not to rewrite them.
 *
 * An anonymous user goes with id '' and role `anonymous`: it is NOT the system (the policies
 * require empty id AND role for that). If the route fails (exception or 5xx), the
 * host rolls back the transaction.
 */

import type { AuthzUser } from "@kitsuden/engine";
import type { KonAuth } from "@kitsuden/shared";
import type { Context, MiddlewareHandler } from "hono";

import type { DirectoryDb } from "./directory.db";

const DB_KEY = "kon-directory:db";

function read<T>(c: Context, key: string): T | undefined {
  return (c as unknown as { get(k: string): unknown }).get(key) as T | undefined;
}

/** The request's user, as authentication left it (with its scopes). */
export function userOf(c: Context): AuthzUser | null {
  const u = read<AuthzUser>(c, "user");
  if (!u || typeof u.id !== "string" || u.id.length === 0) return null;
  return u;
}

/** THIS request's connection (the RLS transaction the host opened). */
export function dbDe(c: Context): DirectoryDb {
  const db = read<DirectoryDb>(c, DB_KEY);
  if (!db) throw new Error("kon-directory: the route did not go through rlsContext()");
  return db;
}

/**
 * Leaves at hand, for `dbDe`, the request's `db` (`ctx.db.instance`, which the
 * host resolves to the RLS transaction) and fills in the session if nobody did
 * before (public routes also need to know whether there is someone).
 */
export function rlsContext(db: DirectoryDb, auth: Partial<KonAuth>): MiddlewareHandler {
  return async (c, next) => {
    if (!read(c, "user") && auth.optionalAuth) {
      await auth.optionalAuth(c, async () => {});
    }
    (c as unknown as { set(k: string, v: unknown): void }).set(DB_KEY, db);
    await next();
  };
}
