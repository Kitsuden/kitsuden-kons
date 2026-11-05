/**
 * Per-request context of the kon: who is asking and with what connection.
 * ============================================================================
 *
 * The RLS policies of `booking_reservations`/`booking_notes` compare the row
 * with `current_setting('app.current_user_id')`. For them to filter, each request has to carry
 * its user set in the transaction.
 *
 * The HOST now does that for all kons (2026-10-23): it mounts
 * `withTransactionalRLS()` in front of the router and `ctx.db.instance` resolves,
 * inside the request, to that transaction with `set_config(…, true)`. Before, the
 * kon opened its own transaction here, just as booking, crm and directory did
 * separately; now this file only keeps the shape of the routes (`dbDe`,
 * `userOf`) so they do not have to be rewritten.
 *
 * An anonymous user goes with id '' and role `anonymous`: it is NOT the system (the policies
 * require an empty id AND role for that). If the route fails (exception or 5xx), the
 * host rolls back the transaction.
 */

import type { AuthzUser } from "@kitsuden/engine";
import type { KonAuth } from "@kitsuden/shared";
import type { Context, MiddlewareHandler } from "hono";

import type { BookingDb } from "./booking.db";

const DB_KEY = "kon-booking:db";

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
export function dbDe(c: Context): BookingDb {
  const db = read<BookingDb>(c, DB_KEY);
  if (!db) throw new Error("kon-booking: the route did not go through rlsContext()");
  return db;
}

/**
 * Leaves at hand, for `dbDe`, the request's `db` (`ctx.db.instance`, which the
 * host resolves to the RLS transaction) and fills in the session if nobody did
 * before (public routes also need to know whether there is someone).
 */
export function rlsContext(db: BookingDb, auth: Partial<KonAuth>): MiddlewareHandler {
  return async (c, next) => {
    if (!read(c, "user") && auth.optionalAuth) {
      await auth.optionalAuth(c, async () => {});
    }
    (c as unknown as { set(k: string, v: unknown): void }).set(DB_KEY, db);
    await next();
  };
}
