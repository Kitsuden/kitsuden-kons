/**
 * @kitsuden/kon-tierlist
 * ============================================================================
 *
 * Tier lists with TWO surfaces on a single engine:
 *
 *   · **Editorial template** — the site publishes the patch's one, compares it
 *     with the previous one and the diff is publishable content.
 *   · **Personal list** (TierMaker) — a reader starts from a template, makes
 *     their own and shares it with a code.
 *
 * They are not redundant: the owner, the lifecycle and what they are for all change. What
 * they share —rows, distribution, validation, codes— is the engine, and that is why
 * it is written only once.
 */

import {
  can,
  defineKonSdk,
  defineOperation,
  repo,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import { datasetImageUrl, readDatasetCatalog, type KonContext } from "@kitsuden/shared";
import type { Hono } from "hono";
import { z } from "zod";

import "./tierlist.policy.js";
import {
  addItems,
  applyPlacement,
  decodeTierList,
  diffTierLists,
  encodeTierList,
  place,
  removeItem,
  syncWithCatalog,
  tierView,
  validateTierList,
  DEFAULT_TIERS,
  TierListError,
  type TierItem,
  type TierItemMeta,
  type TierList,
} from "./tierlist.engine.js";
import { tierLists } from "./tierlist.schema.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./tierlist.engine.js";
export * from "./tierlist.schema.js";

const TierSchema = z.object({
  id: z.string().min(1).max(20),
  label: z.string().min(1).max(20),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#888888"),
});

const ItemSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  // http(s) and nothing else: `z.string().url()` accepts `javascript:`, and this ends up in a `src`
  imageUrl: z
    .string()
    .url()
    .refine((v) => /^https?:\/\//i.test(v), { message: "The image must be http(s)" })
    .nullable()
    .optional(),
  sourceRef: z.string().max(200).nullable().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The catalog sent by hand to `/sync`. It used to go unvalidated —neither shape, nor
 * size, nor the `http(s)` of the image that `ItemSchema` does require—, so
 * through there entered the public template what `PUT /templates` rejects.
 */
const SyncBody = z.object({
  catalog: z.array(ItemSchema).max(1000).optional(),
  datasetId: z.string().min(1).max(200).optional(),
  confirm: z.boolean().optional(),
});

function extractMetaFromDataset(data: Record<string, unknown>): TierItemMeta | undefined {
  const meta: TierItemMeta = {};
  let hasMeta = false;

  const num = (v: unknown): number | undefined => {
    if (typeof v === "number" && !isNaN(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
    return undefined;
  };

  const share = num(data.share);
  if (share !== undefined) {
    meta.share = share;
    hasMeta = true;
  }

  const winRate = num(data.winrate ?? data.winRate);
  if (winRate !== undefined) {
    meta.winRate = winRate;
    hasMeta = true;
  }

  const rank = num(data.rank);
  if (rank !== undefined) {
    meta.rank = rank;
    hasMeta = true;
  }

  const delta = num(data.delta);
  if (delta !== undefined) {
    meta.delta = delta;
    hasMeta = true;
  }

  const score = num(data.score ?? data.tops);
  if (score !== undefined) {
    meta.score = score;
    hasMeta = true;
  }

  const source = data.winrate_source ?? data.source;
  if (typeof source === "string" && source.trim() !== "") {
    meta.source = source;
    hasMeta = true;
  }

  const matches = num(data.winrate_matches ?? data.matches);
  if (matches !== undefined) {
    meta.matches = matches;
    hasMeta = true;
  }

  const featuredDeckId = data.deck_id ?? data.archetype_id;
  if (typeof featuredDeckId === "string" && featuredDeckId.trim() !== "") {
    meta.featuredDeckId = featuredDeckId;
    hasMeta = true;
  }

  if (Array.isArray(data.composition) && data.composition.length > 0) {
    meta.composition = data.composition as TierItemMeta["composition"];
    hasMeta = true;
  }

  return hasMeta ? meta : undefined;
}

/**
 * Turns a dataset into a tier list's catalog.
 * ============================================================================
 *
 * `catalogDatasetId` had been in the table from the start, with this comment
 * in the schema:
 *
 *     «It is what makes a new character appear unranked instead of being
 *      forgotten — the classic failure of hand-maintained tier lists.»
 *
 * But the column was only SAVED. Nobody read it, so `/sync` required that
 * the catalog be passed already assembled and there was no way to build a tier list of
 * a hundred characters without typing them one by one.
 *
 * READING the dataset —including the `checkReadAccess` that prevents this kon
 * from being a back door to other people's datasets— lives in `@kitsuden/shared`, because
 * the card simulator and the character builder do exactly the same.
 * What stays here is only what is specific to a tier list: what a chip is.
 */
interface ResolvedCatalog {
  items: TierItem[];
  /** Which field was used for the image, or `null`. It goes in the response: if everything
   *  comes out without a picture, this says why without having to read the code. */
  imageField: string | null;
  dataset: { id: string; name: string };
}

async function catalogFromDataset(
  ctx: KonContext,
  datasetId: string,
  user: AuthzUser | null
): Promise<ResolvedCatalog | null> {
  const catalog = await readDatasetCatalog(ctx.db.instance, datasetId, user as never);
  if (!catalog) return null;

  const items: TierItem[] = catalog.entries.map((e) => {
    const meta = extractMetaFromDataset(e.data);
    return {
      id: e.id,
      // The LABEL is `data_entries.title`, which is `NOT NULL`: it is always there.
      // Guessing from the column name is where «Agregar All Gam» came from.
      label: e.title,
      imageUrl: catalog.imageField ? datasetImageUrl(e.data[catalog.imageField]) : null,
      // `sourceRef` is what ties the chip to its dataset row: it is what
      // lets re-syncing recognize what was already placed.
      sourceRef: e.id,
      ...(meta ? { meta } : {}),
    };
  });

  return { items, imageField: catalog.imageField, dataset: catalog.dataset };
}

const UpsertTemplate = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(160),
  version: z.string().max(20).nullable().optional(),
  tiers: z.array(TierSchema).min(1).max(12).optional(),
  items: z.array(ItemSchema).max(1000).optional(),
  placement: z.record(z.string(), z.string()).optional(),
  catalogDatasetId: z.string().nullable().optional(),
  /**
   * «Ordered by the team»: the content loader does not overwrite it
   * while it is true. Administration/editing only (the same barrier as the
   * rest of the PUT): if any session could change it, the editorial
   * override would last as long as it takes someone to uncheck it without knowing.
   */
  manual: z.boolean().optional(),
});

const PlaceItem = z.object({
  itemId: z.string().min(1),
  /** `null` returns the element to the unranked pool. */
  tierId: z.string().min(1).nullable(),
});

const AddItems = z.object({
  items: z.array(ItemSchema).min(1).max(200),
});

const ForkTemplate = z.object({
  title: z.string().min(1).max(160).optional(),
  /** Initial distribution, or the code of another personal list. */
  placement: z.record(z.string(), z.string()).optional(),
  code: z.string().max(20_000).optional(),
});

// ── Outputs (OpenAPI and MCP) ────────────────────────────────────────────────
//
// Loose on purpose (`passthrough`): the chips are also written by the
// content loader and the panel, and an extra field is not an error.

const TierOut = z.object({ id: z.string(), label: z.string(), color: z.string() }).passthrough();
const ItemOut = z
  .object({ id: z.string(), label: z.string(), imageUrl: z.string().nullable().optional() })
  .passthrough();

const TierListOut = z
  .object({
    id: z.string(),
    kind: z.string().describe("template (editorial) | personal (a reader's fork)"),
    slug: z.string().nullable(),
    title: z.string(),
    tiers: z.array(TierOut),
    items: z.array(ItemOut),
    placement: z.record(z.string(), z.string()).describe("itemId → tierId; absent = unranked"),
    catalogDatasetId: z.string().nullable(),
    templateId: z.string().nullable(),
    version: z.string().nullable(),
    manual: z.boolean(),
    ownerId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const ViewOut = z.object({
  rows: z.array(z.object({ tier: TierOut, items: z.array(ItemOut) })),
  unranked: z.array(ItemOut),
});

const ChangeOut = z.object({
  item: ItemOut,
  from: TierOut.nullable(),
  to: TierOut.nullable(),
  delta: z.number().int().describe("Rows moved; negative = promoted (S is on top)"),
});

const ParamSlug = z.object({ slug: z.string().describe("Template slug") });
const ParamSlugItem = z.object({ slug: z.string(), itemId: z.string() });
const ParamDiff = z.object({
  slug: z.string().describe("Template slug (the newer version)"),
  otherId: z.string().describe("Id of the tier list to compare against (the older version)"),
});
const ParamId = z.object({ id: z.string().describe("Personal tier list id") });
const CodeParam = z.object({ code: z.string().describe("Share code of a personal tier list") });

/**
 * `PUT /templates` responds 201 on create and 200 on rewrite. `otherStatuses`
 * publishes it; it goes in a constant (and not in the operation's literal) so
 * that it also compiles against a core older than that field.
 */
const PUBLISH_OUTPUT = {
  schema: z.object({ data: TierListOut }),
  otherStatuses: [201 as const],
  description: "Rewritten (200) or created (201)",
};

export const KON_ID = "kon-tierlist";

export function tierlistOperations(ctx: KonContext): AnyOperation[] {
  const db = ctx.db.instance;

  const asTierList = (row: typeof tierLists.$inferSelect): TierList => ({
    tiers: row.tiers,
    items: row.items,
    placement: row.placement,
  });

  const templateValue = async (slug: string) =>
    (await repo(tierLists, { db }).filter({ slug, kind: "template" }).all())[0];

  // Templates are read without a session: they live on public pages and are
  // embedded as a block. Writing them requires a session (`access: "session"`) and the
  // policy `tierlist`.
  return [
    // ── Editorial templates ──────────────────────────────────────────────────

    defineOperation({
      id: "list-templates",
      method: "GET",
      route: "/templates",
      summary: "List tier list templates",
      description:
        "Every editorial template (the site's published tier lists), most recently updated first: id, slug, title and version. Use the slug to read, place, sync or fork one.",
      access: "public",
      output: {
        schema: z.object({
          data: z.array(
            z.object({
              id: z.string(),
              slug: z.string().nullable(),
              title: z.string(),
              version: z.string().nullable(),
            })
          ),
        }),
      },
      handle: async () => {
        const rows = await repo(tierLists, { db })
          .filter({ kind: "template" })
          .orderBy("-updatedAt")
          .all();
        return {
          data: rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title, version: r.version })),
        };
      },
    }),

    defineOperation({
      id: "get-template",
      method: "GET",
      route: "/templates/:slug",
      summary: "Read a tier list template",
      description:
        "The template row (tiers, items, placement) plus `view`: the items already grouped by tier, in display order, with the unranked pool apart.",
      access: "public",
      input: { params: ParamSlug },
      output: { schema: z.object({ data: TierListOut, view: ViewOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { c }) => {
        const row = await templateValue(params.slug);
        if (!row) return c.json({ error: "Not found" }, 404);
        // It is returned ALREADY grouped: the viewer only paints rows, and grouping in each
        // client would be repeating in JS what is tested here.
        return { data: row, view: tierView(asTierList(row)) };
      },
    }),

    defineOperation({
      id: "publish-template",
      method: "PUT",
      route: "/templates",
      summary: "Create or rewrite a tier list template",
      description:
        "Upsert by slug: 201 when it creates the template, 200 when it rewrites it. Omitted tiers/items/placement keep the current ones (a new template starts with the S-D tiers). The whole list is validated before saving (422 with `issues`). Admin/editor, or an agent with tierlist:publish. To move one item use place, to add items use add-items: a full PUT overwrites whatever another editor changed meanwhile.",
      access: "session",
      permission: { policy: { resource: "tierlist", action: "publish", inHandler: true } },
      // Publishing rewrites in one go a game's public tier list.
      sensitive: true,
      input: { body: UpsertTemplate },
      output: PUBLISH_OUTPUT,
      errors: ["KITSUDEN_E_CONFLICT"],
      handle: async ({ body: data }, { c, can: canValue }) => {
        /**
         * A TEMPLATE is editorial: everyone sees it and it has no draft.
         *
         * `can(create)` lets any session through because it is the rule of
         * PERSONAL lists (forking is for each user); publishing is the
         * policy's `publish` action (admin/editor, or an agent with its scope). It is
         * checked after validating the body, as before the SDK.
         */
        if (!(await canValue({ id: "", kind: "template" }))) {
          return c.json(
            { error: "Only administration or editing can publish a tier list" },
            403
          );
        }

        const [existing] = await repo(tierLists, { db }).filter({ slug: data.slug }).all();
        // A slug is only carried by templates, but if a PERSONAL row had
        // one (by hand, via SQL), rewriting it here would turn it into a public
        // template with its owner's content.
        if (existing && existing.kind !== "template") {
          return c.json({ error: "That slug does not belong to a template" }, 409);
        }

        const candidate: TierList = {
          tiers: data.tiers ?? existing?.tiers ?? DEFAULT_TIERS,
          items: (data.items ?? existing?.items ?? []) as TierItem[],
          placement: data.placement ?? existing?.placement ?? {},
        };

        // Validate BEFORE saving: a list with an orphaned distribution makes
        // elements vanish from the screen without saying why.
        const errors = validateTierList(candidate);
        if (errors.length) return c.json({ error: "Invalid tier list", issues: errors }, 422);

        const values = {
          kind: "template",
          slug: data.slug,
          title: data.title,
          version: data.version ?? null,
          catalogDatasetId: data.catalogDatasetId ?? existing?.catalogDatasetId ?? null,
          manual: data.manual ?? existing?.manual ?? false,
          ...candidate,
        };

        const row = existing
          ? (
              await repo(tierLists, { db })
                .filter({ id: existing.id })
                .update({ ...values, updatedAt: new Date() })
            )[0]
          : await repo(tierLists, { db }).create(values);

        return c.json({ data: row }, existing ? 200 : 201);
      },
    }),

    /**
     * Places an element in the template. It is the editor's operation.
     *
     * One route per move and not a PUT of the whole list: two editors
     * working at once would overwrite each other's entire work with the PUT, and here they only
     * compete for the element both moved.
     */
    defineOperation({
      id: "place-in-template",
      method: "POST",
      route: "/templates/:slug/place",
      summary: "Place an item in a template tier",
      description:
        "Moves one item of the template to a tier (`tierId: null` sends it back to the unranked pool) and returns the updated template. 409 if the item or the tier does not exist. Admin/editor, or an agent with tierlist:update.",
      access: "session",
      permission: { policy: { resource: "tierlist", action: "update", inHandler: true } },
      // Placing the same thing twice leaves the same result.
      idempotent: true,
      input: { params: ParamSlug, body: PlaceItem },
      output: { schema: z.object({ data: TierListOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async ({ params, body: bodyValue }, { c, authorize }) => {
        const row = await templateValue(params.slug);
        if (!row) return c.json({ error: "Not found" }, 404);
        await authorize(row);

        const { itemId, tierId } = bodyValue;
        try {
          const next = place(asTierList(row), itemId, tierId);
          const [updated] = await repo(tierLists, { db })
            .filter({ id: row.id })
            .update({ placement: next.placement, updatedAt: new Date() });
          return { data: updated };
        } catch (err) {
          const message = err instanceof TierListError ? err.message : "Invalid move";
          return c.json({ error: message }, 409);
        }
      },
    }),

    /**
     * Adds elements by hand to a template.
     *
     * ── THE DEAD END THIS CLOSES ───────────────────────────────────────────
     *
     * Until now, the ONLY way for a tier list to have chips was
     * to sync it with a dataset. A list created without a catalog —the normal case if
     * what you want is to rank ten things and be done— stayed with the board
     * empty forever, and the form's footer promised an «on import» that
     * existed nowhere.
     *
     * `PUT /templates` could do it by sending `items` in full, but that is a
     * save of the whole list: two editors overwrite all the work, not
     * just what both touched. That is why adding is its own operation, just like
     * placing.
     */
    defineOperation({
      id: "add-items",
      method: "POST",
      route: "/templates/:slug/items",
      summary: "Add items to a template",
      description:
        "Appends hand-written items (1-200) to the template, unranked. The resulting list is validated (422 with `issues`, e.g. a repeated id). Items without `sourceRef` count as hand-added: a later sync asks for `confirm` before dropping them.",
      access: "session",
      permission: { policy: { resource: "tierlist", action: "update", inHandler: true } },
      input: { params: ParamSlug, body: AddItems },
      output: { schema: z.object({ data: TierListOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params, body: bodyValue }, { c, authorize }) => {
        const row = await templateValue(params.slug);
        if (!row) return c.json({ error: "Not found" }, 404);
        await authorize(row);

        const next = addItems(asTierList(row), bodyValue.items as TierItem[]);

        // What is going to be saved is validated, not what arrived: a single element
        // can be fine and still leave the list wrong.
        const errors = validateTierList(next);
        if (errors.length) return c.json({ error: "Invalid tier list", issues: errors }, 422);

        const [updated] = await repo(tierLists, { db })
          .filter({ id: row.id })
          .update({ items: next.items, updatedAt: new Date() });

        return { data: updated };
      },
    }),

    /** Removes an element and its placement. */
    defineOperation({
      id: "remove-item",
      method: "DELETE",
      route: "/templates/:slug/items/:itemId",
      summary: "Remove an item from a template",
      description:
        "Removes the item and its placement from the template and returns the updated template. 404 if the template or the item does not exist.",
      access: "session",
      permission: { policy: { resource: "tierlist", action: "update", inHandler: true } },
      input: { params: ParamSlugItem },
      output: { schema: z.object({ data: TierListOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { c, authorize }) => {
        const row = await templateValue(params.slug);
        if (!row) return c.json({ error: "Not found" }, 404);
        await authorize(row);

        try {
          const next = removeItem(asTierList(row), params.itemId);
          const [updated] = await repo(tierLists, { db })
            .filter({ id: row.id })
            .update({ items: next.items, placement: next.placement, updatedAt: new Date() });
          return { data: updated };
        } catch (err) {
          const message = err instanceof TierListError ? err.message : "Could not remove";
          return c.json({ error: message }, 404);
        }
      },
    }),

    /**
     * Syncs the catalog from its dataset.
     *
     * New items enter **unranked** and retired ones leave with their placement. Existing
     * placements are NOT touched: re-syncing after a patch cannot
     * reorder the editor's work.
     */
    defineOperation({
      id: "sync-catalog",
      method: "POST",
      route: "/templates/:slug/sync",
      summary: "Sync a template with its catalog",
      description:
        "Makes the template's items equal to a catalog: `catalog` (items in the body), else `datasetId` (sync against that dataset and pin it), else the dataset already pinned (call with no body). New items enter unranked, retired ones leave with their placement, existing placements are kept. If hand-added items would be lost it answers 409 with `lost`: repeat with `confirm: true`. Returns the template, the unranked count, the catalog size (`inCatalog`) and `origin` (dataset and image field used).",
      access: "session",
      permission: { policy: { resource: "tierlist", action: "update", inHandler: true } },
      // Leaves the list equal to the catalog: whatever is not in it, goes.
      sensitive: true,
      // The optional body and its 422 `{ error: "Invalid catalog", issues }`
      // predate the SDK: the handler still resolves them.
      input: { params: ParamSlug, body: SyncBody.optional(), validatesHandler: true },
      output: {
        schema: z.object({
          data: TierListOut,
          unranked: z.number().int(),
          inCatalog: z.number().int(),
          origin: z
            .object({ dataset: z.string(), imageField: z.string().nullable() })
            .nullable(),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async ({ params }, { c, authorize, user: userValue }) => {
        const row = await templateValue(params.slug);
        if (!row) return c.json({ error: "Not found" }, 404);
        await authorize(row);

        // `catalog`: the already assembled elements. `datasetId`: syncs against that
        // dataset and pins it. `confirm`: accepts losing what was added by hand.
        const parsed = SyncBody.safeParse(await c.req.json().catch(() => ({})));
        if (!parsed.success) {
          return c.json({ error: "Invalid catalog", issues: parsed.error.issues }, 422);
        }
        const body = parsed.data;

        /**
         * ── WHERE THE CATALOG COMES FROM ───────────────────────────────────────
         *
         * Three ways, in this order:
         *
         *   1. `catalog` in the body — whoever already has it assembled.
         *   2. `datasetId` in the body — «sync with THIS dataset», and it stays
         *      pinned in the template for next time.
         *   3. The `catalogDatasetId` the template already had.
         *
         * Before, only the first existed, and that is why building a tier list of a hundred
         * characters forced typing them one by one: the column that said which
         * dataset they came from was saved and nobody read it.
         */
        const datasetId = body.datasetId ?? row.catalogDatasetId ?? null;

        let catalog: TierItem[];
        let origin: { dataset: string; imageField: string | null } | null = null;

        if (Array.isArray(body.catalog)) {
          catalog = body.catalog as TierItem[];
        } else if (datasetId) {
          const resolved = await catalogFromDataset(ctx, datasetId, userValue as AuthzUser | null);
          if (!resolved) {
            // 404 and not 403: if it cannot be read, for this template that dataset does not
            // exist. Distinguishing it would confirm which ones exist.
            return c.json({ error: "The dataset does not exist or cannot be read" }, 404);
          }
          catalog = resolved.items;
          origin = { dataset: resolved.dataset.name, imageField: resolved.imageField };
        } else {
          return c.json(
            {
              error: "There is nowhere to get the catalog from",
              message:
                "Send `catalog` with the items, or `datasetId` to sync " +
                "with a dataset. If the template already has one pinned, it is enough to " +
                "call with no body.",
            },
            400
          );
        }

        /**
         * ── WHAT SYNCING TAKES WITH IT ─────────────────────────────────────────
         *
         * `syncWithCatalog` leaves the list EQUAL to the catalog: whatever is not in it
         * disappears, and with it its placement. For a list maintained from a
         * dataset that is exactly what is wanted — a character retired in
         * the patch must go.
         *
         * But an element ADDED BY HAND need not be in any
         * catalog, so the first time someone attaches a dataset to a
         * list that already had its own chips, it deletes them all without saying anything.
         * That is data loss disguised as synchronization.
         *
         * They are told apart by `sourceRef`: what came from a dataset carries it, what was
         * written by hand does not. If something of the latter is going to be lost, it stops and
         * says what — and whoever truly asked for it repeats with `confirm`.
         */
        const byHand = row.items
          .filter((i) => !i.sourceRef && !catalog.some((c2) => c2.id === i.id))
          .map((i) => i.label);

        if (byHand.length > 0 && body.confirm !== true) {
          return c.json(
            {
              error: "Syncing would delete hand-added items",
              message:
                `These ${byHand.length} are not in the catalog and would be lost along ` +
                `with their placement: ${byHand.slice(0, 10).join(", ")}` +
                (byHand.length > 10 ? "…" : "") +
                ". Repeat with `confirm: true` if that is what you want.",
              lost: byHand,
            },
            409
          );
        }

        const next = syncWithCatalog(asTierList(row), catalog);
        const [updated] = await repo(tierLists, { db })
          .filter({ id: row.id })
          .update({
            items: next.items,
            placement: next.placement,
            // If it was synced against a dataset, it is pinned: next time
            // it is enough to press the button.
            ...(datasetId ? { catalogDatasetId: datasetId } : {}),
            updatedAt: new Date(),
          });

        const unranked = tierView(next).unranked.length;

        /**
         * ── WHY THE CATALOG SIZE TRAVELS ─────────────────────────────────────────
         *
         * Syncing with an EMPTY dataset leaves the list with zero chips, which is
         * correct. The problem is how it reads: without this datum, the editor only knows
         * that nothing new came in and writes «Catalog up to date» — that is, «all good»
         * over an empty board.
         *
         * They are two different situations that looked identical: «everything was already
         * fetched» and «there is nothing to fetch there». The second sends you to look at the tier
         * list when the problem is in the dataset.
         */
        return { data: updated, unranked, inCatalog: catalog.length, origin };
      },
    }),

    /**
     * Compares two versions. **It is publishable content**: "tier list
     * update" is the recurring post of a guides site, and writing it by hand
     * comparing two images is where the errors creep in.
     */
    defineOperation({
      id: "compare-versions",
      method: "GET",
      route: "/templates/:slug/diff/:otherId",
      summary: "Diff a template against another version",
      description:
        "Compares the template `slug` (after) with the tier list `otherId` (before): promoted, demoted, added and removed items with their from/to tiers, plus the unchanged count. Ready to write a 'tier list update' post. A personal list you cannot see is a 404.",
      access: "optional",
      input: { params: ParamDiff },
      output: {
        schema: z.object({
          data: z.object({
            promoted: z.array(ChangeOut),
            demoted: z.array(ChangeOut),
            added: z.array(ChangeOut),
            removed: z.array(ChangeOut),
            unchanged: z.number().int(),
          }),
          from: z.object({ id: z.string(), version: z.string().nullable() }),
          to: z.object({ id: z.string(), version: z.string().nullable() }),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { c, user: userValue }) => {
        const current = await templateValue(params.slug);
        const previous = await repo(tierLists, { db }).find(params.otherId);
        if (!current || !previous) return c.json({ error: "Not found" }, 404);
        // `otherId` is any id: without this, comparing against someone else's
        // PERSONAL list returned its whole distribution, without a session. What you cannot
        // see does not exist (404, not 403).
        if (!(await can(userValue as AuthzUser | null, "view", previous, "tierlist"))) {
          return c.json({ error: "Not found" }, 404);
        }

        return {
          data: diffTierLists(asTierList(previous), asTierList(current)),
          from: { id: previous.id, version: previous.version },
          to: { id: current.id, version: current.version },
        };
      },
    }),

    // ── Personal lists ───────────────────────────────────────────────────────

    /**
     * Forks a template into a personal list.
     *
     * It copies the elements and rows, it does not reference them: if the site republishes
     * the next patch's template, the list someone built and shared
     * **must not change under their feet**.
     */
    defineOperation({
      id: "fork-template",
      method: "POST",
      route: "/templates/:slug/fork",
      summary: "Fork a template into a personal tier list",
      description:
        "Creates your own tier list from a template (a copy, not a reference: republishing the template does not change it), with an optional starting placement or the share `code` of another personal list (stale items are dropped). Returns the new list and its share code. Any signed-in person; an agent needs tierlist:create.",
      access: "session",
      permission: { policy: { resource: "tierlist", action: "create", inHandler: true } },
      input: { params: ParamSlug, body: ForkTemplate },
      output: { status: 201, schema: z.object({ data: TierListOut, code: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params, body: data }, { c, authorize, user: userValue }) => {
        await authorize({});

        const template = await templateValue(params.slug);
        if (!template) return c.json({ error: "Not found" }, 404);

        let placement = data.placement ?? {};
        if (data.code) {
          const decoded = decodeTierList(data.code);
          if (!decoded.ok) return c.json({ error: decoded.reason }, 400);
          placement = decoded.placement;
        }

        // It is cleaned against the template: a months-old code may bring
        // retired characters, and discarding them is better than failing.
        const list = applyPlacement(asTierList(template), placement);

        const row = await repo(tierLists, { db }).create({
          kind: "personal",
          slug: null,
          title: data.title ?? `${template.title} (my version)`,
          tiers: list.tiers,
          items: list.items,
          placement: list.placement,
          templateId: template.id,
          version: template.version,
          ownerId: userValue?.id ?? null,
        });

        return { data: row, code: encodeTierList(template.id, list) };
      },
    }),

    defineOperation({
      id: "place-in-my-list",
      method: "POST",
      route: "/mine/:id/place",
      summary: "Place an item in your personal tier list",
      description:
        "Moves one item of your personal list to a tier (`tierId: null` = unranked) and returns the list with its updated share code. Someone else's list is a 404.",
      access: "session",
      permission: { policy: { resource: "tierlist", action: "update", inHandler: true } },
      idempotent: true,
      input: { params: ParamId, body: PlaceItem },
      output: { schema: z.object({ data: TierListOut, code: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async ({ params, body: bodyValue }, { c, can: canValue }) => {
        const row = await repo(tierLists, { db }).find(params.id);
        if (!row || row.kind !== "personal") return c.json({ error: "Not found" }, 404);
        // Someone else's list does not exist for you (404, not 403).
        if (!(await canValue(row))) return c.json({ error: "Not found" }, 404);

        const { itemId, tierId } = bodyValue;

        try {
          const next = place(asTierList(row), itemId, tierId);
          const [updated] = await repo(tierLists, { db })
            .filter({ id: row.id })
            .update({ placement: next.placement, updatedAt: new Date() });

          return {
            data: updated,
            // The code is returned on every move: sharing is the final
            // action of a personal tier list, and having it ready saves a call.
            code: encodeTierList(row.templateId ?? row.id, next),
          };
        } catch (err) {
          const message = err instanceof TierListError ? err.message : "Invalid move";
          return c.json({ error: message }, 409);
        }
      },
    }),

    /** Opens a list from its shared code. Never 500. */
    defineOperation({
      id: "open-code",
      method: "GET",
      route: "/decode/:code",
      summary: "Open a shared tier list code",
      description:
        "Decodes a share code into the template it came from and the grouped view of that placement (stale items dropped). 400 if the code is unreadable, 404 if its template is gone or not visible to you.",
      access: "optional",
      input: { params: CodeParam },
      output: {
        schema: z.object({
          data: z.object({ template: z.object({ id: z.string(), title: z.string() }) }),
          view: ViewOut,
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { c, user: userValue }) => {
        const decoded = decodeTierList(params.code);
        if (!decoded.ok) return c.json({ error: decoded.reason }, 400);

        const template = await repo(tierLists, { db }).find(decoded.templateId);
        // A code carries whatever id its writer wants: if it points to someone else's
        // PERSONAL list, it is treated as nonexistent.
        if (!template || !(await can(userValue as AuthzUser | null, "view", template, "tierlist"))) {
          return c.json({ error: "The template for that code no longer exists" }, 404);
        }

        const list = applyPlacement(asTierList(template), decoded.placement);
        return {
          data: { template: { id: template.id, title: template.title } },
          view: tierView(list),
        };
      },
    }),
  ];
}

export function createKonTierlist(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, tierlistOperations(ctx), ctx);
}

export const kon = defineKonSdk({
  id: KON_ID,
  name: "TierList",
  version: manifest.version,
  description: "Editorial tier lists with diff between versions, and shareable personal lists",
  icon: "ListOrdered",
  mountPath: "/api/tierlist",
  operations: (ctx: KonContext) => tierlistOperations(ctx),

  /**
   * ── A SINGLE SOURCE OF TRUTH ─────────────────────────────────────────────
   *
   * What the panel shows comes from `kon.json`, which is what the admin
   * registry reads (and also the explorable-tables guard). Nobody reads
   * this block, and it said something else: two views with other ids (`lists`,`editor`),
   * the table in camelCase and the artifact with `./` in front.
   *
   * A duplicate nobody reads is not documentation: it is the version
   * consulted when debugging that sends you to look at the wrong file. It is left
   * pointing to the manifest.
   */
  tables: konTables,

  dependencies: { kons: [], core: ["auth"] },

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("🏆 TierList ready — editorial templates + personal lists");
    },
  },
});

export default kon;
