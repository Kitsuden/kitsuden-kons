/**
 * kon-academy-lms — reads without Drizzle's relational API
 * ============================================================================
 *
 * The routes read with `db.query.<table>.findFirst/findMany({ where, with })`.
 * That API only exists for the tables of the schema the Drizzle instance was
 * CREATED with, and the instance is the host's: the core does not merge
 * this kon's schema (it migrates it itself with its SQL) nor does the kon declare
 * `relations()`. Result, tested over HTTP in phase D (2026-10-25):
 *
 *     undefined is not an object (evaluating 'dbInstance.query.courseProgressTable.findFirst')
 *
 * and 500 on my-progress, learning-paths/mine, reports/users, surveys/:id,
 * assignments/:id, certificates (and their PDF and verification), the detail of a
 * course or a topic, creating quizzes and assigning learning paths: the whole kon
 * could not be used as a student.
 *
 * These two functions do the same with the normal query builder
 * (`select().from()`), which works with any instance and inside the
 * request's RLS transaction. The `with:` are resolved in the route with one
 * more query per relation (see `withCourse`).
 */

import { inArray, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import type { AcademyDb } from "./academy.db";

type Row<T extends PgTable> = T["$inferSelect"];

/** The first row that satisfies `where` (or `undefined`), like `findFirst`. */
export async function first<T extends PgTable>(
  db: AcademyDb,
  table: T,
  where?: SQL,
  orderBy: SQL[] = []
): Promise<Row<T> | undefined> {
  const query = db
    .select()
    .from(table as PgTable)
    .where(where)
    .$dynamic();
  if (orderBy.length) query.orderBy(...orderBy);
  const [row] = await query.limit(1);
  return row as Row<T> | undefined;
}

/** All the rows that satisfy `where`, like `findMany`. */
export async function all<T extends PgTable>(
  db: AcademyDb,
  table: T,
  where?: SQL,
  orderBy: SQL[] = []
): Promise<Row<T>[]> {
  const query = db
    .select()
    .from(table as PgTable)
    .where(where)
    .$dynamic();
  if (orderBy.length) query.orderBy(...orderBy);
  return (await query) as Row<T>[];
}

/**
 * What `with: { <key>: true }` gave in a "one" relation: adds to each row
 * the `table` record whose `id` is `row[field]` (or `null`). A
 * single query for all the rows.
 */
export async function withRelation<F extends Record<string, unknown>, T extends PgTable, K extends string>(
  db: AcademyDb,
  rows: F[],
  field: keyof F,
  table: T & { id: PgColumn },
  key: K
): Promise<(F & Record<K, Row<T> | null>)[]> {
  const ids = [
    ...new Set(
      rows.map((f) => f[field] as unknown).filter((v): v is string => typeof v === "string")
    ),
  ];
  const relatedItems = ids.length ? await all(db, table, inArray(table.id, ids)) : [];
  const byId = new Map(relatedItems.map((r) => [(r as { id: string }).id, r]));
  return rows.map(
    (f) =>
      ({
        ...f,
        [key]: byId.get(f[field] as string) ?? null,
      }) as F & Record<K, Row<T> | null>
  );
}
