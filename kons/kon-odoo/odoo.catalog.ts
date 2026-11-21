/**
 * Odoo — the public catalog, read from the mirror
 * ============================================================================
 *
 * Nothing here calls Odoo. A visitor filtering the shop reads this Kitsuden's own tables, so
 * the ERP serves the people working in it and not the public's clicks.
 *
 * Only what is published is ever listed, whoever asks: the team looks at unpublished rows in
 * the panel, not through the shop's API.
 */

import type { KonContext } from "@kitsuden/shared";
import { and, asc, desc, eq, gte, ilike, inArray, like, lte, or, sql, type SQL } from "drizzle-orm";

import { slugOdooId, type OdooDb } from "./odoo.mirror";
import { odooCategories, odooProducts, odooVariants, type OdooCategory, type OdooProduct, type OdooVariant } from "./odoo.schema";

export const SORTS = ["name", "price-asc", "price-desc", "newest"] as const;
export type Sort = (typeof SORTS)[number];

export interface CatalogQuery {
  search?: string;
  /** A category's slug or Odoo id. Its subcategories are included */
  category?: string;
  /** Attribute to accepted values: values of one attribute are OR, attributes are AND */
  attributes?: Record<string, string[]>;
  priceMin?: number;
  priceMax?: number;
  inStock?: boolean;
  sort?: Sort;
  page?: number;
  pageSize?: number;
  facets?: boolean;
}

export interface CatalogCategoryRef {
  id: string;
  slug: string;
  title: string;
}

export interface CatalogItem {
  /** Odoo's template id: what a change notice and the site's cache key on */
  id: string;
  slug: string;
  title: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  price: { amount: string; max: string; currency: string | null } | null;
  availability: "InStock" | "OutOfStock";
  /** Free-to-use units, or null when Odoo does not count this product */
  quantity: string | null;
  category: CatalogCategoryRef | null;
  attributes: Record<string, string[]>;
  image: string | null;
  updatedAt: string;
}

export interface CatalogVariant {
  id: string;
  sku: string | null;
  barcode: string | null;
  options: Record<string, string>;
  price: { amount: string; currency: string | null } | null;
  availability: "InStock" | "OutOfStock";
  quantity: string | null;
}

export interface CatalogFacet {
  name: string;
  values: Array<{ value: string; label: string; count: number }>;
}

/** `%` and `_` typed by a visitor are letters, not wildcards. */
const literal = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

const visible = and(eq(odooProducts.published, true), eq(odooProducts.active, true)) as SQL;

function imageUrl(ctx: KonContext, product: OdooProduct): string | null {
  if (!product.imageKey) return null;
  const url = ctx.storage.publicUrl(product.imageKey);
  // The key is the same when the picture changes; the version makes it a new address.
  const version = product.imageVersion ? encodeURIComponent(product.imageVersion) : "";
  return version ? `${url}${url.includes("?") ? "&" : "?"}v=${version}` : url;
}

function toItem(ctx: KonContext, product: OdooProduct, categories: Map<number, OdooCategory>): CatalogItem {
  const category = product.categoryOdooId !== null ? categories.get(product.categoryOdooId) : undefined;
  return {
    id: String(product.odooId),
    slug: product.slug,
    title: product.name,
    description: product.description,
    sku: product.sku,
    barcode: product.barcode,
    price:
      product.minPrice !== null
        ? { amount: product.minPrice, max: product.maxPrice ?? product.minPrice, currency: product.currency }
        : null,
    availability: product.inStock ? "InStock" : "OutOfStock",
    quantity: product.qtyFree,
    category: category ? { id: String(category.odooId), slug: category.slug, title: category.name } : null,
    attributes: product.attributes,
    image: imageUrl(ctx, product),
    updatedAt: product.updatedAt.toISOString(),
  };
}

function toVariant(variant: OdooVariant, currency: string | null): CatalogVariant {
  // No quantity means Odoo does not count it: it can always be sold. Otherwise what is free in
  // Odoo, less what orders being paid hold here.
  const free = variant.qtyFree === null ? null : Math.max(0, Number(variant.qtyFree) - Number(variant.qtyHeld));
  return {
    id: variant.id,
    sku: variant.sku,
    barcode: variant.barcode,
    options: variant.options,
    price: variant.price !== null ? { amount: variant.price, currency } : null,
    availability: free === null || free > 0 ? "InStock" : "OutOfStock",
    quantity: free === null ? null : free.toFixed(4),
  };
}

async function categoriesById(db: OdooDb, ids: number[]): Promise<Map<number, OdooCategory>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(odooCategories).where(inArray(odooCategories.odooId, unique));
  return new Map(rows.map((row) => [row.odooId, row]));
}

/** The ids of a category and everything under it, or an empty list when there is no such category. */
async function subtree(db: OdooDb, category: string): Promise<number[]> {
  const id = /^\d{1,9}$/.test(category) ? Number(category) : slugOdooId(category);
  const [root] = await db
    .select()
    .from(odooCategories)
    .where(id !== null ? eq(odooCategories.odooId, id) : eq(odooCategories.slug, category))
    .limit(1);
  if (!root) return [];
  const rows = await db
    .select({ odooId: odooCategories.odooId })
    .from(odooCategories)
    .where(like(odooCategories.path, `${literal(root.path)}%`));
  return rows.map((row) => row.odooId);
}

function filters(query: CatalogQuery, categoryIds: number[] | null): SQL[] {
  const where: SQL[] = [visible];
  const search = query.search?.trim();
  if (search) {
    const pattern = `%${literal(search)}%`;
    where.push(or(ilike(odooProducts.name, pattern), ilike(odooProducts.sku, pattern)) as SQL);
  }
  if (categoryIds !== null) {
    // A category that does not exist matches nothing, rather than everything.
    where.push(categoryIds.length > 0 ? inArray(odooProducts.categoryOdooId, categoryIds) : sql`false`);
  }
  for (const [attribute, values] of Object.entries(query.attributes ?? {})) {
    if (values.length === 0) continue;
    where.push(
      or(...values.map((value) => sql`${odooProducts.attributes} @> ${JSON.stringify({ [attribute]: [value] })}::jsonb`)) as SQL
    );
  }
  if (query.priceMin !== undefined) where.push(gte(odooProducts.minPrice, String(query.priceMin)));
  if (query.priceMax !== undefined) where.push(lte(odooProducts.minPrice, String(query.priceMax)));
  if (query.inStock) where.push(eq(odooProducts.inStock, true));
  return where;
}

const ORDER: Record<Sort, SQL[]> = {
  name: [asc(sql`lower(${odooProducts.name})`), asc(odooProducts.odooId)],
  "price-asc": [sql`${odooProducts.minPrice} ASC NULLS LAST`, asc(odooProducts.odooId)],
  "price-desc": [sql`${odooProducts.minPrice} DESC NULLS LAST`, asc(odooProducts.odooId)],
  newest: [desc(odooProducts.createdAt), asc(odooProducts.odooId)],
};

export const MAX_PAGE_SIZE = 100;

export interface CatalogPage {
  docs: CatalogItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  facets?: CatalogFacet[];
}

export async function listProducts(ctx: KonContext, db: OdooDb, query: CatalogQuery): Promise<CatalogPage> {
  const pageSize = Math.min(Math.max(query.pageSize ?? 24, 1), MAX_PAGE_SIZE);
  const page = Math.max(query.page ?? 1, 1);
  const categoryIds = query.category ? await subtree(db, query.category) : null;
  const where = and(...filters(query, categoryIds));

  const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(odooProducts).where(where);
  const total = count?.total ?? 0;
  const rows = await db
    .select()
    .from(odooProducts)
    .where(where)
    .orderBy(...ORDER[query.sort ?? "name"])
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const categories = await categoriesById(
    db,
    rows.flatMap((row) => (row.categoryOdooId !== null ? [row.categoryOdooId] : []))
  );
  const result: CatalogPage = {
    docs: rows.map((row) => toItem(ctx, row, categories)),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };

  if (query.facets) {
    // Counted without the category filter: a facet shows where else the same search would land.
    const counts = await db
      .select({ category: odooProducts.categoryOdooId, count: sql<number>`count(*)::int` })
      .from(odooProducts)
      .where(and(...filters(query, null)))
      .groupBy(odooProducts.categoryOdooId);
    const named = await categoriesById(
      db,
      counts.flatMap((row) => (row.category !== null ? [row.category] : []))
    );
    result.facets = [
      {
        name: "category",
        values: counts
          .flatMap((row) => {
            const category = row.category !== null ? named.get(row.category) : undefined;
            return category ? [{ value: category.slug, label: category.name, count: row.count }] : [];
          })
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      },
    ];
  }
  return result;
}

export interface CatalogProduct extends CatalogItem {
  variants: CatalogVariant[];
}

/**
 * One product by its slug. The Odoo id at the end of the slug is what is looked up, so a link
 * made before the product was renamed still finds it; the answer carries the current slug for
 * the site to redirect to.
 */
export async function getProduct(ctx: KonContext, db: OdooDb, slug: string): Promise<CatalogProduct | null> {
  const odooId = slugOdooId(slug);
  const [product] = await db
    .select()
    .from(odooProducts)
    .where(and(visible, odooId !== null ? eq(odooProducts.odooId, odooId) : eq(odooProducts.slug, slug)))
    .limit(1);
  if (!product) return null;

  const variants = await db
    .select()
    .from(odooVariants)
    .where(and(eq(odooVariants.productId, product.id), eq(odooVariants.active, true)))
    .orderBy(asc(odooVariants.odooId));
  const categories = await categoriesById(db, product.categoryOdooId !== null ? [product.categoryOdooId] : []);
  return {
    ...toItem(ctx, product, categories),
    variants: variants.map((variant) => toVariant(variant, product.currency)),
  };
}

export interface CatalogCategory extends CatalogCategoryRef {
  parentId: string | null;
  /** Published products directly in it */
  count: number;
}

export async function listCategories(db: OdooDb): Promise<CatalogCategory[]> {
  const rows = await db.select().from(odooCategories).orderBy(asc(odooCategories.path));
  const counts = await db
    .select({ category: odooProducts.categoryOdooId, count: sql<number>`count(*)::int` })
    .from(odooProducts)
    .where(visible)
    .groupBy(odooProducts.categoryOdooId);
  const byCategory = new Map(counts.map((row) => [row.category, row.count]));
  return rows.map((row) => ({
    id: String(row.odooId),
    slug: row.slug,
    title: row.name,
    parentId: row.parentOdooId !== null ? String(row.parentOdooId) : null,
    count: byCategory.get(row.odooId) ?? 0,
  }));
}

/** Every published product's slug and last change, a page at a time, in a stable order: the sitemap. */
export async function listSummaries(
  db: OdooDb,
  after: number,
  limit: number
): Promise<Array<{ id: string; slug: string; updatedAt: string }>> {
  const rows = await db
    .select({ odooId: odooProducts.odooId, slug: odooProducts.slug, updatedAt: odooProducts.updatedAt })
    .from(odooProducts)
    .where(and(visible, sql`${odooProducts.odooId} > ${after}`))
    .orderBy(asc(odooProducts.odooId))
    .limit(limit);
  return rows.map((row) => ({ id: String(row.odooId), slug: row.slug, updatedAt: row.updatedAt.toISOString() }));
}
