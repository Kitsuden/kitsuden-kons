/**
 * Conta Kon — Shared Types
 *
 * Reusable types for strongly typing the database client
 * and other internal contracts.
 */

import type { PgDatabase } from "drizzle-orm/pg-core";

import * as schema from "./conta.schema";

/**
 * Database client typed with the accounting schema.
 * Use in ContaService, routers and helpers.
 */
export type ContaDb = PgDatabase<any, typeof schema, any>;

/**
 * Dynamic conditions for Drizzle AND queries
 */
export type Condition = Parameters<ContaDb["select"]>[0] extends infer R ? R : never;
