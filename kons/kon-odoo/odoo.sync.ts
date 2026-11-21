/**
 * Odoo — reading what changed into the mirror
 * ============================================================================
 *
 * Three ways in, one way through:
 *   · a change notice from Odoo names templates or variants   → `syncTemplates` for those;
 *   · the nightly schedule, or a person, starts a full walk    → a page of templates per job;
 *   · every path ends in `syncTemplates`, which reads from Odoo, writes the mirror, and says
 *     what changed (events for other kons, a purge notice for the site).
 *
 * A full walk is a chain of short jobs, not one long one: a job runs inside one transaction,
 * and a transaction held open across a whole catalog would block the rows it has touched and
 * lose everything on a single failed call.
 */

import { queue } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import type { OdooClient } from "./odoo.client";
import {
  applyCategories,
  applyPlans,
  m2oId,
  planProduct,
  retireProducts,
  type AttributeValueRecord,
  type CategoryRecord,
  type ProductChange,
  type TemplateRecord,
  type VariantRecord,
} from "./odoo.mirror";
import { recomputeStock } from "./odoo.holds";
import { odooCategories, odooProducts, odooSettings, odooSyncRuns, odooVariants, type OdooSyncRun } from "./odoo.schema";
import { capabilitiesOf, dbOf, loadSettings, QUEUES } from "./odoo.state";

/** Templates read from Odoo in one call. Their variants come in a second one. */
export const BATCH = 100;

/** Reads never hide archived records: the mirror has to learn that something was archived. */
const ALL = { active_test: false };

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface SyncResult {
  changes: ProductChange[];
  products: number;
  variants: number;
}

/** Tells the rest of the system what changed: events now, and the site's cache through the queue. */
export async function announce(ctx: KonContext, changes: ProductChange[], purgeUrl: string | null): Promise<void> {
  if (changes.length === 0) return;
  ctx.events.emit("odoo:product.changed", { products: changes });
  const priced = changes.filter((change) => change.kinds.includes("price"));
  if (priced.length > 0) ctx.events.emit("odoo:price.changed", { products: priced });
  const stocked = changes.filter((change) => change.kinds.includes("stock") || change.kinds.includes("retired"));
  if (stocked.length > 0) ctx.events.emit("odoo:stock.changed", { products: stocked });

  // A product that is new, or whose record was written, may have a new picture. Fetching it is
  // a large read from Odoo, so it has its own job and never slows the catalog down.
  for (const change of changes) {
    if (change.kinds.includes("created") || change.kinds.includes("product")) {
      await queue.dispatch(QUEUES.sync, "image", { odooId: change.odooId }, { attempts: 4 });
    }
  }

  if (purgeUrl) {
    await queue.dispatch(QUEUES.push, "purge", { ids: changes.map((change) => change.odooId) }, { attempts: 5 });
  }
}

/** The file type of an image, from its first bytes. Odoo answers the bytes, not the type. */
function imageType(bytes: Buffer): { mime: string; extension: string } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", extension: "webp" };
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) {
    return { mime: "image/gif", extension: "gif" };
  }
  // Anything else (an SVG, a file that is not an image) is not served from here.
  return null;
}

/**
 * Copies a product's picture from Odoo into this Kitsuden's storage, so the site serves it
 * without a request to Odoo and without Odoo's key. A product with no picture, or one in a
 * format not listed above, ends with none here.
 */
export async function syncImage(ctx: KonContext, client: OdooClient, odooId: number): Promise<void> {
  const db = dbOf(ctx);
  const [product] = await db
    .select({ id: odooProducts.id, imageKey: odooProducts.imageKey })
    .from(odooProducts)
    .where(eq(odooProducts.odooId, odooId))
    .limit(1);
  if (!product) return;

  const [record] = await client.read<{ id: number; image_1024?: string | false }>("product.template", [odooId], [
    "image_1024",
  ]);
  const bytes = typeof record?.image_1024 === "string" ? Buffer.from(record.image_1024, "base64") : null;
  const type = bytes ? imageType(bytes) : null;

  let key: string | null = null;
  if (bytes && type) {
    key = `odoo/products/${odooId}.${type.extension}`;
    await ctx.storage.put(key, bytes, type.mime);
  }
  if (product.imageKey && product.imageKey !== key) await ctx.storage.delete(product.imageKey);
  if (product.imageKey !== key) {
    await db.update(odooProducts).set({ imageKey: key }).where(eq(odooProducts.id, product.id));
  }
}

/**
 * Reads these templates, with their variants, and puts the mirror in step. A template Odoo does
 * not answer for is gone there: it is hidden here.
 */
export async function syncTemplates(
  ctx: KonContext,
  client: OdooClient,
  templateIds: number[],
  options: { announce?: boolean } = {}
): Promise<SyncResult> {
  const ids = [...new Set(templateIds.filter((id) => Number.isInteger(id) && id > 0))];
  const result: SyncResult = { changes: [], products: 0, variants: 0 };
  if (ids.length === 0) return result;

  const db = dbOf(ctx);
  const settings = await loadSettings(db);
  const { capabilities, currency } = await capabilitiesOf(db, client, { settings });
  const templateFields = capabilities.fields["product.template"] ?? ["name"];
  const variantFields = capabilities.fields["product.product"] ?? ["product_tmpl_id"];

  for (const batch of chunks(ids, BATCH)) {
    const templates = await client.searchRead<TemplateRecord>("product.template", {
      domain: [["id", "in", batch]],
      fields: templateFields,
      context: ALL,
    });
    const variants = await client.searchRead<VariantRecord>("product.product", {
      domain: [["product_tmpl_id", "in", batch]],
      fields: variantFields,
      context: ALL,
    });

    const valueIds = [...new Set(variants.flatMap((variant) => variant.product_template_attribute_value_ids ?? []))];
    const values = new Map<number, AttributeValueRecord>();
    for (const part of chunks(valueIds, 500)) {
      const records = await client.read<AttributeValueRecord>("product.template.attribute.value", part, [
        "attribute_id",
        "name",
      ]);
      for (const record of records) values.set(record.id, record);
    }

    const byTemplate = new Map<number, VariantRecord[]>();
    for (const variant of variants) {
      const template = m2oId(variant.product_tmpl_id);
      if (template === null) continue;
      const list = byTemplate.get(template) ?? [];
      list.push(variant);
      byTemplate.set(template, list);
    }

    const plans = templates.map((template) =>
      planProduct(template, byTemplate.get(template.id) ?? [], values, capabilities, currency)
    );
    const applied = await applyPlans(db, plans);
    result.changes.push(...applied);
    // Odoo's free quantity just changed; what can be sold is that less what is held here.
    await recomputeStock(db, applied.map((change) => change.productId));

    const answered = new Set(templates.map((template) => template.id));
    result.changes.push(...(await retireProducts(db, batch.filter((id) => !answered.has(id)))));
    result.products += templates.length;
    result.variants += variants.length;
  }

  // A product in a category the mirror has never seen (the first sync, or a category made
  // since): the category tree is small, so it is read whole.
  const touched = result.changes.map((change) => change.productId);
  if (touched.length > 0 && capabilities.fields["product.category"]) {
    const [missing] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(odooProducts)
      .where(
        and(
          inArray(odooProducts.id, touched),
          sql`${odooProducts.categoryOdooId} IS NOT NULL`,
          sql`NOT EXISTS (SELECT 1 FROM ${odooCategories} WHERE ${odooCategories.odooId} = ${odooProducts.categoryOdooId})`
        )
      );
    if ((missing?.count ?? 0) > 0) await syncCategories(ctx, client);
  }

  if (options.announce !== false) await announce(ctx, result.changes, settings.purgeUrl);
  return result;
}

/**
 * The templates these variants belong to. The mirror knows most of them; Odoo is asked only for
 * the ones it has never seen (a variant created since the last sync).
 */
export async function templatesOfVariants(ctx: KonContext, client: OdooClient, variantIds: number[]): Promise<number[]> {
  const ids = [...new Set(variantIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];
  const db = dbOf(ctx);
  const known = await db
    .select({ variant: odooVariants.odooId, template: odooProducts.odooId })
    .from(odooVariants)
    .innerJoin(odooProducts, eq(odooProducts.id, odooVariants.productId))
    .where(inArray(odooVariants.odooId, ids));
  const templates = new Set(known.map((row) => row.template));
  const seen = new Set(known.map((row) => row.variant));
  const unknown = ids.filter((id) => !seen.has(id));
  for (const part of chunks(unknown, 500)) {
    const records = await client.searchRead<VariantRecord>("product.product", {
      domain: [["id", "in", part]],
      fields: ["product_tmpl_id"],
      context: ALL,
    });
    for (const record of records) {
      const template = m2oId(record.product_tmpl_id);
      if (template !== null) templates.add(template);
    }
  }
  return [...templates];
}

export async function syncCategories(ctx: KonContext, client: OdooClient): Promise<number> {
  const db = dbOf(ctx);
  const { capabilities } = await capabilitiesOf(db, client);
  const fields = capabilities.fields["product.category"];
  if (!fields) return 0;
  const records = await client.searchRead<CategoryRecord>("product.category", { fields, order: "id" });
  return applyCategories(db, records);
}

// ── Full walk ─────────────────────────────────────────────────────────────────

/** A run that has not moved for this long is taken for dead, and another may start. */
const STALE_RUN_MS = 6 * 60 * 60 * 1000;

/** Starts a full walk, or answers the one already running. */
export async function startFullSync(ctx: KonContext): Promise<{ run: OdooSyncRun; started: boolean }> {
  const db = dbOf(ctx);
  const [running] = await db
    .select()
    .from(odooSyncRuns)
    .where(eq(odooSyncRuns.status, "running"))
    .orderBy(desc(odooSyncRuns.startedAt))
    .limit(1);
  if (running && Date.now() - running.startedAt.getTime() < STALE_RUN_MS) {
    return { run: running, started: false };
  }
  if (running) {
    await db
      .update(odooSyncRuns)
      .set({ status: "failed", error: "Stopped before it finished.", finishedAt: new Date() })
      .where(eq(odooSyncRuns.status, "running"));
  }
  // The start time comes from this process's clock, the same one that stamps every row the
  // walk touches: the last page compares the two.
  const [run] = await db.insert(odooSyncRuns).values({ startedAt: new Date() }).returning();
  await queue.dispatch(QUEUES.sync, "full", { runId: run.id, after: 0 }, { dedupeKey: `full:${run.id}:0`, attempts: 5 });
  return { run, started: true };
}

/** One page of a full walk. Queues the next one, or closes the run. */
export async function fullSyncPage(
  ctx: KonContext,
  client: OdooClient,
  job: { runId: string; after: number }
): Promise<void> {
  const db = dbOf(ctx);
  const [run] = await db.select().from(odooSyncRuns).where(eq(odooSyncRuns.id, job.runId)).limit(1);
  // A page of a run that was closed, or a page already done (the queue delivers at least once).
  if (!run || run.status !== "running" || run.cursor > job.after) return;

  if (job.after === 0) {
    // The first page also asks Odoo again what it has installed: a module added since the last
    // walk shows up here, not at the next restart.
    await capabilitiesOf(db, client, { refresh: true });
    await syncCategories(ctx, client);
  }

  const page = await client.searchRead<{ id: number }>("product.template", {
    domain: [["id", ">", job.after]],
    fields: ["id"],
    limit: BATCH,
    order: "id",
    context: ALL,
  });
  const ids = page.map((row) => row.id);
  const result = await syncTemplates(ctx, client, ids);
  const cursor = ids.length > 0 ? ids[ids.length - 1] : job.after;

  if (ids.length === BATCH) {
    await db
      .update(odooSyncRuns)
      .set({ cursor, products: run.products + result.products, variants: run.variants + result.variants })
      .where(eq(odooSyncRuns.id, run.id));
    await queue.dispatch(
      QUEUES.sync,
      "full",
      { runId: run.id, after: cursor },
      { dedupeKey: `full:${run.id}:${cursor}`, attempts: 5 }
    );
    return;
  }

  // Last page. Whatever the walk did not touch is no longer in Odoo. A minute of margin: pages
  // may run on another replica whose clock is not this one's, and hiding a product that exists
  // is worse than hiding a deleted one a night late.
  const before = new Date(run.startedAt.getTime() - 60_000);
  const untouched = await db
    .select({ odooId: odooProducts.odooId })
    .from(odooProducts)
    .where(and(eq(odooProducts.active, true), lt(odooProducts.syncedAt, before)));
  const retired = await retireProducts(
    db,
    untouched.map((row) => row.odooId)
  );
  const settings = await loadSettings(db);
  await announce(ctx, retired, settings.purgeUrl);

  const totals = {
    products: run.products + result.products,
    variants: run.variants + result.variants,
    retired: retired.length,
  };
  const now = new Date();
  await db
    .update(odooSyncRuns)
    .set({ ...totals, cursor, status: "done", finishedAt: now })
    .where(eq(odooSyncRuns.id, run.id));
  await db.update(odooSettings).set({ lastFullSyncAt: now, updatedAt: now }).where(eq(odooSettings.id, 1));
  ctx.events.emit("odoo:sync.completed", { runId: run.id, ...totals });
}

/** Closes a run that cannot go on, with Odoo's own words for why. */
export async function failRun(ctx: KonContext, runId: string, error: string): Promise<void> {
  await dbOf(ctx)
    .update(odooSyncRuns)
    .set({ status: "failed", error: error.slice(0, 2000), finishedAt: new Date() })
    .where(and(eq(odooSyncRuns.id, runId), eq(odooSyncRuns.status, "running")));
}

/** Counts for the status page. */
export async function mirrorCounts(ctx: KonContext): Promise<{ products: number; published: number; variants: number }> {
  const db = dbOf(ctx);
  const [products] = await db
    .select({
      total: sql<number>`count(*)::int`,
      published: sql<number>`count(*) FILTER (WHERE ${odooProducts.published} AND ${odooProducts.active})::int`,
    })
    .from(odooProducts);
  const [variants] = await db.select({ total: sql<number>`count(*)::int` }).from(odooVariants);
  return { products: products?.total ?? 0, published: products?.published ?? 0, variants: variants?.total ?? 0 };
}
