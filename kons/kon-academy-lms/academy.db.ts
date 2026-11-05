/**
 * Database client typed with the kon's schema.
 *
 * Same pattern as NewsletterDb/ContaDb: narrowing the default `any` of
 * `KonContext.db.instance` brings typing back to the whole query chain
 * — `db.select()` knows the columns and callbacks infer on their own.
 */

import type { PgDatabase } from "drizzle-orm/pg-core";

import * as schema from "./academy-lms.schema";

/* eslint-disable @typescript-eslint/no-explicit-any -- Drizzle dialect and session:
   fixing them would tie the kon to a specific driver. The schema is typed. */
// The third generic stays `any` ON PURPOSE: typing it with
// ExtractTablesWithRelations would require the schema to declare `relations()`,
// and this kon does not define them — db.query.* would be typed as `never`. Once the
// schema declares its relations, change it and db.query gets full typing.
export type AcademyDb = PgDatabase<any, typeof schema, any>;
