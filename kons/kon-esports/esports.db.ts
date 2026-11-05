/**
 * Database client typed with the kon's schema.
 *
 * Same pattern as NewsletterDb/ContaDb: narrowing the default `any` of
 * `KonContext.db.instance` brings typing back to the whole query chain
 * — `db.select()` knows the columns and callbacks infer on their own.
 */

import type { PgDatabase } from "drizzle-orm/pg-core";

import * as schema from "./esports.schema";

/* eslint-disable @typescript-eslint/no-explicit-any -- Drizzle dialect and session:
   fixing them would tie the kon to a specific driver. The schema is typed. */
export type EsportsDb = PgDatabase<any, typeof schema, any>;
