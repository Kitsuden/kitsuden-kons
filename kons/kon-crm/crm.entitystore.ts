/**
 * Where the CRM's entity types live: Kitsuden's entities, or the CRM's old table
 * ============================================================================
 *
 * An entity type is what a preset or an admin defines: "case", "property", "project", with its labels, its
 * custom fields, whether it needs a contact, its default pipeline, its numbering, its activity kinds and
 * its kon-conta mapping. The VALUES of a deal's custom fields stay in `crm_deals.custom_fields`: only the
 * type moves.
 *
 *   core   On a Kitsuden with runtime entities (`ctx.entities`), each type is an entity of the kon,
 *          `crm-<entityName>`, defined with `ctx.entities.define`. Fields become the core's field types
 *          (the CRM's own type is kept on the field as `crmType`), everything else goes in `settings`.
 *          At startup each row of `crm_entity_configs` is moved there once and marked `migratedTo`.
 *   table  On a Kitsuden without them, `crm_entity_configs`, as before.
 *
 * Both answer with the same `EntityType`, the shape every caller already used, so nothing above this file
 * knows which one it is talking to. A deal's `entity_config_id` holds the type's `id`: the old row id for a
 * moved type (so existing deals keep theirs), the slug for one created in the core (migration 0014 drops
 * the foreign key that tied it to the table).
 */

import { AppError } from "@kitsuden/engine";
import { createId } from "@paralleldrive/cuid2";
import type { KonContext } from "@kitsuden/shared";
import { and, desc, eq, sql } from "drizzle-orm";

import type { CrmDb } from "./crm.db";
import { crmEntityConfigs, type EntityFieldSchema } from "./crm.schema";

const KON_ID = "kon-crm";

export type EntityType = typeof crmEntityConfigs.$inferSelect;
export type EntityTypeInput = Partial<Omit<EntityType, "id" | "createdAt" | "updatedAt">> & {
  entityName: string;
  singularLabel: string;
  pluralLabel: string;
};

// ── The core's API, structurally (Kitsuden's `KonEntities`) ────────────────

interface CoreField {
  key: string;
  type: string;
  label?: string;
  required?: boolean;
  options?: Array<string | { value: string; label?: string }>;
  [extra: string]: unknown;
}

interface CoreDefinition {
  slug: string;
  name: string;
  description?: string;
  fields: CoreField[];
  access?: { read?: string; write?: string };
  settings?: Record<string, unknown>;
}

export interface CoreEntities {
  define(konId: string, definition: CoreDefinition): Promise<CoreDefinition>;
  undefine?(konId: string, slug: string, options?: { withRecords?: boolean }): Promise<boolean>;
  definitions(konId: string): Promise<CoreDefinition[]>;
  describe?(slug: string): Promise<CoreDefinition | null>;
}

// ── Field mapping ──────────────────────────────────────────────────────────

const CORE_TYPE: Record<EntityFieldSchema["type"], string> = {
  text: "text",
  number: "number",
  currency: "number",
  date: "date",
  datetime: "datetime",
  select: "select",
  multiselect: "multiselect",
  boolean: "boolean",
  email: "email",
  url: "url",
  file: "media",
  contact: "relation",
  company: "relation",
};

export function toCoreField(f: EntityFieldSchema): CoreField {
  const { key, type, label, required, options, sensitive, validation, ...rest } = f;
  return {
    ...rest,
    key,
    type: CORE_TYPE[type] ?? "text",
    crmType: type,
    label,
    ...(required !== undefined ? { required } : {}),
    ...(options ? { options } : {}),
    // The core's egress guard reads `sensitivity`; the CRM's own access reads `sensitive`.
    ...(sensitive ? { sensitive: true, sensitivity: "customer" } : {}),
    ...(validation?.min !== undefined ? { minValue: validation.min } : {}),
    ...(validation?.max !== undefined ? { maxValue: validation.max } : {}),
    ...(validation?.pattern ? { validationRegex: validation.pattern } : {}),
  };
}

export function fromCoreField(f: CoreField): EntityFieldSchema {
  const { key, type, label, required, options, crmType, minValue, maxValue, validationRegex, sensitivity, sensitive, ...rest } = f;
  const validation: EntityFieldSchema["validation"] = {};
  if (typeof minValue === "number") validation.min = minValue;
  if (typeof maxValue === "number") validation.max = maxValue;
  if (typeof validationRegex === "string") validation.pattern = validationRegex;
  void sensitivity;
  return {
    ...(rest as object),
    key,
    type: (typeof crmType === "string" ? crmType : type) as EntityFieldSchema["type"],
    label: label ?? key,
    ...(required !== undefined ? { required } : {}),
    ...(options ? { options: options.map((o) => (typeof o === "string" ? o : o.value)) } : {}),
    ...(sensitive ? { sensitive: true } : {}),
    ...(Object.keys(validation).length ? { validation } : {}),
  } as EntityFieldSchema;
}

export function slugOf(entityName: string): string {
  const base = entityName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "type";
  return `crm-${base}`.slice(0, 100);
}

function toDefinition(t: EntityType): CoreDefinition {
  return {
    slug: slugOf(t.entityName),
    name: t.singularLabel,
    description: t.pluralLabel,
    fields: ((t.fieldSchema as EntityFieldSchema[] | null) ?? []).map(toCoreField),
    access: { read: "admin", write: "admin" },
    settings: {
      id: t.id,
      konId: t.konId,
      entityName: t.entityName,
      singularLabel: t.singularLabel,
      pluralLabel: t.pluralLabel,
      requiresContact: t.requiresContact,
      requiresCompany: t.requiresCompany,
      allowsValue: t.allowsValue,
      allowsTimeTracking: t.allowsTimeTracking,
      defaultPipelineId: t.defaultPipelineId,
      isActive: t.isActive,
      isDefault: t.isDefault,
      metadata: t.metadata ?? {},
      createdBy: t.createdBy,
      createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : null,
      updatedAt: new Date().toISOString(),
    },
  };
}

function fromDefinition(d: CoreDefinition): EntityType {
  const s = (d.settings ?? {}) as Record<string, unknown>;
  const date = (v: unknown) => (typeof v === "string" ? new Date(v) : null);
  return {
    id: (s.id as string) ?? d.slug,
    konId: (s.konId as string) ?? KON_ID,
    entityName: (s.entityName as string) ?? d.slug.replace(/^crm-/, ""),
    singularLabel: (s.singularLabel as string) ?? d.name,
    pluralLabel: (s.pluralLabel as string) ?? d.description ?? d.name,
    requiresContact: (s.requiresContact as boolean | null) ?? true,
    requiresCompany: (s.requiresCompany as boolean | null) ?? true,
    allowsValue: (s.allowsValue as boolean | null) ?? true,
    allowsTimeTracking: (s.allowsTimeTracking as boolean | null) ?? true,
    fieldSchema: d.fields.map(fromCoreField),
    defaultPipelineId: (s.defaultPipelineId as string | null) ?? null,
    isActive: (s.isActive as boolean | null) ?? true,
    isDefault: (s.isDefault as boolean | null) ?? false,
    metadata: (s.metadata as Record<string, unknown>) ?? {},
    createdAt: date(s.createdAt),
    updatedAt: date(s.updatedAt),
    createdBy: (s.createdBy as string | null) ?? null,
  } as EntityType;
}

// ── The two stores ─────────────────────────────────────────────────────────

export interface EntityTypeStore {
  readonly backend: "core" | "table";
  list(): Promise<EntityType[]>;
  byId(id: string): Promise<EntityType | undefined>;
  byName(name: string): Promise<EntityType | undefined>;
  create(input: EntityTypeInput): Promise<EntityType>;
  update(id: string, patch: Partial<EntityTypeInput>): Promise<EntityType | undefined>;
}

function tableStore(db: CrmDb): EntityTypeStore {
  return {
    backend: "table",
    list: () => db.select().from(crmEntityConfigs).orderBy(desc(crmEntityConfigs.updatedAt)),
    async byId(id) {
      const [row] = await db.select().from(crmEntityConfigs).where(eq(crmEntityConfigs.id, id)).limit(1);
      return row;
    },
    async byName(name) {
      const [row] = await db
        .select()
        .from(crmEntityConfigs)
        .where(and(eq(crmEntityConfigs.entityName, name), eq(crmEntityConfigs.isActive, true)))
        .limit(1);
      return row;
    },
    async create(input) {
      const [row] = await db.insert(crmEntityConfigs).values({ konId: KON_ID, ...input }).returning();
      return row;
    },
    async update(id, patch) {
      const [row] = await db
        .update(crmEntityConfigs)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(crmEntityConfigs.id, id))
        .returning();
      return row;
    },
  };
}

/** Types not moved yet (a failed or interrupted migration) are still read from the table. */
async function unmigratedRows(db: CrmDb): Promise<EntityType[]> {
  try {
    return await db
      .select()
      .from(crmEntityConfigs)
      .where(sql`${crmEntityConfigs.metadata} ->> 'migratedTo' IS NULL`);
  } catch {
    return [];
  }
}

function coreStore(entities: CoreEntities, db: CrmDb): EntityTypeStore {
  const all = async (): Promise<EntityType[]> => {
    const defined = (await entities.definitions(KON_ID)).filter((d) => d.slug.startsWith("crm-")).map(fromDefinition);
    const names = new Set(defined.map((t) => t.entityName));
    const legacy = (await unmigratedRows(db)).filter((r) => !names.has(r.entityName));
    return [...defined, ...legacy].sort((a, b) => (b.updatedAt?.getTime?.() ?? 0) - (a.updatedAt?.getTime?.() ?? 0));
  };
  return {
    backend: "core",
    list: all,
    byId: async (id) => (await all()).find((t) => t.id === id || slugOf(t.entityName) === id),
    byName: async (name) => (await all()).find((t) => t.entityName === name && t.isActive !== false),
    async create(input) {
      if ((await all()).some((t) => t.entityName === input.entityName)) {
        throw AppError.conflict(`An entity named ${input.entityName} exists`);
      }
      const type = { ...fromDefinition({ slug: slugOf(input.entityName), name: input.singularLabel, fields: [] }), ...input, id: slugOf(input.entityName), konId: KON_ID, createdAt: new Date() } as EntityType;
      return fromDefinition(await entities.define(KON_ID, toDefinition(type)));
    },
    async update(id, patch) {
      const current = (await all()).find((t) => t.id === id || slugOf(t.entityName) === id);
      if (!current) return undefined;
      const next = { ...current, ...patch } as EntityType;
      if (patch.entityName && patch.entityName !== current.entityName) {
        throw AppError.conflict("An entity's name cannot change once it is a Kitsuden entity: create another");
      }
      return fromDefinition(await entities.define(KON_ID, toDefinition(next)));
    },
  };
}

// ── Which one ──────────────────────────────────────────────────────────────

let core: CoreEntities | null = null;

/** Set when the kon's operations are built and at startup, like the event sink. */
export function useEntityTypes(ctx: Pick<KonContext, never> & { entities?: unknown }): void {
  const e = ctx.entities as Partial<CoreEntities> | undefined;
  core = e && typeof e.define === "function" && typeof e.definitions === "function" ? (e as CoreEntities) : null;
}

export function entityTypes(db: CrmDb): EntityTypeStore {
  return core ? coreStore(core, db) : tableStore(db);
}

/**
 * Moves every row of `crm_entity_configs` into Kitsuden's entities, once. A moved row keeps its data, gets
 * `metadata.migratedTo` and is no longer read. A row whose definition fails stays where it was and is read
 * from the table, so nothing disappears halfway.
 */
export async function migrateEntityTypes(db: CrmDb): Promise<{ moved: string[]; failed: Array<{ name: string; error: string }> }> {
  const result = { moved: [] as string[], failed: [] as Array<{ name: string; error: string }> };
  if (!core) return result;
  for (const row of await unmigratedRows(db)) {
    try {
      const def = toDefinition(row);
      await core.define(KON_ID, def);
      await db
        .update(crmEntityConfigs)
        .set({ metadata: { ...((row.metadata as Record<string, unknown>) ?? {}), migratedTo: def.slug } })
        .where(eq(crmEntityConfigs.id, row.id));
      result.moved.push(def.slug);
    } catch (err) {
      result.failed.push({ name: row.entityName, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** A fresh id for a table row, for callers that need one before inserting. */
export const newEntityTypeId = createId;
