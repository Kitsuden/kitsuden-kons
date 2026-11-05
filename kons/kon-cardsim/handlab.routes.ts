/**
 * The hand generator: feed it a card dataset and it deals you hands — `/api/cardsim/hands/...`
 * ============================================================================
 *
 * It was a kon of its own (HandLab) and now lives inside CardSim, mounted at `/hands`. The routes
 * keep their old paths below `/hands`; the operation ids that would collide with CardSim's (or the
 * showcase's) carry the `hands-` prefix. The policies keep their names, `handlab` (datasets) and
 * `handlab-deck` (decks), and so do the tables (`handlab_datasets`, `handlab_cards`,
 * `handlab_decks`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SMALLER THAN A GAME, AND COMPATIBLE WITH ONE
 *
 * There are no zones, no turns, no sessions, no opponent. A dataset is cards
 * plus four rules —how many are drawn, how many fit, how many copies—, and with
 * that hands are dealt and consistency is computed.
 *
 * What is NOT duplicated is the engine: dealing, shuffling and counting are
 * cardsim's functions, fed with a minimal definition synthesized on the
 * fly (`handlab.definition.ts`): the hand generator for testing in a minute, a
 * cardsim game when you want to play the whole game.
 *
 * The short path is a single call: `POST /hands/datasets/import` creates the
 * dataset and uploads the cards at once, accepting the same JSON the scrapers
 * in `scripts/scrape-tcg/` spit out.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomBytes, randomInt } from "node:crypto";

import { repo, can, type AuthzUser, type AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq, ilike } from "drizzle-orm";
import { z } from "zod";

import { validateDeck, type CardCatalog } from "./cardsim.deck.js";
import { createRng, shuffle } from "./cardsim.engine.js";
import {
  dealHands,
  goldfishAsync,
  GoldfishError,
  type GoldfishQuery,
} from "./cardsim.goldfish.js";
import { definitionFor, validateRules, type DatasetRules } from "./handlab.definition.js";
import "./handlab.policy.js";
import { handlabCards, handlabDatasets, handlabDecks } from "./handlab.schema.js";
import { HANDS_ACCOUNT, Obj, Row, onTheDataset, registry } from "./operations.js";

/** Where the hand generator is mounted, below the kon's own routes. */
export const HANDS_PREFIX = "/hands";

// ── Input ────────────────────────────────────────────────────────────────────

const Rules = {
  handSize: z.number().int().min(1).max(60).default(7),
  deckMin: z.number().int().min(1).max(500).default(40),
  deckMax: z.number().int().min(1).max(500).default(60),
  maxCopies: z.number().int().min(1).max(99).default(4),
  copyLimits: z.record(z.string(), z.number().int().min(0).max(99)).optional(),
};

/**
 * A card image is rendered on everyone's site: only `https://`/`http://`
 * or an own path (`/media/...`). No `javascript:`, `data:` or
 * protocol-relative paths (`//otro.host`).
 */
export function safeImage(url: string): boolean {
  if (url.startsWith("/")) return !url.startsWith("//") && !url.includes("\\");
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Cap on a card's free-form `data`: it is what is served in every hand. */
const MAX_CARD_DATA = 8_000;

const CardBody = z.object({
  cardId: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  imageUrl: z.string().max(600).refine(safeImage, "Image URL not allowed").nullish(),
  data: z
    .record(z.string().max(60), z.unknown())
    .refine((d) => Object.keys(d).length <= 60, "Too many properties")
    .refine((d) => JSON.stringify(d).length <= MAX_CARD_DATA, "Card data too large")
    .optional(),
});

const CreateDataset = z.object({
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "The slug must be lowercase letters, numbers and hyphens"),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  source: z.string().max(300).optional(),
  ...Rules,
});

/** The short path: dataset and cards in one go. */
const ImportDataset = CreateDataset.extend({
  cards: z.array(CardBody).min(1).max(30_000),
});

const ImportCards = z.object({ cards: z.array(CardBody).min(1).max(30_000) });

const SaveDeck = z.object({
  datasetId: z.string().min(1),
  name: z.string().min(1).max(80).default("Deck"),
  cards: z.array(z.string().min(1)).min(1).max(500),
});

/** A saved deck or a loose one: the question is asked while it is being built. */
const DeckSource = {
  deckId: z.string().min(1).optional(),
  datasetId: z.string().min(1).optional(),
  cards: z.array(z.string().min(1)).max(500).optional(),
};

const DealBody = z
  .object({
    ...DeckSource,
    count: z.number().int().min(1).max(20).default(5),
    /** Continues the batch: it is the "give me another hand". */
    from: z.number().int().min(0).max(100_000).default(0),
    draws: z.number().int().min(0).max(20).default(0),
    seed: z.number().int().optional(),
  })
  .refine((b) => Boolean(b.deckId) || (Boolean(b.datasetId) && Boolean(b.cards)), {
    message: "`deckId`, or `datasetId` + `cards`, is required",
  });

const GoldfishFilter = z.object({
  property: z.string().min(1).max(60),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  in: z
    .array(z.union([z.string(), z.number(), z.boolean()]))
    .max(50)
    .optional(),
  lte: z.number().optional(),
  gte: z.number().optional(),
  truthy: z.boolean().optional(),
});

const GoldfishReq = z.object({
  label: z.string().min(1).max(60),
  filters: z.array(GoldfishFilter).min(1).max(8),
  count: z.number().int().min(0).max(60),
  atMost: z.boolean().optional(),
});

const GoldfishQuerySchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  turn: z.number().int().min(1).max(50).optional(),
  cards: z.number().int().min(1).max(200).optional(),
  require: z.array(GoldfishReq).min(1).max(8),
  disjoint: z.boolean().optional(),
});

const RunGoldfish = z
  .object({
    ...DeckSource,
    iterations: z.number().int().min(100).max(50_000).default(10_000),
    seed: z.number().int().optional(),
    onThePlay: z.boolean().default(true),
    drawsPerTurn: z.number().int().min(1).max(10).default(1),
    mulliganUnless: z.array(GoldfishReq).max(8).optional(),
    queries: z.array(GoldfishQuerySchema).min(1).max(12),
  })
  .refine((b) => Boolean(b.deckId) || (Boolean(b.datasetId) && Boolean(b.cards)), {
    message: "`deckId`, or `datasetId` + `cards`, is required",
  });

const ValidateBody = z
  .object(DeckSource)
  .refine((b) => Boolean(b.deckId) || (Boolean(b.datasetId) && Boolean(b.cards)), {
    message: "`deckId`, or `datasetId` + `cards`, is required",
  });

const RandomDeck = z.object({
  size: z.number().int().min(1).max(500).optional(),
  seed: z.number().int().optional(),
  /** Filters the pool to draw from: `{"type":"Pokemon"}`. */
  where: z.record(z.string(), z.string()).optional(),
});

// ── Outputs (OpenAPI and MCP) ────────────────────────────────────────────────
//
// Loose on purpose (`passthrough`): they are database rows and results of the
// cardsim engine, which grow field by field.

const ParamSlug = z.object({ slug: z.string().describe("Dataset slug") });

/** Search query: whatever is not `q`/`page`/`pageSize` filters by a `data` facet. */
const SearchCards = z
  .object({
    q: z.string().optional().describe("Text to look for in the card name"),
    page: z.string().optional().describe("Page number (1 by default)"),
    pageSize: z.string().optional().describe("Cards per page (60 by default, 200 at most)"),
  })
  .passthrough()
  .describe("Any other key filters by that property of the card data: ?type=Pokemon");

export function handlabOperations(ctx: KonContext): AnyOperation[] {
  const app = registry(HANDS_PREFIX);
  const db = ctx.db.instance;

  const datasets = () => repo(handlabDatasets, { db });
  const cards = () => repo(handlabCards, { db });
  const decks = () => repo(handlabDecks, { db });
  const asSystem = ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());

  const userOf = (c: { get: (k: string) => unknown }) =>
    (c.get("user") ?? null) as AuthzUser | null;

  /** Catalog per dataset, cached: a dataset is editorial data that almost never changes. */
  const catalogs = new Map<string, { at: number; catalog: CardCatalog }>();
  const CATALOG_TTL_MS = 60_000;

  async function loadCatalog(datasetId: string): Promise<CardCatalog> {
    const hit = catalogs.get(datasetId);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.catalog;
    const rows = await cards().filter({ datasetId }).all();
    const catalog: CardCatalog = Object.fromEntries(
      rows.map((r) => [r.cardId, { name: r.name, ...r.data }])
    );
    catalogs.set(datasetId, { at: Date.now(), catalog });
    return catalog;
  }

  const rulesOf = (ds: typeof handlabDatasets.$inferSelect): DatasetRules => ({
    slug: ds.slug,
    name: ds.name,
    handSize: ds.handSize,
    deckMin: ds.deckMin,
    deckMax: ds.deckMax,
    maxCopies: ds.maxCopies,
    copyLimits: ds.copyLimits,
  });

  /**
   * Resolves the deck of a request: a saved one or a loose one.
   *
   * A saved deck with an owner is opened only by its owner — testing a deck's
   * hands is seeing all of it, so `deckId` cannot be a crack for reading
   * someone else's deck.
   */
  async function resolve(
    body: { deckId?: string; datasetId?: string; cards?: string[] },
    user: AuthzUser | null
  ): Promise<
    | { dataset: typeof handlabDatasets.$inferSelect; deck: string[] }
    | { error: string; status: 403 | 404 }
  > {
    let datasetId = body.datasetId;
    let deck = body.cards;

    if (body.deckId) {
      const saved = await decks().find(body.deckId);
      // 404 also if it belongs to someone else: which decks exist is not confirmed.
      if (!saved || !(await can(user, "view", saved, "handlab-deck"))) {
        return { error: "That deck does not exist", status: 404 };
      }
      datasetId = saved.datasetId;
      deck = saved.cards;
    }

    const dataset = datasetId ? await datasets().find(datasetId) : null;
    if (!dataset) return { error: "That dataset does not exist", status: 404 };
    return { dataset, deck: deck as string[] };
  }

  // Looking and TESTING is public; writing requires a session and each route asks for it
  // (the `access` of each operation; before, `optionalAuth` for all of them).

  // ══ 1. Datasets ════════════════════════════════════════════════════════════

  /** What the public sees of a dataset: without `ownerId` (an account id). */
  const audience = ({ ownerId: _o, ...ds }: typeof handlabDatasets.$inferSelect) => ds;

  app.get(
    "/datasets",
    {
      id: "list-datasets",
      summary: "List card datasets",
      description:
        "Every card dataset (editorial catalogues) by name, with its deck rules (hand size, deck min/max, max copies) and card count. Public. Use the slug to read it, search its cards or deal hands.",
      access: "public",
      output: { schema: z.object({ data: z.array(Row) }) },
    },
    async (c) => {
      const rows = await datasets().orderBy("name").all();
      return c.json({ data: rows.map(audience) });
    }
  );

  app.get(
    "/datasets/:slug",
    {
      id: "get-dataset",
      summary: "Read a card dataset",
      description:
        "The dataset (rules and card count) plus `definition`: the minimal cardsim game definition synthesized from its rules. Public.",
      access: "public",
      input: { params: ParamSlug },
      output: { schema: z.object({ data: Row, definition: Obj }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const ds = await datasets()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!ds) return c.json({ error: "Not found" }, 404);
      return c.json({ data: audience(ds), definition: definitionFor(rulesOf(ds)) });
    }
  );

  /**
   * The short path: create the dataset and upload its cards in ONE call.
   *
   * It accepts as is the `cards.kitsuden.json` that the scrapers spit out, so
   * going from a dump to dealing hands is a `curl` with `-d @file`.
   */
  app.post(
    "/datasets/import",
    {
      id: "import-dataset",
      summary: "Create a dataset with its cards in one call",
      description:
        "Creates the dataset and uploads its cards (1-30000, the `cards.kitsuden.json` the scrapers emit) at once. Repeated card ids in the batch are collapsed and reported. 409 if the slug exists, 422 if the rules are inconsistent. Site staff (admin/editor), or an agent with handlab:create. Returns 201 with the dataset and the import summary.",
      access: "session",
      permission: onTheDataset("create"),
      // Publishes a whole catalog served to everyone at once.
      sensitive: true,
      input: { body: ImportDataset },
      output: { status: 201, schema: z.object({ data: Row, import: Obj }) },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, { body: bodyValue }, h) => {
      const user = userOf(c);
      // The policy is checked after validating the body, as before the SDK.
      if (!(await h.can({}))) return c.json({ error: "Forbidden" }, 403);
      const data = bodyValue as z.infer<typeof ImportDataset>;

      const issues = validateRules(data);
      if (issues.length) return c.json({ error: "Invalid rules", issues }, 422);
      if (await datasets().filter({ slug: data.slug }).first()) {
        return c.json({ error: `Dataset slug already exists: "${data.slug}"` }, 409);
      }

      const ds = await datasets().create({
        slug: data.slug,
        name: data.name,
        description: data.description ?? null,
        source: data.source ?? null,
        handSize: data.handSize,
        deckMin: data.deckMin,
        deckMax: data.deckMax,
        maxCopies: data.maxCopies,
        copyLimits: data.copyLimits ?? {},
        ownerId: user?.id ?? null,
      });

      const result = await upsertCards(ds.id, data.cards);
      await datasets().filter({ id: ds.id }).update({ cardCount: result.total });
      return c.json({ data: { ...ds, cardCount: result.total }, import: result }, 201);
    }
  );

  app.post(
    "/datasets",
    {
      id: "create-dataset",
      summary: "Create an empty card dataset",
      description:
        "Creates a dataset (slug, name, deck rules) without cards; upload them with upload-cards. 409 if the slug exists, 422 if the rules are inconsistent. Site staff (admin/editor), or an agent with handlab:create. To create it with its cards in one call use import-dataset.",
      access: "session",
      permission: onTheDataset("create"),
      input: { body: CreateDataset },
      output: { status: 201, schema: z.object({ data: Row }) },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, { body: bodyValue }, h) => {
      const user = userOf(c);
      // The policy is checked after validating the body, as before the SDK.
      if (!(await h.can({}))) return c.json({ error: "Forbidden" }, 403);
      const data = bodyValue as z.infer<typeof CreateDataset>;

      const issues = validateRules(data);
      if (issues.length) return c.json({ error: "Invalid rules", issues }, 422);
      if (await datasets().filter({ slug: data.slug }).first()) {
        return c.json({ error: `Dataset slug already exists: "${data.slug}"` }, 409);
      }

      const row = await datasets().create({
        slug: data.slug,
        name: data.name,
        description: data.description ?? null,
        source: data.source ?? null,
        handSize: data.handSize,
        deckMin: data.deckMin,
        deckMax: data.deckMax,
        maxCopies: data.maxCopies,
        copyLimits: data.copyLimits ?? {},
        ownerId: user?.id ?? null,
      });
      return c.json({ data: row }, 201);
    }
  );

  /**
   * Uploads or updates cards. It is an UPSERT by `(dataset, cardId)`:
   * re-importing a corrected dump updates instead of duplicating, which is what
   * makes it viable to re-scrape every time a set comes out.
   */
  async function upsertCards(datasetId: string, incoming: z.infer<typeof CardBody>[]) {
    // First the BATCH is collapsed by `cardId`: real catalogs repeat
    // ids, and two identical rows would blow up the unique index and with it
    // the whole import.
    const batch = new Map<string, typeof handlabCards.$inferInsert>();
    for (const card of incoming) {
      batch.set(card.cardId, {
        datasetId,
        cardId: card.cardId,
        name: card.name,
        imageUrl: card.imageUrl ?? null,
        data: card.data ?? {},
      });
    }

    const existing = new Map(
      (await cards().filter({ datasetId }).all()).map((r) => [r.cardId, r.id])
    );
    const newOnes: (typeof handlabCards.$inferInsert)[] = [];
    let updated = 0;
    for (const [cardId, values] of batch) {
      const id = existing.get(cardId);
      if (id) {
        await cards().filter({ id }).update(values);
        updated++;
      } else {
        newOnes.push(values);
      }
    }
    // In batches: a `createMany` of 30,000 rows blows past the limit of
    // parameter limit.
    for (let i = 0; i < newOnes.length; i += 500) {
      await cards().createMany(newOnes.slice(i, i + 500));
    }
    catalogs.delete(datasetId);

    return {
      created: newOnes.length,
      updated,
      total: existing.size + newOnes.length,
      // What was collapsed is reported: a silent "imported 3794 of 3796" is
      // discovered weeks later, when a card is missing.
      collapsed: incoming.length - batch.size,
    };
  }

  app.post(
    "/datasets/:slug/cards",
    {
      id: "upload-cards",
      summary: "Upload or update the cards of a dataset",
      description:
        "Upserts cards (1-30000) by (dataset, cardId): re-importing a corrected dump updates instead of duplicating. Returns 201 with created/updated/total/collapsed counts. Site staff (admin/editor), or an agent with handlab:update.",
      access: "session",
      permission: onTheDataset("update"),
      // Rewrites in bulk the catalog served to everyone.
      sensitive: true,
      // It is an upsert: repeating the same batch leaves the same cards.
      idempotent: true,
      input: { params: ParamSlug, body: ImportCards },
      output: { status: 201, schema: z.object({ data: Obj }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, { body: bodyValue }, h) => {
      const ds = await datasets()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!ds) return c.json({ error: "Not found" }, 404);
      if (!(await h.can(ds))) return c.json({ error: "Forbidden" }, 403);

      const { cards: incoming } = bodyValue as z.infer<typeof ImportCards>;
      const result = await upsertCards(ds.id, incoming);
      await datasets()
        .filter({ id: ds.id })
        .update({ cardCount: result.total, updatedAt: new Date() });
      return c.json({ data: result }, 201);
    }
  );

  /** Search: the name in SQL and the `data` facets in memory. */
  app.get(
    "/datasets/:slug/cards",
    {
      id: "hands-search-cards",
      summary: "Search the cards of a dataset",
      description:
        "Cards of the dataset ordered by card id, paginated (`meta`: total, page, pageSize, pages). `q` matches the name; any other query key filters by that property of the card data (`?type=Pokemon`). Public.",
      access: "public",
      input: { params: ParamSlug, query: SearchCards },
      output: {
        schema: z.object({
          data: z.array(Row),
          meta: z.object({
            total: z.number(),
            page: z.number(),
            pageSize: z.number(),
            pages: z.number(),
          }),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const ds = await datasets()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!ds) return c.json({ error: "Not found" }, 404);

      const q = c.req.query("q")?.slice(0, 100);
      const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
      const pageSize = Math.min(200, Number.parseInt(c.req.query("pageSize") ?? "60", 10) || 60);

      let rows = await cards()
        .where(
          q
            ? and(eq(handlabCards.datasetId, ds.id), ilike(handlabCards.name, `%${q}%`))!
            : eq(handlabCards.datasetId, ds.id)
        )
        .orderBy("cardId")
        .all();

      const reserved = new Set(["q", "page", "pageSize"]);
      for (const [key, value] of Object.entries(c.req.query()).filter(([k]) => !reserved.has(k))) {
        rows = rows.filter((row) => {
          const raw = row.data[key];
          return (Array.isArray(raw) ? raw : [raw]).some((v) => String(v) === value);
        });
      }

      const start = (page - 1) * pageSize;
      return c.json({
        data: rows.slice(start, start + pageSize),
        meta: { total: rows.length, page, pageSize, pages: Math.ceil(rows.length / pageSize) },
      });
    }
  );

  app.delete(
    "/datasets/:slug",
    {
      id: "delete-dataset",
      summary: "Delete a card dataset",
      description:
        "Deletes the dataset, its cards and every saved deck built on it (everyone's, not only yours). 204 with no body. Site staff (admin/editor), or an agent with handlab:delete.",
      access: "session",
      permission: onTheDataset("delete"),
      input: { params: ParamSlug },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, _input, h) => {
      const ds = await datasets()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!ds) return c.json({ error: "Not found" }, 404);
      if (!(await h.can(ds))) return c.json({ error: "Forbidden" }, 403);

      await cards().filter({ datasetId: ds.id }).delete();
      // Decks belong to EACH user and their RLS (`handlab_decks_owner_isolation`)
      // only lets the deleter see their own: with the request's connection,
      // other people's decks were left orphaned pointing to a dataset that
      // no longer exists (an earlier audit). The deletion is already authorized above
      // (`delete` of the policy): cleaning up what hangs from it runs as the system.
      await asSystem(() => decks().filter({ datasetId: ds.id }).delete());
      await datasets().filter({ id: ds.id }).delete();
      catalogs.delete(ds.id);
      return c.body(null, 204);
    }
  );

  // ══ 2. Decks ═══════════════════════════════════════════════════════════════

  app.get(
    "/decks",
    {
      id: "hands-list-my-decks",
      summary: "List my saved decks",
      description:
        "The decks saved by the caller, most recently updated first. Any signed-in account; an agent needs user:act or a handlab scope. Use a deck id with hands-deal-hands, hands-validate-deck or hands-simulate-goldfish.",
      access: "session",
      permission: HANDS_ACCOUNT,
      output: { schema: z.object({ data: z.array(Row) }) },
    },
    async (c) => {
      const user = userOf(c);
      const rows = await decks()
        .filter({ ownerId: user?.id ?? "" })
        .orderBy("-updatedAt")
        .all();
      return c.json({ data: rows });
    }
  );

  app.post(
    "/decks",
    {
      id: "hands-save-deck",
      summary: "Save a deck",
      description:
        "Saves a deck (list of card ids, one per copy) built on a dataset, owned by the caller and with a share id. The deck is validated against the dataset rules first (422 with `issues`). Any signed-in person; an agent needs handlab-deck:create. Returns 201 with the deck.",
      access: "session",
      permission: { policy: { resource: "handlab-deck", action: "create", inHandler: true } },
      input: { body: SaveDeck },
      output: { status: 201, schema: z.object({ data: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, { body: bodyValue }, h) => {
      const user = userOf(c);
      // The policy is checked after validating the body, as before the SDK.
      if (!(await h.can({}))) return c.json({ error: "Forbidden" }, 403);
      const data = bodyValue as z.infer<typeof SaveDeck>;
      const ds = await datasets().find(data.datasetId);
      if (!ds) return c.json({ error: "That dataset does not exist" }, 404);

      const issues = validateDeck(definitionFor(rulesOf(ds)), data.cards, await loadCatalog(ds.id));
      if (issues.length) return c.json({ error: "Invalid deck", issues }, 422);

      const row = await decks().create({
        datasetId: ds.id,
        name: data.name,
        cards: data.cards,
        ownerId: user?.id ?? null,
        shareId: randomBytes(6).toString("hex"),
      });
      return c.json({ data: row }, 201);
    }
  );

  /**
   * A legal deck drawn from the dataset, at random.
   *
   * It closes the loop of "I upload a dataset and want to see hands NOW":
   * without this you would have to build a deck by hand before being able to
   * look at anything. The seed comes back in the response, so the same deck can
   * be rebuilt.
   */
  app.post(
    "/datasets/:slug/random-deck",
    {
      id: "random-deck",
      summary: "Build a random legal deck from a dataset",
      description:
        "Draws a random deck from the dataset respecting its copy limits (`where` filters the pool by card properties). Returns the seed (same seed, same deck), the card ids and whether it is valid. Saves nothing. Public.",
      access: "public",
      readOnly: true,
      input: { params: ParamSlug, body: RandomDeck },
      output: { schema: z.object({ data: Obj }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, { body: bodyValue }) => {
      const ds = await datasets()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!ds) return c.json({ error: "Not found" }, 404);
      const body = bodyValue as z.infer<typeof RandomDeck>;

      let pool = await cards().filter({ datasetId: ds.id }).orderBy("cardId").all();
      for (const [key, value] of Object.entries(body.where ?? {})) {
        pool = pool.filter((row) => {
          const raw = row.data[key];
          return (Array.isArray(raw) ? raw : [raw]).some((v) => String(v) === value);
        });
      }
      if (!pool.length) return c.json({ error: "No candidate with that filter" }, 422);

      const size = Math.min(body.size ?? ds.deckMin, ds.deckMax);
      const seed = body.seed ?? randomInt(0, 2 ** 31);
      const rng = createRng(seed);
      const shuffled = shuffle(pool, rng);

      // Copies are dealt respecting the per-card cap: a generated deck that
      // was not legal would be useless, which is exactly what we want to avoid.
      const deck: string[] = [];
      for (let round = 0; deck.length < size; round++) {
        let added = false;
        for (const card of shuffled) {
          if (deck.length >= size) break;
          const limit = ds.copyLimits?.[card.cardId] ?? ds.maxCopies;
          if (round >= limit) continue;
          deck.push(card.cardId);
          added = true;
        }
        // Without enough cards to reach the size, it stops instead of
        // spinning forever.
        if (!added) break;
      }

      const issues = validateDeck(definitionFor(rulesOf(ds)), deck, await loadCatalog(ds.id));
      return c.json({
        data: { seed, size: deck.length, cards: deck, valid: issues.length === 0, issues },
      });
    }
  );

  // ══ 3. What this kon does ══════════════════════════════════════════════════

  app.post(
    "/validate",
    {
      id: "hands-validate-deck",
      summary: "Validate a deck against its dataset rules",
      description:
        "Checks a saved deck (`deckId`) or a loose one (`datasetId` + `cards`) against the dataset rules: `{ valid, issues }`. A saved deck only opens for its owner (404 otherwise). Public.",
      access: "optional",
      readOnly: true,
      input: { body: ValidateBody },
      output: { schema: z.object({ data: Obj }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, { body: bodyValue }) => {
      const body = bodyValue as z.infer<typeof ValidateBody>;
      const r = await resolve(body, userOf(c));
      if ("error" in r) return c.json({ error: r.error }, r.status);

      const issues = validateDeck(
        definitionFor(rulesOf(r.dataset)),
        r.deck,
        await loadCatalog(r.dataset.id)
      );
      return c.json({ data: { valid: issues.length === 0, issues } });
    }
  );

  /**
   * Deals hands, with whole cards: the point of this is to see them.
   *
   * It returns the seed, so a specific hand can be requested again. And hand
   * number N is iteration N of the goldfish with that same seed, so "of the
   * 10,000 hands, these are five" is literally true.
   */
  app.post(
    "/hands",
    {
      id: "hands-deal-hands",
      summary: "Deal sample hands from a deck",
      description:
        "Deals `count` opening hands (plus `draws` extra cards) from a saved deck (`deckId`) or a loose one (`datasetId` + `cards`), with the full cards. Returns the seed: hand N is iteration N of a goldfish with that seed. A saved deck only opens for its owner (404 otherwise). Public.",
      access: "optional",
      readOnly: true,
      input: { body: DealBody },
      output: { schema: z.object({ data: Obj }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, { body: bodyValue }) => {
      const body = bodyValue as z.infer<typeof DealBody>;
      const r = await resolve(body, userOf(c));
      if ("error" in r) return c.json({ error: r.error }, r.status);

      try {
        const dealt = dealHands(definitionFor(rulesOf(r.dataset)), r.deck, {
          count: body.count,
          from: body.from,
          draws: body.draws,
          seed: body.seed ?? randomInt(0, 2 ** 31),
        });

        const index = new Map(
          (await cards().filter({ datasetId: r.dataset.id }).all()).map((row) => [row.cardId, row])
        );
        const hydrate = (ids: string[]) =>
          ids.map((id) => {
            const card = index.get(id);
            return {
              cardId: id,
              // An id that is not in the dataset does not break the hand: it comes out
              // name or picture, which is honest information about the deck.
              name: card?.name ?? id,
              imageUrl: card?.imageUrl ?? null,
              data: card?.data ?? {},
            };
          });

        return c.json({
          data: {
            seed: dealt.seed,
            deckSize: dealt.deckSize,
            handSize: dealt.handSize,
            hands: dealt.hands.map((h) => ({
              index: h.index,
              opening: hydrate(h.opening),
              drawn: hydrate(h.drawn),
            })),
          },
        });
      } catch (err) {
        const message =
          err instanceof GoldfishError ? err.message : "Could not deal hands";
        return c.json({ error: message }, 422);
      }
    }
  );

  /** Consistency. Delegated as is to cardsim's goldfish. */
  app.post(
    "/goldfish",
    {
      id: "hands-simulate-goldfish",
      summary: "Simulate deck consistency (goldfish)",
      description:
        "Runs cardsim's goldfish over a saved deck (`deckId`) or a loose one (`datasetId` + `cards`): for each query, how often the required cards are in hand by a turn, over 100-50000 seeded iterations. A saved deck only opens for its owner (404 otherwise). Public and CPU-heavy (rate limited).",
      access: "optional",
      readOnly: true,
      input: { body: RunGoldfish },
      output: { schema: z.object({ data: Obj }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, { body: bodyValue }) => {
      const body = bodyValue as z.infer<typeof RunGoldfish>;
      const r = await resolve(body, userOf(c));
      if ("error" in r) return c.json({ error: r.error }, r.status);

      try {
        const report = await goldfishAsync(
          definitionFor(rulesOf(r.dataset)),
          r.deck,
          await loadCatalog(r.dataset.id),
          body.queries as GoldfishQuery[],
          {
            iterations: body.iterations,
            seed: body.seed ?? randomInt(0, 2 ** 31),
            onThePlay: body.onThePlay,
            drawsPerTurn: body.drawsPerTurn,
            mulliganUnless: body.mulliganUnless,
          }
        );
        return c.json({ data: report });
      } catch (err) {
        const message = err instanceof GoldfishError ? err.message : "Could not simulate";
        return c.json({ error: message }, 422);
      }
    }
  );

  return app.ops;
}
