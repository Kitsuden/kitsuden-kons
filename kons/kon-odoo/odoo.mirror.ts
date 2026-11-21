/**
 * Odoo — from Odoo's records to the mirror's rows
 * ============================================================================
 *
 * Two halves. `planProduct` is arithmetic: it turns what Odoo answered into the rows the mirror
 * should hold, and touches nothing. `applyPlans` writes those rows and says what changed, which
 * is what the events and the site's cache need to know.
 *
 * What Odoo does that the mirror must survive:
 *   · it DELETES AND RECREATES variants when a product's attributes change, so a variant's id is
 *     not an identity. The internal reference is: a new id with a known reference is the same
 *     variant, and keeps its row here;
 *   · "on hand" is not what can be sold. `free_qty` (on hand and not reserved) is;
 *   · a product whose stock is not tracked has no quantity at all, and can always be sold;
 *   · stock can be negative. The mirror stores what Odoo says and treats it as none.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "./odoo.schema";
import {
  odooCategories,
  odooConflicts,
  odooProducts,
  odooVariants,
  type ConflictKind,
  type OdooCapabilities,
} from "./odoo.schema";

export type OdooDb = PgDatabase<PgQueryResultHKT, typeof schema>;

// ── Odoo's shapes ─────────────────────────────────────────────────────────────

/** A many2one as `read` answers it: `[id, display name]`, or `false` when empty. */
export type Many2one = [number, string] | number | false | null | undefined;

export const m2oId = (value: Many2one): number | null =>
  Array.isArray(value) ? value[0] : typeof value === "number" ? value : null;

export const m2oName = (value: Many2one): string | null => (Array.isArray(value) ? value[1] : null);

/** Odoo answers `false` for an empty text field. */
export const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** Odoo's datetimes are `YYYY-MM-DD HH:MM:SS` in UTC, with no zone written. */
export function odooDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const date = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A float from Odoo as the decimal string the columns hold. */
export function decimal(value: unknown): string | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number.toFixed(4) : null;
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

/** `black-lotus-412`. The id is what is looked up; the words are for people and search engines. */
export const productSlug = (name: string, odooId: number): string =>
  `${slugify(name) || "product"}-${odooId}`;

/** The Odoo id a slug ends in (`…-412`, or a bare `412`), or null. */
export function slugOdooId(slug: string): number | null {
  const match = /(?:^|-)(\d{1,9})$/.exec(slug);
  return match ? Number(match[1]) : null;
}

export interface TemplateRecord {
  id: number;
  name?: string | false;
  description_sale?: string | false;
  list_price?: number;
  default_code?: string | false;
  barcode?: string | false;
  categ_id?: Many2one;
  active?: boolean;
  sale_ok?: boolean;
  write_date?: string;
  currency_id?: Many2one;
  type?: string;
  is_storable?: boolean;
  is_published?: boolean;
}

export interface VariantRecord {
  id: number;
  product_tmpl_id?: Many2one;
  default_code?: string | false;
  barcode?: string | false;
  lst_price?: number;
  active?: boolean;
  write_date?: string;
  product_template_attribute_value_ids?: number[];
  free_qty?: number;
  qty_available?: number;
}

export interface AttributeValueRecord {
  id: number;
  attribute_id?: Many2one;
  name?: string | false;
}

// ── Plan ──────────────────────────────────────────────────────────────────────

export interface VariantPlan {
  odooId: number;
  sku: string | null;
  barcode: string | null;
  options: Record<string, string>;
  price: string | null;
  qtyFree: string | null;
  qtyOnHand: string | null;
  active: boolean;
  visible: boolean;
  odooWriteDate: Date | null;
}

export interface ProductPlan {
  odooId: number;
  slug: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  listPrice: string | null;
  minPrice: string | null;
  maxPrice: string | null;
  currency: string | null;
  categoryOdooId: number | null;
  attributes: Record<string, string[]>;
  qtyFree: string | null;
  inStock: boolean;
  published: boolean;
  active: boolean;
  imageVersion: string | null;
  odooWriteDate: Date | null;
  variants: VariantPlan[];
}

/** Does Odoo count units of this product? Before 18 that was `type = 'product'`. */
function tracksStock(template: TemplateRecord, capabilities: OdooCapabilities): boolean {
  if (!capabilities.stock) return false;
  if (typeof template.is_storable === "boolean") return template.is_storable;
  return template.type === "product";
}

export function planProduct(
  template: TemplateRecord,
  variants: VariantRecord[],
  attributeValues: Map<number, AttributeValueRecord>,
  capabilities: OdooCapabilities,
  companyCurrency: string | null
): ProductPlan {
  const name = text(template.name) ?? `Product ${template.id}`;
  const active = template.active !== false;
  const published =
    active &&
    template.sale_ok !== false &&
    (capabilities.website ? template.is_published === true : true);
  const tracked = tracksStock(template, capabilities);

  const plans: VariantPlan[] = variants.map((variant) => {
    const options: Record<string, string> = {};
    for (const id of variant.product_template_attribute_value_ids ?? []) {
      const value = attributeValues.get(id);
      const attribute = m2oName(value?.attribute_id);
      const label = text(value?.name);
      if (attribute && label) options[attribute] = label;
    }
    const variantActive = variant.active !== false;
    return {
      odooId: variant.id,
      sku: text(variant.default_code),
      barcode: text(variant.barcode),
      options,
      price: decimal(variant.lst_price),
      qtyFree: tracked ? decimal(variant.free_qty ?? 0) : null,
      qtyOnHand: tracked ? decimal(variant.qty_available ?? 0) : null,
      active: variantActive,
      visible: published && variantActive,
      odooWriteDate: odooDate(variant.write_date),
    };
  });

  const sellable = plans.filter((variant) => variant.active);
  const prices = sellable.map((variant) => Number(variant.price)).filter(Number.isFinite);
  const listPrice = decimal(template.list_price);

  const attributes: Record<string, string[]> = {};
  for (const variant of sellable) {
    for (const [attribute, label] of Object.entries(variant.options)) {
      const values = (attributes[attribute] ??= []);
      if (!values.includes(label)) values.push(label);
    }
  }

  const free = sellable.reduce((sum, variant) => sum + Math.max(0, Number(variant.qtyFree ?? 0)), 0);
  const currency = m2oName(template.currency_id);

  return {
    odooId: template.id,
    slug: productSlug(name, template.id),
    name,
    description: text(template.description_sale),
    sku: text(template.default_code),
    barcode: text(template.barcode),
    listPrice,
    minPrice: prices.length ? Math.min(...prices).toFixed(4) : listPrice,
    maxPrice: prices.length ? Math.max(...prices).toFixed(4) : listPrice,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : companyCurrency,
    categoryOdooId: m2oId(template.categ_id),
    attributes,
    qtyFree: tracked ? free.toFixed(4) : null,
    inStock: tracked ? free > 0 : true,
    published,
    active,
    imageVersion: text(template.write_date),
    odooWriteDate: odooDate(template.write_date),
    variants: plans,
  };
}

// ── Apply ─────────────────────────────────────────────────────────────────────

export type ChangeKind = "created" | "product" | "price" | "stock" | "retired";

export interface ProductChange {
  odooId: number;
  productId: string;
  slug: string;
  kinds: ChangeKind[];
}

/** Records a problem once while it is open. */
export async function reportConflict(
  db: OdooDb,
  kind: ConflictKind,
  reference: string,
  details: Record<string, unknown>,
  resolved = false
): Promise<void> {
  await db
    .insert(odooConflicts)
    .values({ kind, reference, details, resolvedAt: resolved ? new Date() : null, resolvedBy: resolved ? "sync" : null })
    .onConflictDoNothing();
}

const same = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && Number(a) === Number(b));

async function applyVariants(
  db: OdooDb,
  productId: string,
  plan: ProductPlan,
  kinds: Set<ChangeKind>,
  isNew: boolean
): Promise<void> {
  const existing = await db.select().from(odooVariants).where(eq(odooVariants.productId, productId));
  const byOdooId = new Map(existing.map((row) => [row.odooId, row]));
  const incoming = new Set(plan.variants.map((variant) => variant.odooId));
  // Rows whose Odoo id is gone: candidates to be the same variant under a new id.
  const orphans = existing.filter((row) => !incoming.has(row.odooId));
  const now = new Date();

  for (const variant of plan.variants) {
    const values = {
      sku: variant.sku,
      barcode: variant.barcode,
      options: variant.options,
      price: variant.price,
      qtyFree: variant.qtyFree,
      qtyOnHand: variant.qtyOnHand,
      active: variant.active,
      visible: variant.visible,
      odooWriteDate: variant.odooWriteDate,
      syncedAt: now,
    };

    let row = byOdooId.get(variant.odooId);
    if (!row && variant.sku) {
      const index = orphans.findIndex((orphan) => orphan.sku === variant.sku);
      if (index !== -1) {
        // Same reference, new id: Odoo recreated it. The row, and whatever points at it, stays.
        row = orphans.splice(index, 1)[0];
        await db
          .update(odooVariants)
          .set({ ...values, odooId: variant.odooId, previousOdooIds: [...row.previousOdooIds, row.odooId] })
          .where(eq(odooVariants.id, row.id));
        await reportConflict(
          db,
          "variant_recreated",
          variant.sku,
          { product: plan.odooId, from: row.odooId, to: variant.odooId },
          true
        );
        kinds.add("product");
        if (!same(row.price, variant.price)) kinds.add("price");
        if (!same(row.qtyFree, variant.qtyFree)) kinds.add("stock");
        continue;
      }
    }

    if (row) {
      if (!same(row.price, variant.price)) kinds.add("price");
      if (!same(row.qtyFree, variant.qtyFree)) kinds.add("stock");
      if (
        row.sku !== variant.sku ||
        row.active !== variant.active ||
        row.visible !== variant.visible ||
        JSON.stringify(row.options) !== JSON.stringify(variant.options)
      ) {
        kinds.add("product");
      }
      await db.update(odooVariants).set(values).where(eq(odooVariants.id, row.id));
    } else {
      await db.insert(odooVariants).values({ ...values, odooId: variant.odooId, productId });
      if (!isNew) kinds.add("product");
    }
  }

  // Gone from Odoo and not recognised under a new id: hidden, never deleted, because an order
  // may still name them.
  const gone = orphans.filter((row) => row.active || row.visible).map((row) => row.id);
  if (gone.length > 0) {
    await db
      .update(odooVariants)
      .set({ active: false, visible: false, syncedAt: now })
      .where(inArray(odooVariants.id, gone));
    kinds.add("product");
  }

  // One reference on two variants that can be sold: an order by reference could not tell them
  // apart, so a person has to fix it in Odoo.
  const references = [...new Set(plan.variants.filter((v) => v.active && v.sku).map((v) => v.sku as string))];
  if (references.length > 0) {
    const duplicated = await db
      .select({ sku: odooVariants.sku, count: sql<number>`count(*)::int` })
      .from(odooVariants)
      .where(and(inArray(odooVariants.sku, references), eq(odooVariants.active, true)))
      .groupBy(odooVariants.sku)
      .having(sql`count(*) > 1`);
    for (const row of duplicated) {
      if (row.sku) await reportConflict(db, "duplicate_reference", row.sku, { variants: row.count });
    }
  }
}

/** Writes the plans, in series, and answers what changed in each product. */
export async function applyPlans(db: OdooDb, plans: ProductPlan[]): Promise<ProductChange[]> {
  const changes: ProductChange[] = [];
  const now = new Date();

  for (const plan of plans) {
    const [before] = await db.select().from(odooProducts).where(eq(odooProducts.odooId, plan.odooId)).limit(1);
    const { variants: _variants, ...values } = plan;
    const kinds = new Set<ChangeKind>();

    let productId: string;
    if (before) {
      productId = before.id;
      await db
        .update(odooProducts)
        .set({ ...values, syncedAt: now, updatedAt: now })
        .where(eq(odooProducts.id, before.id));
      if (!same(before.minPrice, plan.minPrice) || !same(before.maxPrice, plan.maxPrice) || !same(before.listPrice, plan.listPrice)) {
        kinds.add("price");
      }
      if (!same(before.qtyFree, plan.qtyFree) || before.inStock !== plan.inStock) kinds.add("stock");
      if (
        before.name !== plan.name ||
        before.slug !== plan.slug ||
        before.description !== plan.description ||
        before.sku !== plan.sku ||
        before.published !== plan.published ||
        before.active !== plan.active ||
        before.categoryOdooId !== plan.categoryOdooId ||
        before.imageVersion !== plan.imageVersion
      ) {
        kinds.add("product");
      }
    } else {
      const [created] = await db
        .insert(odooProducts)
        .values({ ...values, syncedAt: now })
        .returning({ id: odooProducts.id });
      productId = created.id;
      kinds.add("created");
    }

    await applyVariants(db, productId, plan, kinds, !before);
    if (kinds.size > 0) changes.push({ odooId: plan.odooId, productId, slug: plan.slug, kinds: [...kinds] });
  }
  return changes;
}

/**
 * Products Odoo no longer answers for (deleted there): hidden here, with their variants.
 * Never deleted: an order may still name them.
 */
export async function retireProducts(db: OdooDb, odooIds: number[]): Promise<ProductChange[]> {
  if (odooIds.length === 0) return [];
  const rows = await db
    .select({ id: odooProducts.id, odooId: odooProducts.odooId, slug: odooProducts.slug })
    .from(odooProducts)
    .where(and(inArray(odooProducts.odooId, odooIds), eq(odooProducts.active, true)));
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const now = new Date();
  await db
    .update(odooProducts)
    .set({ active: false, published: false, inStock: false, syncedAt: now, updatedAt: now })
    .where(inArray(odooProducts.id, ids));
  await db
    .update(odooVariants)
    .set({ active: false, visible: false, syncedAt: now })
    .where(inArray(odooVariants.productId, ids));
  return rows.map((row) => ({ odooId: row.odooId, productId: row.id, slug: row.slug, kinds: ["retired"] }));
}

// ── Categories ────────────────────────────────────────────────────────────────

export interface CategoryRecord {
  id: number;
  name?: string | false;
  parent_id?: Many2one;
  parent_path?: string | false;
}

/** `/1/5/9/` for every category, from Odoo's own path or, without it, from the parents. */
export function categoryPaths(records: CategoryRecord[]): Map<number, string> {
  const parents = new Map(records.map((record) => [record.id, m2oId(record.parent_id)]));
  const paths = new Map<number, string>();
  for (const record of records) {
    const own = text(record.parent_path);
    if (own && /^(\d+\/)+$/.test(own)) {
      paths.set(record.id, `/${own}`);
      continue;
    }
    const chain: number[] = [];
    // A cycle in the parents would never end: a category is visited once.
    for (let id: number | null = record.id; id !== null && !chain.includes(id); id = parents.get(id) ?? null) {
      chain.unshift(id);
    }
    paths.set(record.id, `/${chain.join("/")}/`);
  }
  return paths;
}

/** Replaces the category mirror with what Odoo has now. */
export async function applyCategories(db: OdooDb, records: CategoryRecord[]): Promise<number> {
  const paths = categoryPaths(records);
  const now = new Date();
  for (const record of records) {
    const name = text(record.name) ?? `Category ${record.id}`;
    const values = {
      name,
      slug: `${slugify(name) || "category"}-${record.id}`,
      parentOdooId: m2oId(record.parent_id),
      path: paths.get(record.id) ?? `/${record.id}/`,
      syncedAt: now,
    };
    await db
      .insert(odooCategories)
      .values({ ...values, odooId: record.id })
      .onConflictDoUpdate({ target: odooCategories.odooId, set: values });
  }
  if (records.length > 0) {
    // What Odoo no longer has. Guarded by the count: an empty answer must not empty the mirror.
    await db.delete(odooCategories).where(
      sql`${odooCategories.odooId} NOT IN (${sql.join(
        records.map((record) => sql`${record.id}`),
        sql`, `
      )})`
    );
  }
  return records.length;
}
