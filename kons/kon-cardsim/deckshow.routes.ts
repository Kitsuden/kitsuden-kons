/**
 * The showcase: build, test hands and publish — `/api/cardsim/showcase/...`
 * ============================================================================
 *
 * It was a kon of its own (DeckShow) and now lives inside CardSim, mounted at `/showcase`.
 * The routes keep their old paths below `/showcase`; the operation ids that would collide with
 * CardSim's (or the hand generator's) carry the `showcase-` prefix. The policy keeps its name,
 * `deckshow`, and so do the tables (`deckshow_entries`, `deckshow_likes`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT DUPLICATES NOTHING FROM CARDSIM
 *
 * There is no card or deck table here. The catalog lives in `cardsim_cards` and the lists in
 * `cardsim_decks`, and validation, goldfish and the hand dealer are the cardsim engine's
 * functions.
 *
 * The consequence that matters: **a showcase deck IS a real deck**, so it can be played without
 * exporting anything. With its own catalog there would be two truths about what a card is, and
 * the second ages on its own.
 *
 * What is its own: who published, how they tell it, whether it is featured and whether it is
 * visible. That does not fit in a list of 60 ids.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomBytes } from "node:crypto";

import { repo, can, attemptSql, type AuthzUser, type AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq, ilike } from "drizzle-orm";
import { z } from "zod";

import { sectionsOf, validateDeck, type CardCatalog, type DeckInput } from "./cardsim.deck.js";
import {
  dealHands,
  goldfishAsync,
  GoldfishError,
  type GoldfishQuery,
} from "./cardsim.goldfish.js";
import { cardsimCards, cardsimDecks, cardsimGames } from "./cardsim.schema.js";
import "./deckshow.policy.js";
import { deckshowEntries, deckshowLikes } from "./deckshow.schema.js";
import { Obj, Row, SHOWCASE_ACCOUNT, registry, text } from "./operations.js";

/** Where the showcase is mounted, below the kon's own routes. */
export const SHOWCASE_PREFIX = "/showcase";

// ── Input ────────────────────────────────────────────────────────────────────

/**
 * Sanity caps (the rules are set by `validateDeck`): without them a body
 * of a million ids got as far as being validated, and `/validate`, `/hands` and
 * `/goldfish` do not ask for an account.
 */
const CardIds = z.array(z.string().min(1).max(120)).max(1000);
const DeckBody = z.union([
  CardIds,
  z
    .record(z.string().max(60), CardIds)
    .refine((r) => Object.keys(r).length <= 20, { message: "Too many sections" }),
]);

/** A saved deck, or one half-built: the question is asked while building. */
const DeckSource = z
  .object({
    deckId: z.string().min(1).optional(),
    gameId: z.string().min(1).optional(),
    cards: DeckBody.optional(),
  })
  .refine((b) => Boolean(b.deckId) || (Boolean(b.gameId) && Boolean(b.cards)), {
    message: "`deckId` is required, or else `gameId` + `cards`",
  });

const DealHands = z.object({
  deckId: z.string().min(1).optional(),
  gameId: z.string().min(1).optional(),
  cards: DeckBody.optional(),
  count: z.number().int().min(1).max(20).default(5),
  /** Continues the batch: it is the "give me another hand". */
  from: z.number().int().min(0).max(100_000).default(0),
  draws: z.number().int().min(0).max(20).default(0),
  seed: z.number().int().optional(),
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

const RunGoldfish = z.object({
  deckId: z.string().min(1).optional(),
  gameId: z.string().min(1).optional(),
  cards: DeckBody.optional(),
  iterations: z.number().int().min(100).max(50_000).default(10_000),
  seed: z.number().int().optional(),
  onThePlay: z.boolean().default(true),
  queries: z.array(GoldfishQuerySchema).min(1).max(12),
});

const SaveDeck = z.object({
  gameId: z.string().min(1),
  name: z.string().min(1).max(80),
  cards: DeckBody,
});

const PublishEntry = z.object({
  deckId: z.string().min(1),
  title: z.string().min(3).max(120),
  description: z.string().max(8000).optional(),
  tags: z.array(z.string().min(1).max(30)).max(8).default([]),
  goldfishQueries: z.array(GoldfishQuerySchema).max(8).default([]),
  visibility: z.enum(["published", "unlisted"]).default("published"),
});

const EditEntry = PublishEntry.partial().omit({ deckId: true });

const Moderate = z.object({
  featured: z.boolean().optional(),
  hide: z.string().max(300).optional(),
});

// ── Parameters, query and outputs (OpenAPI and MCP) ─────────────────────────
//
// Parameters are declared as text: an id that does not exist is a 404 from the
// handler, not a 422. Outputs are lax on purpose (`passthrough`): they are
// database rows and cardsim engine results, which grow on their own.

const ParamSlug = z.object({ slug: z.string().describe("Slug (of a game or of an entry)") });
const ParamId = z.object({ id: z.string().describe("Entry id (deckshow_entries)") });

const Pagination = z.object({
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  pages: z.number().int(),
});
const Like = z.object({ data: z.object({ likes: z.number().int(), liked: z.boolean() }) });

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Readable slug from the title, with a random suffix ALWAYS.
 *
 * Not only on collision: two "Aggressive Red" decks are normal in a gallery, and
 * resolving the collision afterward forces retrying against the database with the
 * unique index complaining. By always adding it, publishing never fails because of the
 * name someone chose.
 */
function slugify(title: string): string {
  const base = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "deck"}-${randomBytes(3).toString("hex")}`;
}

export function deckshowOperations(ctx: KonContext): AnyOperation[] {
  const app = registry(SHOWCASE_PREFIX);
  const db = ctx.db.instance;

  const games = () => repo(cardsimGames, { db });
  const cards = () => repo(cardsimCards, { db });
  const decks = () => repo(cardsimDecks, { db });
  const entries = () => repo(deckshowEntries, { db });
  const likes = () => repo(deckshowLikes, { db });

  const asSystem = ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());

  /**
   * An entry's deck, for whoever asks for it.
   *
   * Decks live in `cardsim_decks`, and their RLS
   * (`cardsim_decks_owner_isolation`) only lets you see your OWN: for the
   * public, the deck of a published entry did not exist, and the record
   * answered 409 "The deck no longer exists" to everyone except its author
   * (phase D). Publishing is precisely showing it, so if the entry
   * is visible (not hidden) the deck is read as system. Without a visible entry,
   * someone else's deck still does not exist: there is no id oracle.
   */
  async function inputDeck(deckId: string) {
    const ownValue = await decks().find(deckId);
    if (ownValue) return ownValue;
    const input = await entries().filter({ deckId }).first();
    if (!input || input.status === "hidden") return null;
    return asSystem(() => decks().find(deckId));
  }

  const userOf = (c: { get: (k: string) => unknown }) =>
    (c.get("user") ?? null) as AuthzUser | null;

  /** Catalog per game, cached the same as in cardsim and for the same reason. */
  const catalogs = new Map<string, { at: number; catalog: CardCatalog }>();
  const CATALOG_TTL_MS = 60_000;

  async function loadCatalog(gameId: string): Promise<CardCatalog> {
    const hit = catalogs.get(gameId);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.catalog;
    const rows = await cards().filter({ gameId }).all();
    const catalog: CardCatalog = Object.fromEntries(
      rows.map((r) => [r.cardId, { name: r.name, ...r.data }])
    );
    catalogs.set(gameId, { at: Date.now(), catalog });
    return catalog;
  }

  /** The full cards by id. It is what turns a list of ids into something viewable. */
  async function loadCardIndex(gameId: string) {
    const rows = await cards().filter({ gameId }).all();
    return new Map(rows.map((r) => [r.cardId, r]));
  }

  /**
   * Resolves a request's deck: a saved one or a loose one.
   *
   * A saved deck is PERSONAL unless it is published in the showcase —
   * there its author shows it on purpose, and testing its hands is exactly what is
   * expected. Without this check, `deckId` would be a way to read anyone's
   * private deck.
   */
  async function resolveDeck(
    body: { deckId?: string; gameId?: string; cards?: DeckInput },
    user: AuthzUser | null
  ): Promise<
    | { game: typeof cardsimGames.$inferSelect; deck: DeckInput }
    | { error: string; status: 403 | 404 }
  > {
    let gameId = body.gameId;
    let deck = body.cards;

    if (body.deckId) {
      const saved = await inputDeck(body.deckId);
      if (!saved) return { error: "That deck does not exist", status: 404 };
      const shown = await entries().filter({ deckId: saved.id }).first();
      const audience = Boolean(shown) && shown!.status !== "hidden";
      if (!audience && saved.ownerId && saved.ownerId !== user?.id) {
        return { error: "That deck is not public", status: 403 };
      }
      gameId = saved.gameId;
      deck = saved.cards;
    }

    const game = gameId ? await games().find(gameId) : null;
    if (!game) return { error: "That game does not exist", status: 404 };
    return { game, deck: deck as DeckInput };
  }

  // ── Authentication ─────────────────────────────────────────────────────────
  // Viewing and TESTING is public: a showcase you have to sign in to
  // to see a hand is not a showcase. Each operation that writes declares
  // `access: "session"`; the others, `"optional"` (the user is only filled in if
  // there is one). Before it was an `app.use("*", optionalAuth)` over the whole kon.

  // ══ 1. Catalog, for the builder ═════════════════════════════════════════════

  /** The games that have something to show. */
  app.get(
    "/games",
    {
      id: "showcase-list-games",
      summary: "List the card games of the showcase",
      description:
        "Published card games (from kon-cardsim) with their opening hand size, deck sections and how many published showcase entries each has. Public.",
      access: "optional",
      output: {
        schema: z.object({
          data: z.array(
            z
              .object({
                id: z.string(),
                slug: z.string(),
                name: z.string(),
                sections: z.array(Obj),
                entries: z.number().int(),
              })
              .passthrough()
          ),
        }),
      },
    },
    async (c) => {
      const rows = await games().filter({ published: "published" }).orderBy("name").all();
      const published = await entries().filter({ status: "published" }).all();
      return c.json({
        data: rows.map((g) => ({
          id: g.id,
          slug: g.slug,
          name: g.name,
          openingHand: g.definition.openingHand,
          sections: sectionsOf(g.definition),
          entries: published.filter((e) => e.gameId === g.id).length,
        })),
      });
    }
  );

  /**
   * Card search. The name in SQL and the facets in memory, same as in
   * cardsim: these catalogs are hundreds or a few thousand cards, and indexing
   * every facet of a JSON would cost more than it saves.
   */
  app.get(
    "/games/:slug/cards",
    {
      id: "showcase-search-cards",
      summary: "Search the cards of a game",
      description:
        "Cards of the game `slug` for the deck builder: `q` matches the name, any other query key filters on that card property (exact match, arrays match any element). Paged (`pageSize` up to 120, default 48). 404 if the game does not exist.",
      access: "optional",
      input: {
        params: ParamSlug,
        query: z
          .object({
            q: text("Name contains (case-insensitive)"),
            page: text("1-based page"),
            pageSize: text("Page size, max 120 (default 48)"),
          })
          .passthrough()
          .describe("Any other key filters on that card property"),
      },
      output: { schema: z.object({ data: z.array(Row), meta: Pagination }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const game = await games()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!game) return c.json({ error: "Not found" }, 404);

      const q = c.req.query("q");
      const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
      const pageSize = Math.min(120, Number.parseInt(c.req.query("pageSize") ?? "48", 10) || 48);

      let rows = await cards()
        .where(
          q
            ? and(eq(cardsimCards.gameId, game.id), ilike(cardsimCards.name, `%${q}%`))!
            : eq(cardsimCards.gameId, game.id)
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

  // ══ 2. Build and test ═══════════════════════════════════════════════════════

  /** The three ways of giving a deck, for the descriptions. */
  const SOURCE =
    "The deck is `deckId` (a saved deck: yours, or one published in the showcase; someone else's private deck is a 403) or `gameId` + `cards` (a list of card ids, or `{ section: ids }`).";

  /** Validates without saving: it is what is called on every builder change. */
  app.post(
    "/validate",
    {
      id: "showcase-validate-deck",
      summary: "Validate a deck without saving it",
      description: `Checks a deck against its game's rules (sizes, copies, sections) and returns \`valid\` and the list of issues. Saves nothing. ${SOURCE}`,
      access: "optional",
      readOnly: true,
      input: { body: DeckSource },
      output: {
        schema: z.object({
          data: z.object({ valid: z.boolean(), issues: z.array(z.string()) }),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, input) => {
      const body = input.body as z.infer<typeof DeckSource>;
      const resolved = await resolveDeck(body, userOf(c));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);

      const issues = validateDeck(
        resolved.game.definition,
        resolved.deck,
        await loadCatalog(resolved.game.id)
      );
      return c.json({ data: { valid: issues.length === 0, issues } });
    }
  );

  /**
   * Deals hands to LOOK AT them.
   *
   * It returns the full cards, not ids: the point of this is to see them. And
   * it returns the seed, so a specific hand can be requested again —
   * an author can link "look at hand 7 of my deck" and the same one comes out.
   *
   * Hand number N is, moreover, iteration N of the goldfish with that same
   * seed: "of the 10,000 hands, these are five" is literally true.
   */
  app.post(
    "/hands",
    {
      id: "showcase-deal-hands",
      summary: "Deal sample hands from a deck",
      description: `Deals \`count\` opening hands (1-20, plus \`draws\` extra cards) with the full card data, and the \`seed\` used: the same seed and \`from\` deal the same hands again (hand N is iteration N of the goldfish with that seed). Saves nothing. ${SOURCE} 422 if the deck cannot be dealt.`,
      access: "optional",
      readOnly: true,
      input: { body: DealHands },
      output: {
        schema: z.object({
          data: z
            .object({
              seed: z.number(),
              deckSize: z.number().int(),
              handSize: z.number().int(),
              hands: z.array(Obj),
            })
            .passthrough(),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, input) => {
      const body = input.body as z.infer<typeof DealHands>;
      const resolved = await resolveDeck(body, userOf(c));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);

      try {
        const dealt = dealHands(resolved.game.definition, resolved.deck, {
          count: body.count,
          from: body.from,
          draws: body.draws,
          seed: body.seed ?? Math.floor(Date.now() % 2 ** 31),
        });

        const index = await loadCardIndex(resolved.game.id);
        const hydrate = (ids: string[]) =>
          ids.map((id) => {
            const card = index.get(id);
            return {
              cardId: id,
              // An id that is not in the catalog does not break the hand: it comes out with no
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

  /** The statistics. Delegated as is to cardsim's goldfish. */
  app.post(
    "/goldfish",
    {
      id: "showcase-simulate-goldfish",
      summary: "Run goldfish statistics on a deck",
      description: `Simulates \`iterations\` games (100-50000) and answers each query (e.g. 'at least one land and a 2-drop by turn 2') with its probability. Seeded and reproducible. Saves nothing. ${SOURCE} 422 if a query cannot be evaluated.`,
      access: "optional",
      readOnly: true,
      input: { body: RunGoldfish },
      output: { schema: z.object({ data: Obj }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, input) => {
      const body = input.body as z.infer<typeof RunGoldfish>;
      const resolved = await resolveDeck(body, userOf(c));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);

      try {
        const report = await goldfishAsync(
          resolved.game.definition,
          resolved.deck,
          await loadCatalog(resolved.game.id),
          body.queries as GoldfishQuery[],
          {
            iterations: body.iterations,
            seed: body.seed ?? Math.floor(Date.now() % 2 ** 31),
            onThePlay: body.onThePlay,
          }
        );
        return c.json({ data: report });
      } catch (err) {
        const message = err instanceof GoldfishError ? err.message : "Could not simulate";
        return c.json({ error: message }, 422);
      }
    }
  );

  /** Saves the deck — in `cardsim_decks`, so that it can also be played. */
  app.post(
    "/decks",
    {
      id: "showcase-save-deck",
      summary: "Save a deck",
      description:
        "Saves a legal deck as yours in kon-cardsim (so it can also be played there) with a share id. 422 with `issues` if the deck breaks the game's rules, 404 if the game does not exist. Any signed-in person; an agent needs deckshow:create.",
      access: "session",
      permission: SHOWCASE_ACCOUNT,
      input: { body: SaveDeck },
      output: { status: 201, schema: z.object({ data: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const user = userOf(c);
      if (!(await h.can({}, "create"))) return c.json({ error: "Forbidden" }, 403);
      const data = input.body as z.infer<typeof SaveDeck>;
      const game = await games().find(data.gameId);
      if (!game) return c.json({ error: "That game does not exist" }, 404);

      const issues = validateDeck(
        game.definition,
        data.cards as DeckInput,
        await loadCatalog(game.id)
      );
      if (issues.length) return c.json({ error: "Invalid deck", issues }, 422);

      const row = await decks().create({
        gameId: data.gameId,
        name: data.name,
        cards: data.cards as DeckInput,
        ownerId: user?.id ?? null,
        shareId: randomBytes(6).toString("hex"),
      });
      return c.json({ data: row }, 201);
    }
  );

  // ══ 3. The showcase ═════════════════════════════════════════════════════════

  /**
   * The gallery. `unlisted` NEVER appears here: it is shared by link, and
   * slipping it into a listing by oversight would be publishing what someone decided
   * not to publish.
   */
  app.get(
    "/entries",
    {
      id: "list-posts",
      summary: "List the published decks of the showcase",
      description:
        "The gallery: published entries only (unlisted ones never appear), filtered by `gameId` and `tag`, sorted `featured` (default: featured first, then newest), `recent` or `popular` (likes, then views). Paged (`pageSize` up to 60, default 24). Public.",
      access: "optional",
      input: {
        query: z
          .object({
            page: text("1-based page"),
            pageSize: text("Page size, max 60 (default 24)"),
            gameId: text("Only entries of this game"),
            tag: text("Only entries with this tag"),
            sort: text("featured (default) | recent | popular"),
          })
          .passthrough(),
      },
      output: { schema: z.object({ data: z.array(Row), meta: Pagination }) },
    },
    async (c) => {
      const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
      const pageSize = Math.min(60, Number.parseInt(c.req.query("pageSize") ?? "24", 10) || 24);
      const gameId = c.req.query("gameId");
      const tag = c.req.query("tag");
      const sort = c.req.query("sort") ?? "featured";

      let rows = await entries()
        .filter(gameId ? { status: "published", gameId } : { status: "published" })
        .all();
      if (tag) rows = rows.filter((r) => r.tags.includes(tag));

      rows.sort((a, b) => {
        if (sort === "popular") return b.likes - a.likes || b.views - a.views;
        if (sort === "recent") return b.publishedAt.getTime() - a.publishedAt.getTime();
        // "featured": featured first and, within that, the most recent.
        if (a.featured !== b.featured) return a.featured ? -1 : 1;
        return b.publishedAt.getTime() - a.publishedAt.getTime();
      });

      const start = (page - 1) * pageSize;
      return c.json({
        data: rows.slice(start, start + pageSize),
        meta: { total: rows.length, page, pageSize, pages: Math.ceil(rows.length / pageSize) },
      });
    }
  );

  /** An entry with its deck hydrated: everything the record draws. */
  app.get(
    "/entries/:slug",
    {
      id: "get-post",
      summary: "Read a showcase entry with its deck",
      description:
        "The entry, its game (with the definition) and its deck grouped by section and card, with names and images, plus whether you liked it. Counts a view. A hidden entry is a 404 except for its author and moderators; 409 if its deck or game no longer exists.",
      access: "optional",
      input: { params: ParamSlug },
      output: {
        schema: z.object({
          data: Row,
          game: z.object({ id: z.string(), slug: z.string(), name: z.string() }).passthrough(),
          deck: z.object({ id: z.string(), name: z.string(), sections: z.array(Obj) }),
          liked: z.boolean(),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const user = userOf(c);
      const entry = await entries()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!entry) return c.json({ error: "Not found" }, 404);
      // A hidden deck answers 404, not 403: saying "it exists but I won't show it to you"
      // confirms that it exists, and that is already information.
      if (!(await can(user, "view", entry, "deckshow"))) return c.json({ error: "Not found" }, 404);

      // The entry already passed `view` (hidden = only author and moderation): its deck is
      // shown even if the RLS of `cardsim_decks` hides it from whoever is not its owner.
      const deck = await asSystem(() => decks().find(entry.deckId));
      const game = await games().find(entry.gameId);
      if (!deck || !game) return c.json({ error: "The deck no longer exists" }, 409);

      const index = await loadCardIndex(entry.gameId);
      const sections = sectionsOf(game.definition);
      const bySection = Array.isArray(deck.cards) ? { [sections[0].id]: deck.cards } : deck.cards;

      // Grouped by card, which is how a list is read — nobody wants 60 rows.
      const hydrated = sections.map((section) => {
        const list = bySection[section.id] ?? [];
        const counts = new Map<string, number>();
        for (const id of list) counts.set(id, (counts.get(id) ?? 0) + 1);
        return {
          id: section.id,
          name: section.name,
          total: list.length,
          cards: [...counts.entries()].map(([cardId, count]) => ({
            count,
            cardId,
            name: index.get(cardId)?.name ?? cardId,
            imageUrl: index.get(cardId)?.imageUrl ?? null,
            data: index.get(cardId)?.data ?? {},
          })),
        };
      });

      // Counting the visit must not be able to bring down the record: if it fails, it is shown anyway.
      // In its SAVEPOINT: a failure without it would leave the request's transaction
      // aborted and the "like" query below would fail with it.
      await attemptSql(
        () =>
          entries()
            .filter({ id: entry.id })
            .update({ views: entry.views + 1 }),
        undefined
      );

      const liked = user?.id
        ? Boolean(await likes().filter({ entryId: entry.id, userId: user.id }).first())
        : false;

      return c.json({
        data: entry,
        game: { id: game.id, slug: game.slug, name: game.name, definition: game.definition },
        deck: { id: deck.id, name: deck.name, sections: hydrated },
        liked,
      });
    }
  );

  app.post(
    "/entries",
    {
      id: "publish-post",
      summary: "Publish one of your decks in the showcase",
      description:
        "Publishes your saved deck `deckId` as a showcase entry (`published` in the gallery, or `unlisted`: link only) with title, description, tags and goldfish queries; the slug is derived from the title. Only legal decks (422 with `issues`), only your own deck (403), once per deck (409). Any signed-in person; an agent needs deckshow:create.",
      access: "session",
      permission: SHOWCASE_ACCOUNT,
      // Publishing shows the deck to everyone.
      sensitive: true,
      input: { body: PublishEntry },
      output: { status: 201, schema: z.object({ data: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const user = userOf(c);
      if (!(await h.can({}, "create"))) return c.json({ error: "Forbidden" }, 403);
      const data = input.body as z.infer<typeof PublishEntry>;

      const deck = await decks().find(data.deckId);
      if (!deck) return c.json({ error: "That deck does not exist" }, 404);
      if (deck.ownerId && deck.ownerId !== user?.id) {
        return c.json({ error: "That deck is not yours" }, 403);
      }
      if (await entries().filter({ deckId: deck.id }).first()) {
        return c.json({ error: "That deck is already published" }, 409);
      }

      const game = await games().find(deck.gameId);
      if (!game) return c.json({ error: "That game no longer exists" }, 409);
      // What is LEGAL gets published. A showcase full of invalid decks stops
      // serving as a reference, which is the only thing a showcase does.
      const issues = validateDeck(game.definition, deck.cards, await loadCatalog(game.id));
      if (issues.length) return c.json({ error: "The deck is not legal", issues }, 422);

      const row = await entries().create({
        deckId: deck.id,
        gameId: deck.gameId,
        slug: slugify(data.title),
        title: data.title,
        description: data.description ?? null,
        tags: data.tags,
        goldfishQueries: data.goldfishQueries as GoldfishQuery[],
        authorId: user?.id ?? null,
        status: data.visibility,
      });
      return c.json({ data: row }, 201);
    }
  );

  app.put(
    "/entries/:id",
    {
      id: "update-post",
      summary: "Edit a showcase entry",
      description:
        "Changes title, description, tags, goldfish queries or visibility (published/unlisted) of an entry; omitted fields keep their value. An author cannot unhide what moderation hid. Its author or a moderator (403 otherwise).",
      access: "session",
      permission: SHOWCASE_ACCOUNT,
      input: { params: ParamId, body: EditEntry },
      output: { schema: z.object({ data: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const entry = await entries().find(c.req.param("id"));
      if (!entry) return c.json({ error: "Not found" }, 404);
      if (!(await h.can(entry, "update"))) return c.json({ error: "Forbidden" }, 403);

      const data = input.body as z.infer<typeof EditEntry>;
      const [row] = await entries()
        .filter({ id: entry.id })
        .update({
          title: data.title ?? entry.title,
          description: data.description ?? entry.description,
          tags: data.tags ?? entry.tags,
          goldfishQueries: (data.goldfishQueries as GoldfishQuery[]) ?? entry.goldfishQueries,
          // An author can withdraw their deck from the gallery, but CANNOT
          // unhide what moderation hid.
          status: entry.status === "hidden" ? entry.status : (data.visibility ?? entry.status),
          updatedAt: new Date(),
        });
      return c.json({ data: row });
    }
  );

  app.delete(
    "/entries/:id",
    {
      id: "delete-post",
      summary: "Remove an entry from the showcase",
      description:
        "Deletes the entry and its likes; the deck itself stays saved in kon-cardsim. Its author or a moderator (403 otherwise). 204 with no body.",
      access: "session",
      permission: SHOWCASE_ACCOUNT,
      input: { params: ParamId },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, _input, h) => {
      const entry = await entries().find(c.req.param("id"));
      if (!entry) return c.json({ error: "Not found" }, 404);
      if (!(await h.can(entry, "delete"))) return c.json({ error: "Forbidden" }, 403);
      // The ENTRY is deleted, not the deck: removing it from the showcase is not throwing it away.
      await likes().filter({ entryId: entry.id }).delete();
      await entries().filter({ id: entry.id }).delete();
      return c.body(null, 204);
    }
  );

  // ── Likes ──────────────────────────────────────────────────────────────────

  app.post(
    "/entries/:id/like",
    {
      id: "like",
      summary: "Like a showcase entry",
      description:
        "Adds your like to the entry and returns its like count. Liking twice changes nothing. A hidden entry you cannot see is a 404. Any signed-in person; an agent needs deckshow:create.",
      access: "session",
      permission: SHOWCASE_ACCOUNT,
      // Liking twice leaves the same.
      idempotent: true,
      input: { params: ParamId },
      output: { schema: Like },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const userId = userOf(c)?.id;
      if (!userId) return c.json({ error: "Unauthorized" }, 401);
      if (!(await h.can({}, "create"))) return c.json({ error: "Forbidden" }, 403);
      const entry = await entries().find(c.req.param("id"));
      // What moderation hid cannot be voted on: 404 as in the record, so that
      // a "like" does not serve to confirm that a hidden deck exists.
      if (!entry || !(await can(userOf(c), "view", entry, "deckshow"))) {
        return c.json({ error: "Not found" }, 404);
      }

      // The unique index is the real rule; this only avoids the 500 on repeating.
      if (await likes().filter({ entryId: entry.id, userId }).first()) {
        return c.json({ data: { likes: entry.likes, liked: true } });
      }
      await likes().create({ entryId: entry.id, userId });
      const [row] = await entries()
        .filter({ id: entry.id })
        .update({ likes: entry.likes + 1 });
      return c.json({ data: { likes: row.likes, liked: true } });
    }
  );

  app.delete(
    "/entries/:id/like",
    {
      id: "unlike",
      summary: "Remove your like from a showcase entry",
      description:
        "Removes your like (if any) and returns the entry's like count. Any signed-in person.",
      access: "session",
      permission: SHOWCASE_ACCOUNT,
      input: { params: ParamId },
      output: { schema: Like },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const userId = userOf(c)?.id;
      if (!userId) return c.json({ error: "Unauthorized" }, 401);
      const entry = await entries().find(c.req.param("id"));
      if (!entry) return c.json({ error: "Not found" }, 404);

      const removed = await likes().filter({ entryId: entry.id, userId }).delete();
      if (!removed) return c.json({ data: { likes: entry.likes, liked: false } });
      const [row] = await entries()
        .filter({ id: entry.id })
        .update({ likes: Math.max(0, entry.likes - 1) });
      return c.json({ data: { likes: row.likes, liked: false } });
    }
  );

  // ── Curation and moderation ────────────────────────────────────────────────

  /**
   * Feature and hide. It is the policy's `moderate` action, not `update`: if
   * they were the same, any author could feature themselves.
   */
  app.post(
    "/entries/:id/moderate",
    {
      id: "moderate-post",
      summary: "Feature or hide a showcase entry",
      description:
        "Moderation: `featured` puts the entry first in the gallery; `hide` (a reason, required to hide) takes it out of the showcase for everyone but its author; without `hide` a hidden entry is restored. Admin/editor only — never the author (403).",
      access: "session",
      permission: SHOWCASE_ACCOUNT,
      // Hiding removes from the showcase what another person published.
      sensitive: true,
      input: { params: ParamId, body: Moderate },
      output: { schema: z.object({ data: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const entry = await entries().find(c.req.param("id"));
      if (!entry) return c.json({ error: "Not found" }, 404);
      if (!(await h.can(entry, "moderate"))) {
        return c.json({ error: "Forbidden" }, 403);
      }

      const data = input.body as z.infer<typeof Moderate>;
      const [row] = await entries()
        .filter({ id: entry.id })
        .update({
          featured: data.featured ?? entry.featured,
          featuredAt: data.featured ? new Date() : entry.featuredAt,
          // ALWAYS hide with a reason: hiding without saying why is what
          // turns moderation into an argument. Without `hide`, it is restored.
          status: data.hide ? "hidden" : entry.status === "hidden" ? "published" : entry.status,
          hiddenReason: data.hide ?? null,
          updatedAt: new Date(),
        });
      return c.json({ data: row });
    }
  );

  return app.ops;
}
