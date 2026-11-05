/**
 * What an installation defined: entities, their fields, activity kinds, numbering
 * ============================================================================
 *
 * A preset (or an admin) describes the business in `crm_entity_configs`. These helpers read it the same way
 * everywhere, so validation, filters, the portal and the ledger agree on which fields exist and what they mean.
 *
 *   - A deal's entity is the one it names, else the one whose default pipeline it is in, else the default one.
 *     Deals created in a preset's pipeline therefore get that preset's fields without naming the entity.
 *   - Contacts and companies have one entity each, named `contact` and `company`.
 *   - Activity kinds live in the `activity` entity's `metadata.kinds`; with none defined, any kind is accepted.
 *   - Numbering (`metadata.numbering: { field, prefix, padding }`) fills a deal field from a counter.
 */

import { and, eq, sql } from "drizzle-orm";

import type { CrmDb } from "./crm.db";
import { crmEntityConfigs, type EntityFieldSchema } from "./crm.schema";

type EntityConfig = typeof crmEntityConfigs.$inferSelect;

export interface ActivityKind {
  key: string;
  label?: string;
  type?: string;
  defaultDurationMinutes?: number;
}

export interface Numbering {
  field: string;
  prefix?: string;
  padding?: number;
}

/**
 * Which fields feed the ledger. On a deal entity, the project's `billingType` and `category`
 * (`{ billingType: "feeType", category: "practiceArea" }`); on the contact and company entities, the client's `taxId`.
 */
export interface ContaMapping {
  billingType?: string;
  category?: string;
  taxId?: string;
}

const active = eq(crmEntityConfigs.isActive, true);

export async function entityByName(db: CrmDb, name: string): Promise<EntityConfig | undefined> {
  const [row] = await db.select().from(crmEntityConfigs).where(and(eq(crmEntityConfigs.entityName, name), active)).limit(1);
  return row;
}

export async function entityOfDeal(
  db: CrmDb,
  deal: { entityConfigId?: string | null; pipelineId?: string | null }
): Promise<EntityConfig | undefined> {
  if (deal.entityConfigId) {
    const [row] = await db.select().from(crmEntityConfigs).where(and(eq(crmEntityConfigs.id, deal.entityConfigId), active));
    if (row) return row;
  }
  if (deal.pipelineId) {
    const [row] = await db
      .select()
      .from(crmEntityConfigs)
      .where(and(eq(crmEntityConfigs.defaultPipelineId, deal.pipelineId), active))
      .limit(1);
    if (row) return row;
  }
  const [row] = await db.select().from(crmEntityConfigs).where(and(eq(crmEntityConfigs.isDefault, true), active)).limit(1);
  return row;
}

/** Every field defined on any active entity: what `cf.<key>` filters may name. */
export async function allFields(db: CrmDb): Promise<EntityFieldSchema[]> {
  const rows = await db.select({ fieldSchema: crmEntityConfigs.fieldSchema }).from(crmEntityConfigs).where(active);
  return rows.flatMap((r) => r.fieldSchema ?? []);
}

function metadataOf(entity: EntityConfig | undefined): Record<string, unknown> {
  const m = entity?.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

export async function activityKinds(db: CrmDb): Promise<ActivityKind[]> {
  const kinds = metadataOf(await entityByName(db, "activity")).kinds;
  return Array.isArray(kinds) ? (kinds as ActivityKind[]) : [];
}

export function numberingOf(entity: EntityConfig | undefined): Numbering | null {
  const n = metadataOf(entity).numbering as Numbering | undefined;
  return n && typeof n.field === "string" && n.field ? n : null;
}

export function contaMappingOf(entity: EntityConfig | undefined): ContaMapping {
  const m = metadataOf(entity).conta;
  return m && typeof m === "object" ? (m as ContaMapping) : {};
}

/** The next value of a counter, taken atomically: two deals created at once never share a number. */
export async function nextNumber(db: CrmDb, name: string): Promise<number> {
  const result = await db.execute(
    sql`INSERT INTO crm_counters (name, value) VALUES (${name}, 1)
        ON CONFLICT (name) DO UPDATE SET value = crm_counters.value + 1
        RETURNING value`
  );
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return Number((rows[0] as { value: number | string }).value);
}

export function formatNumber(n: Numbering, value: number): string {
  return `${n.prefix ?? ""}${String(value).padStart(n.padding ?? 4, "0")}`;
}
