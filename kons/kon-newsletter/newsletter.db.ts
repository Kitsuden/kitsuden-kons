/**
 * Kitsuden Newsletter — Typed database client
 * ============================================================================
 *
 * `KonContext.db.instance` has a permissive default (`any`) so as not to
 * break kons that have not migrated yet. Here it is narrowed with the real
 * schema, which is what restores typing to the WHOLE chain: `db.select()`
 * knows the columns, `where` clauses are validated and results stop being
 * a propagating `any`.
 *
 * It is a LOCAL change: it does not touch the host or the other kons. Same
 * pattern as `ContaDb` in kon-conta.
 */

import type { PgDatabase } from "drizzle-orm/pg-core";

import * as schema from "./newsletter.schema";

/* eslint-disable @typescript-eslint/no-explicit-any -- the two remaining
   parameters are Drizzle's dialect and session: they add no safety to the
   consumer and pinning them would tie the kon to a specific driver (pg vs
   postgres.js vs PGlite). The one that matters —the schema— is pinned. */
export type NewsletterDb = PgDatabase<any, typeof schema, any>;
