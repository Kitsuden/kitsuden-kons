/**
 * @kitsuden/kon-cardsim
 * ============================================================================
 *
 * Card game simulator builder. A game is DEFINED with data
 * (zones, resources, deck sections, phases, defeats) and the engine executes it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SESSION DOES NOT STORE STATE
 *
 * It stores `{seed, decks, actions}` and the state is rebuilt with `replay`.
 * That makes replay free, synchronization cheap, UNDO trivial
 * (truncate the list) and cheating structurally impossible: the deck
 * order travels to NO client, because what travels is the per-seat view
 * computed by `viewFor`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The routes are grouped into five blocks that are five product screens:
 * card catalog, deck builder, room/lobby, game and ranking.
 *
 * Two more tools live below them, with their own tables and policies and the
 * same engine:
 *
 *   · `/showcase/...` — the deck showcase (`deckshow.routes.ts`): build, test
 *     hands and publish decks of the cardsim games.
 *   · `/hands/...` — the hand generator (`handlab.routes.ts`): a card dataset
 *     plus four rules, no game, and it deals hands and statistics.
 *
 * Both were kons of their own (DeckShow and HandLab) until 2.3.0; see README.md.
 */

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

import {
  defineKonSdk,
  repo,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import { readDatasetCatalog, type KonContext } from "@kitsuden/shared";
import { and, eq, ilike } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { sectionsOf, validateDeck, type CardCatalog, type DeckInput } from "./cardsim.deck.js";
import { formatDeckList, formatYdk, parseDeckList, parseYdk } from "./cardsim.decklist.js";
import {
  applyAction,
  CardSimError,
  checkSecrecy,
  createRng,
  replay,
  validateGameDefinition,
  viewFor,
  type Action,
  type GameDefinition,
  type SessionState,
} from "./cardsim.engine.js";
import { goldfishAsync, GoldfishError } from "./cardsim.goldfish.js";
import "./cardsim.policy.js";
import { deckshowOperations } from "./deckshow.routes.js";
import { handlabOperations } from "./handlab.routes.js";
import { PRESETS } from "./cardsim.presets.js";
import { applyElo } from "./cardsim.rating.js";
import { cardsFromEntries } from "./cardsim.dataset.js";
import {
  cardsimCards,
  cardsimDecks,
  cardsimGames,
  cardsimMatches,
  cardsimQueue,
  cardsimRatings,
  cardsimSessions,
} from "./cardsim.schema.js";
import { SessionStateCache } from "./cardsim.statecache.js";
import { newRandomSecret, seedOf, usedSubseeds } from "./cardsim.seed.js";
import {
  CATALOG,
  ANY_ACCOUNT,
  Row,
  KON_ID,
  Obj,
  CodeParam,
  ParamId,
  ParamSlug,
  withData,
  query,
  registry,
  text,
} from "./operations.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./cardsim.engine.js";
export * from "./cardsim.schema.js";
export * from "./cardsim.presets.js";
export * from "./cardsim.decklist.js";
export * from "./cardsim.rating.js";
export * from "./cardsim.goldfish.js";
export * from "./cardsim.statecache.js";
export * from "./deckshow.schema.js";
export * from "./handlab.schema.js";
export * from "./handlab.definition.js";
export { deckshowOperations, SHOWCASE_PREFIX } from "./deckshow.routes.js";
export { handlabOperations, HANDS_PREFIX, safeImage } from "./handlab.routes.js";
export { registerDeckshowPolicy } from "./deckshow.policy.js";
export { registerHandlabPolicy } from "./handlab.policy.js";

// ── Room passwords ───────────────────────────────────────────────────────────

/**
 * A ROOM password is not an account credential, but people
 * reuse passwords: storing it in plaintext would be handing out other people's credentials.
 * scrypt with a per-row salt, and constant-time comparison.
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return true; // room without a password
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

// ── Input schemas ────────────────────────────────────────────────────────────

const CreateSession = z.object({
  gameId: z.string().min(1),
  deckIds: z.array(z.string().min(1)).min(1).max(8),
  /** Total seats; those not filled stay open. */
  seatCount: z.number().int().min(1).max(8).optional(),
  name: z.string().max(80).optional(),
  visibility: z.enum(["public", "private"]).default("public"),
  password: z.string().min(1).max(100).optional(),
  allowSpectators: z.boolean().default(true),
  bestOf: z.number().int().min(1).max(9).optional(),
  /**
   * Solo game: you sit in ALL the seats and move both sides. It is how a deck is tested, and the reference sites have it.
   */
  solo: z.boolean().default(false),
  /** Clock per player. Without this, the game has no time limit. */
  timeControlSeconds: z.number().int().min(30).max(7200).optional(),
  /** Increment per finished turn (Fischer). */
  incrementSeconds: z.number().int().min(0).max(120).default(0),
  /**
   * Explicit seed to reproduce a specific game (tests, debugging).
   *
   * SOLO only. With the seed and their own deck, whoever creates the room
   * knows their deck's order before drawing —and can try seeds at
   * home until finding a perfect hand—; if they also know the opponent's
   * list, they know their hand too. In a two-player game the server chooses it.
   */
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1)
    .optional(),
});

const JoinSession = z.object({
  seat: z.number().int().min(0).max(7),
  deckId: z.string().min(1),
  password: z.string().max(100).optional(),
});

const SubmitAction = z.object({
  /** Seat from which one acts. Checked against `seats`. */
  seat: z.number().int().min(0).max(7),
  action: z.record(z.string(), z.unknown()),
});

const UndoRequest = z.object({ toActionCount: z.number().int().min(0) });

/**
 * A list of cards: sanity caps, not rule caps. The game's rules are
 * applied by `validateDeck`; this prevents a body of a million ids from reaching
 * validation (sign-up is open and saving decks requires no role).
 */
const CardIds = z.array(z.string().min(1).max(120)).max(1000);
const DeckCards = z.union([
  CardIds,
  z
    .record(z.string().max(60), CardIds)
    .refine((r) => Object.keys(r).length <= 20, { message: "Too many sections" }),
]);

/** A sealed pack: rarity → how many. Without a cap, `{"C": 1e9}` brought the process down. */
const SealedRequest = z
  .object({
    packs: z.number().int().min(1).max(24).optional(),
    packSize: z.number().int().min(1).max(30).optional(),
    sets: z.array(z.string().max(60)).max(50).optional(),
    slots: z
      .record(z.string().max(40), z.number().int().min(0).max(30))
      .refine((r) => Object.keys(r).length <= 20, { message: "Too many rarities" })
      .refine((r) => Object.values(r).reduce((a, b) => a + b, 0) <= 30, {
        message: "A pack has at most 30 cards",
      })
      .optional(),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1)
      .optional(),
  })
  .default({});

const ImportDeck = z.object({
  gameId: z.string().min(1),
  name: z.string().max(80).optional(),
  format: z.enum(["text", "ydk"]).default("text"),
  content: z.string().min(1).max(100_000),
});

const SaveDeck = z.object({
  gameId: z.string().min(1),
  name: z.string().max(80).optional(),
  /** Bare list or map by section. */
  cards: DeckCards,
});

// ── Goldfish ─────────────────────────────────────────────────────────────────
// The caps are for sanity, not taste: a query with 40 filters or a
// million iterations informs of nothing and does bring the server down.

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
  /** 0 only makes sense with `atMost` ("no lands in the hand"). */
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

const GoldfishRequest = z
  .object({
    /** A saved deck… */
    deckId: z.string().min(1).optional(),
    /** …or a loose one, to test from the builder before saving it. */
    gameId: z.string().min(1).optional(),
    cards: DeckCards.optional(),
    /**
     * Lower HTTP cap than the library's (200,000): the API is a
     * shared resource. Even yielding the thread, 50,000 hands are several
     * seconds of CPU, and at that point the sampling error is already ±0.2 %
     * — more iterations do not answer the question better, they only cost more.
     */
    iterations: z.number().int().min(100).max(50_000).default(10_000),
    seed: z.number().int().optional(),
    onThePlay: z.boolean().default(true),
    drawsPerTurn: z.number().int().min(1).max(10).default(1),
    curveProperty: z.string().min(1).max(60).optional(),
    sampleHands: z.number().int().min(0).max(20).default(0),
    mulliganUnless: z.array(GoldfishReq).max(8).optional(),
    queries: z.array(GoldfishQuerySchema).min(1).max(20),
  })
  .refine((b) => Boolean(b.deckId) || (Boolean(b.gameId) && Boolean(b.cards)), {
    message: "`deckId` is required, or else `gameId` + `cards`",
  });

const JoinQueue = z.object({
  gameId: z.string().min(1),
  deckId: z.string().min(1),
  rated: z.boolean().default(true),
});

/**
 * Publishing a game (PUT /games). The handler reads the body itself and gives its usual
 * 400s when `slug` or `definition` is missing; this fixes the TYPES (a
 * `definition: []` or a `slug: {}` used to reach the engine and come out as a 500).
 */
const PublishGame = z
  .object({
    slug: z.string().optional(),
    definition: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The game definition (zones, resources, deckRules, phases…)"),
    preset: z.string().optional().describe("Alternative to `definition`: a preset id"),
  })
  .passthrough()
  .nullable()
  .optional();

/**
 * Card dump (POST /games/:slug/cards). Rows without `cardId` or without
 * `name` are NOT rejected: they are counted as `skipped` (it is the dump's
 * contract). A `cardId` that is not text is: two ids `1` and `"1"` went to the same
 * unique index and the whole import came out as a 500.
 */
const DumpCard = z
  .object({
    cardId: z.string().optional(),
    name: z.string().optional(),
    imageUrl: z.string().nullable().optional(),
    data: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough()
  .nullable();
const ImportCards = z
  .object({
    cards: z
      .array(DumpCard)
      .optional()
      .describe("1 to 20,000 cards; more is a 413. Upsert by cardId."),
  })
  .passthrough()
  .nullable()
  .optional();

const SyncCatalog = z
  .object({
    datasetId: z.string().optional(),
    idField: z.string().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

/**
 * Outputs with TWO success statuses (the handler returns the finished `Response`).
 * Constants and not literals: `otherStatuses` is only published (OpenAPI), and this way
 * it also compiles against a host whose type does not yet declare it.
 */
const PUBLISH_OUTPUT = {
  schema: withData(Row),
  otherStatuses: [201 as const],
  description: "Rewritten (200) or created (201)",
};
const QUEUE_OUTPUT = {
  status: 201 as const,
  schema: withData(Obj),
  otherStatuses: [202 as const],
  description: "Matched (201: sessionId, seat, matchId) or waiting (202: waiting)",
};

/** The kon's operations, in the usual order (the first that matches wins). */
export function cardsimOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const db = ctx.db.instance;

  const games = () => repo(cardsimGames, { db });
  const cards = () => repo(cardsimCards, { db });
  const decks = () => repo(cardsimDecks, { db });
  const sessions = () => repo(cardsimSessions, { db });
  const matches = () => repo(cardsimMatches, { db });
  const ratings = () => repo(cardsimRatings, { db });
  const queue = () => repo(cardsimQueue, { db });

  const asSystem = ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());

  /**
   * A deck by its id, for whoever requests it.
   *
   * With the request's RLS, ANOTHER person's deck does not exist for whoever
   * asks (`cardsim_decks_owner_isolation`). The exception is the share link:
   * whoever brings `?share=` can read it even if it is not theirs, and the
   * database does not know that. So, ONLY with `share`, it is looked up as system and
   * the code is checked here; without `share`, someone else's gives 404 —which is the same
   * as "does not exist", with no oracle for which ids exist—.
   */
  const deckFor = async (id: string, share: string | undefined) => {
    const visible = await decks().find(id);
    if (visible || !share) return visible;
    return asSystem(async () => {
      const deck = await decks().find(id);
      return deck && deck.shareId === share ? deck : null;
    });
  };

  const userOf = (c: { get: (k: string) => unknown }) =>
    (c.get("user") ?? null) as AuthzUser | null;

  /**
   * The properties of the game's cards. `validateDeck` needs them for
   * the caps per group ("8 Lucky") and per distinct colors: without a catalog those
   * limits are SKIPPED, so loading it is not optional when saving a deck.
   */
  /**
   * Rebuilt state, cached per game.
   *
   * Without this, every read replays the WHOLE game: with 300 actions and
   * clients polling, the cost grows with the game just when the most people are
   * watching. The cache makes it incremental.
   */
  const stateCache = new SessionStateCache();

  /**
   * A game's catalog, cached in-process.
   *
   * One Piece has 2876 cards and the catalog was requested on EVERY deck save,
   * import and goldfish. It is editorial data: it changes when
   * someone imports a set, not between two requests.
   *
   * The TTL is the safety net for several processes: the one that imports
   * invalidates its own immediately, and the others find out within a minute at
   * most. For a card catalog it is a lag that hurts no one.
   */
  const catalogs = new Map<string, { at: number; catalog: CardCatalog }>();
  const CATALOG_TTL_MS = 60_000;

  async function loadCatalog(gameId: string): Promise<CardCatalog> {
    const cached = catalogs.get(gameId);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog;
    const rows = await cards().filter({ gameId }).all();
    // `name` is a column, not part of `data`, but it is put in the catalog
    // so it can be filtered by: "how many times do I draw Ariel?" is a question
    // by name, not by card number. If `data` already brings its own `name`,
    // its own wins — it is the one the game decided to publish.
    const catalog: CardCatalog = Object.fromEntries(
      rows.map((r) => [r.cardId, { name: r.name, ...r.data }])
    );
    catalogs.set(gameId, { at: Date.now(), catalog });
    return catalog;
  }

  // ── Authentication ─────────────────────────────────────────────────────────
  // Reading is public (the catalog and watching a game as a spectator); writing
  // requires a session. A spectator without an account sees `viewFor(null)`, which carries
  // no secret — that is why it can get through unauthenticated.
  //
  // Before they were gates by prefix (`app.use("/sessions/*", …)`: GET with an optional
  // session, everything else with `requireAuth`); now each operation declares its
  // `access`, with the same split:
  //   · GET of /games, /sessions, /matches, /rooms, /ratings → "opcional";
  //   · writes of /games and /sessions, /decks and /queue entirely → "sesion";
  //   · /goldfish → "opcional": accepts a loose deck (public) or a saved one
  //     (personal), and ownership is checked inside.

  // ══ 1. Catalog of games and cards ══════════════════════════════════════════

  /** The definitions the kon ships: publishing Palworld is a POST, not a ticket. */
  app.get(
    "/presets",
    {
      id: "list-presets",
      summary: "List the built-in game presets",
      description:
        "The game definitions shipped with the kon (id, name, players, zone count, deck sections with their size range). Publish one with publish-game `{ slug, preset }`. Public.",
      access: "public",
      output: {
        schema: withData(z.array(z.object({ id: z.string(), name: z.string() }).passthrough())),
      },
    },
    (c) =>
      c.json({
        data: Object.values(PRESETS).map((d) => ({
          id: d.id,
          name: d.name,
          players: d.players,
          zones: d.zones.length,
          sections: sectionsOf(d).map((s) => ({
            id: s.id,
            name: s.name,
            size: [s.minSize, s.maxSize],
          })),
        })),
      })
  );

  app.get(
    "/games",
    {
      id: "list-games",
      summary: "List published games",
      description:
        "Every published card game (slug, name, full definition), by name. Use the slug with get-game, search-cards or get-ranking. Public.",
      access: "optional",
      output: { schema: withData(z.array(Row)) },
    },
    async (c) => {
      const rows = await games().filter({ published: "published" }).orderBy("name").all();
      return c.json({ data: rows });
    }
  );

  app.get(
    "/games/:slug",
    {
      id: "get-game",
      summary: "Get a game by slug",
      description:
        "A published game: its definition, how many cards its catalogue has (`cardCount`) and its deck sections. 404 if the slug does not exist. Public.",
      access: "optional",
      input: { params: ParamSlug },
      output: { schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const game = await games()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!game) return c.json({ error: "Not found" }, 404);
      const count = await cards().filter({ gameId: game.id }).count();
      return c.json({ data: game, cardCount: count, sections: sectionsOf(game.definition) });
    }
  );

  /**
   * The deck builder's search. The name is filtered in SQL; the
   * facets (`?type=Pal&color=Red`) are filtered in memory because they live inside
   * `data` as JSON and these catalogs are hundreds of cards, not
   * millions — indexing each facet would cost more than it saves.
   */
  app.get(
    "/games/:slug/cards",
    {
      id: "search-cards",
      summary: "Search a game's card catalogue",
      description:
        "Deck-builder search: `q` filters by name (contains, case-insensitive); any OTHER query key is a facet over the card data (`?type=Pal&color=Red`, exact match, arrays match any value). Paged with `page` and `pageSize` (max 200, default 60). Public.",
      access: "optional",
      input: {
        params: ParamSlug,
        query: query({
          q: text("Name contains (case-insensitive)"),
          page: text("Page, from 1"),
          pageSize: text("Page size (max 200, default 60)"),
        }),
      },
      output: {
        schema: z
          .object({
            data: z.array(Row),
            meta: z
              .object({
                total: z.number(),
                page: z.number(),
                pageSize: z.number(),
                pages: z.number(),
              })
              .passthrough(),
          })
          .passthrough(),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const game = await games()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!game) return c.json({ error: "Not found" }, 404);

      const q = c.req.query("q");
      const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
      const pageSize = Math.min(200, Number.parseInt(c.req.query("pageSize") ?? "60", 10) || 60);

      let rows = await cards()
        .where(
          q
            ? and(eq(cardsimCards.gameId, game.id), ilike(cardsimCards.name, `%${q}%`))!
            : eq(cardsimCards.gameId, game.id)
        )
        .orderBy("cardId")
        .all();

      const reserved = new Set(["q", "page", "pageSize"]);
      const facets = Object.entries(c.req.query()).filter(([k]) => !reserved.has(k));
      for (const [key, value] of facets) {
        rows = rows.filter((row) => {
          const raw = row.data[key];
          const values = Array.isArray(raw) ? raw : [raw];
          return values.some((v) => String(v) === value);
        });
      }

      const start = (page - 1) * pageSize;
      return c.json({
        data: rows.slice(start, start + pageSize),
        meta: { total: rows.length, page, pageSize, pages: Math.ceil(rows.length / pageSize) },
      });
    }
  );

  /** Publishes a game. Validates the definition: a broken game is not served. */
  app.put(
    "/games",
    {
      id: "publish-game",
      summary: "Publish or rewrite a game definition",
      description:
        "Publishes a game by `slug` from a full `definition`, or from a built-in `preset` id (see list-presets; then the slug defaults to the preset id). The definition is validated first (422 with `issues`). Rewrites the game if the slug exists (200), creates it otherwise (201). Editorial: admin/editor, or an agent with cardsim:manageCatalog.",
      access: "session",
      // Before: `can(manageCatalog)` at the start of the handler, before reading the
      // body. It is the same gate, now declared (and before validating).
      permission: CATALOG,
      sensitive: true,
      input: { body: PublishGame },
      output: PUBLISH_OUTPUT,
    },
    async (c) => {
      const body = (await c.req.json().catch(() => null)) as {
        slug?: string;
        definition?: GameDefinition;
        /** Alternative to `definition`: the id of a kon preset. */
        preset?: string;
      } | null;

      // Only OWN presets: `PRESETS["__proto__"]` is `Object.prototype`,
      // which is not a game (and used to reach the validator as if it were).
      const preset =
        body?.preset && Object.hasOwn(PRESETS, body.preset) ? PRESETS[body.preset] : undefined;
      const definition = body?.preset ? preset : body?.definition;
      const slug = body?.slug ?? (body?.preset ? body.preset : undefined);
      if (!slug || !definition) {
        return c.json({ error: "`slug` and `definition` (or `preset`) are required" }, 400);
      }

      /**
       * `validateGameDefinition` takes the SHAPE for granted (that `zones` is a list,
       * that `deckRules` exist…) and checks coherence. A definition without that
       * shape used to blow up inside (`def.zones is not iterable`) and come out as a 500;
       * it is an invalid definition, and it is reported like the others.
       */
      let errors: string[];
      try {
        errors = validateGameDefinition(definition);
      } catch {
        errors = [
          "The definition does not have the shape of a game (zones, resources, deckRules, players, phases…)",
        ];
      }
      // The name goes to a NOT NULL column: without it, sign-up was a 500.
      if (typeof definition.name !== "string" || !definition.name) {
        errors.push("The definition needs `name`");
      }
      if (errors.length) return c.json({ error: "Invalid definition", issues: errors }, 422);

      const existing = await games().filter({ slug }).first();
      const values = { slug, name: definition.name, definition, published: "published" };
      const row = existing
        ? (
            await games()
              .filter({ id: existing.id })
              .update({ ...values, updatedAt: new Date() })
          )[0]
        : await games().create(values);

      return c.json({ data: row }, existing ? 200 : 201);
    }
  );

  /**
   * Bulk card import — the door through which a dump of
   * `data/tcg/<game>/cards.kitsuden.json` enters.
   *
   * It is an UPSERT by `(gameId, cardId)`: reimporting a corrected catalog
   * updates, it does not duplicate. Without that, fixing a typo would force deleting the
   * whole game and with it the decks that reference it.
   */
  /**
   * Puts cards into a game's catalog, wherever they come from.
   *
   * Both entries use it —the dump through the body and the sync
   * from a dataset— and that is why it is here and not inside a route: it is
   * the same duplicates, the same unique index and the same batch of 500. Having two
   * copies of this means one of the two forgets to collapse the batch
   * and blows up with the first real catalog.
   */
  async function upsertCards(
    gameId: string,
    inputs: { cardId: string; name: string; imageUrl?: string; data?: Record<string, unknown> }[]
  ) {
    const existing = new Map((await cards().filter({ gameId }).all()).map((r) => [r.cardId, r.id]));

    /**
     * First the BATCH is collapsed by `cardId`, the last one wins.
     *
     * Real catalogs repeat ids: in Palworld, `SOUL-001` comes once
     * for each starter deck. Without this step, both would go to `createMany` and
     * the unique index `(game_id, card_id)` would blow up the entire import —
     * and with it a 400-card dump over two identical rows.
     */
    const batch = new Map<string, typeof cardsimCards.$inferInsert>();
    let skipped = 0;
    for (const card of inputs) {
      if (!card?.cardId || !card?.name) {
        skipped++;
        continue;
      }
      batch.set(card.cardId, {
        gameId,
        cardId: card.cardId,
        name: card.name,
        imageUrl: card.imageUrl ?? null,
        data: card.data ?? {},
      });
    }

    const newOnes: (typeof cardsimCards.$inferInsert)[] = [];
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
    // In batches: a `createMany` of 20,000 rows blows past Postgres's
    // parameter limit.
    for (let i = 0; i < newOnes.length; i += 500) {
      await cards().createMany(newOnes.slice(i, i + 500));
    }
    // The catalog has just changed: the in-memory copy is no longer valid.
    catalogs.delete(gameId);

    return { created: newOnes.length, updated, total: batch.size, skipped };
  }

  app.post(
    "/games/:slug/cards",
    {
      id: "import-cards",
      summary: "Bulk import cards into a game's catalogue",
      description:
        "Upserts cards by `(game, cardId)`: re-importing a corrected catalogue updates, it does not duplicate. Repeated cardIds in the batch collapse (last wins); rows without cardId or name are skipped. Returns created/updated/total/collapsed/skipped. At most 20,000 cards per call (413). Editorial: admin/editor, or an agent with cardsim:manageCatalog.",
      access: "session",
      // Before: `can(manageCatalog)` at the start of the handler (see publish-game).
      permission: CATALOG,
      sensitive: true,
      idempotent: true,
      input: { params: ParamSlug, body: ImportCards },
      output: {
        status: 201,
        schema: withData(
          z
            .object({
              created: z.number(),
              updated: z.number(),
              total: z.number(),
              collapsed: z.number(),
              skipped: z.number(),
            })
            .passthrough()
        ),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_PAYLOAD_TOO_LARGE"],
    },
    async (c) => {
      const game = await games()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!game) return c.json({ error: "Not found" }, 404);

      const body = (await c.req.json().catch(() => null)) as {
        cards?: {
          cardId: string;
          name: string;
          imageUrl?: string;
          data?: Record<string, unknown>;
        }[];
      } | null;
      if (!Array.isArray(body?.cards) || !body.cards.length) {
        return c.json({ error: "`cards` with at least one card is required" }, 400);
      }
      if (body.cards.length > 20_000) return c.json({ error: "Too many cards at once" }, 413);

      const { created, updated, total, skipped } = await upsertCards(game.id, body.cards);

      return c.json(
        {
          data: {
            created,
            updated,
            total,
            // What was collapsed and what was discarded is reported: a silent "imported 398 of
            // 400" is the kind of thing discovered three weeks
            // later, when a card is missing from a deck.
            collapsed: body.cards.length - total - skipped,
            skipped,
          },
        },
        201
      );
    }
  );

  /**
   * Syncs a game's catalog from a CMS dataset.
   * ==========================================================================
   *
   * The alternative was maintaining the cards twice: in the dataset the team
   * edits and in `cardsim_cards`. Two copies of a catalog drift apart as soon as
   * someone fixes a typo in only one, and the simulator ends up
   * playing with the old version with nothing to warn of it.
   *
   * The dataset is read with `readDatasetCatalog`, which is what checks
   * `checkReadAccess`: syncing from another kon cannot be a back door
   * to anyone's private datasets.
   *
   * `idField` is STORED with the game. It is deliberate: `card_id` is what
   * decks reference, and if the next sync chose another field it would
   * create an entire parallel catalog leaving the saved decks orphaned.
   */
  app.post(
    "/games/:slug/sync-catalog",
    {
      id: "sync-catalog",
      summary: "Sync a game's catalogue from a CMS dataset",
      description:
        "Upserts the game's cards from a dataset (`datasetId`, or the one the game already has pinned). `idField` picks the entry field used as cardId and is pinned with the game, so later syncs cannot silently switch it. 404 if the dataset does not exist or you cannot read it (same answer on purpose); 422 if it produced no card. Editorial: admin/editor, or an agent with cardsim:manageCatalog.",
      access: "session",
      // Before: `can(manageCatalog)` at the start of the handler (see publish-game).
      permission: CATALOG,
      sensitive: true,
      idempotent: true,
      input: { params: ParamSlug, body: SyncCatalog },
      output: { schema: withData(Obj) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const user = userOf(c);

      const game = await games()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!game) return c.json({ error: "Not found" }, 404);

      const body = (await c.req.json().catch(() => null)) as {
        datasetId?: string;
        idField?: string | null;
      } | null;

      /**
       * Three provenances, in order: what the request sends, what the game already
       * had pinned, and nothing. With none, it says what is missing, instead of a generic
       * 400 that forces reading the code to know what to send.
       */
      const datasetId = body?.datasetId ?? game.catalogDatasetId ?? null;
      if (!datasetId) {
        return c.json(
          { error: "There is nowhere to get the catalog from: send `datasetId` or pin one on the game" },
          400
        );
      }

      const catalogValue = await readDatasetCatalog(ctx.db.instance, datasetId, user as never);
      // Does not exist and cannot be read give the SAME on purpose: distinguishing them
      // turns this route into an oracle for which datasets exist.
      if (!catalogValue) return c.json({ error: "That dataset does not exist or you cannot read it" }, 404);

      const idField = body?.idField !== undefined ? body.idField : game.catalogIdField;
      const {
        cards: mapped,
        idSource,
        skipped,
      } = cardsFromEntries(catalogValue.entries, {
        idField,
        imageField: catalogValue.imageField,
      });

      if (!mapped.length) {
        return c.json(
          {
            error: "The dataset produced no cards",
            // Without this, a 300-row dataset that yields no cards is a
            // mystery. With this you can see that the id field was empty.
            detail: { entries: catalogValue.entries.length, idSource, skipped: skipped.slice(0, 10) },
          },
          422
        );
      }

      const result = await upsertCards(game.id, mapped);

      // It stays pinned: the next sync does not have to choose again, and
      // above all it cannot choose ANOTHER id field without saying so.
      await games()
        .filter({ id: game.id })
        .update({
          catalogDatasetId: datasetId,
          catalogIdField: idField ?? null,
          updatedAt: new Date(),
        });

      return c.json({
        data: {
          ...result,
          dataset: catalogValue.dataset,
          entries: catalogValue.entries.length,
          idSource,
          imageField: catalogValue.imageField,
          // The discarded ones go with their reason: a silent import is not
          // auditable, and "3 cards are missing" is discovered weeks later.
          skippedDetail: skipped.slice(0, 50),
        },
      });
    }
  );

  /**
   * Generates a sealed pool: N packs of M cards.
   *
   * The seed is the SERVER's and is returned. That is what makes sealed
   * verifiable: a tournament can deal the same pool to everyone, or
   * reconstruct weeks later the one someone got, without storing the list.
   *
   * `slots` describes the pack by rarity (`{"RR":1,"R":1,"U":2,"C":3}`). Without
   * it, the pack is a uniform sampling of the set — which is not the real pack of
   * any game, but serves for testing and does not pretend a distribution that has not
   * been verified.
   */
  app.post(
    "/games/:slug/sealed",
    {
      id: "generate-sealed",
      summary: "Open a sealed pool",
      description:
        'Opens N packs (`packs`, default 6, max 24) of M cards (`packSize`, default 7) from the game\'s catalogue, optionally only from some `sets` and with a per-rarity pack layout (`slots`, e.g. {"R":1,"U":3,"C":3}; at most 30 cards). Returns the server seed so the same pool can be rebuilt. Saves nothing. Any account.',
      access: "session",
      permission: ANY_ACCOUNT,
      readOnly: true,
      // The handler validates the body AFTER looking up the game (404 before
      // 422) and responds with its usual 422 ("Invalid sealed request").
      input: { params: ParamSlug, body: SealedRequest, validatesHandler: true },
      output: {
        schema: withData(
          z.object({ seed: z.number(), packs: z.number(), pool: z.array(z.string()) }).passthrough()
        ),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const game = await games()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!game) return c.json({ error: "Not found" }, 404);

      const parsed = SealedRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        return c.json({ error: "Invalid sealed request", issues: parsed.error.issues }, 422);
      }
      const body = parsed.data;
      const packs = Math.min(24, Math.max(1, body.packs ?? 6));
      const packSize = Math.min(30, Math.max(1, body.packSize ?? 7));
      const seed = body.seed ?? randomInt(0, 2 ** 31);

      let pool = await cards().filter({ gameId: game.id }).orderBy("cardId").all();
      if (body.sets?.length) {
        const wanted = new Set(body.sets);
        pool = pool.filter((card) => wanted.has(String(card.data.set ?? "")));
      }
      if (!pool.length) return c.json({ error: "That game has no cards from those sets" }, 422);

      const byRarity = new Map<string, typeof pool>();
      for (const card of pool) {
        const rarity = String(card.data.rarity ?? "");
        byRarity.set(rarity, [...(byRarity.get(rarity) ?? []), card]);
      }

      const rng = createRng(seed);
      const opened: string[] = [];
      for (let p = 0; p < packs; p++) {
        if (body.slots) {
          for (const [rarity, count] of Object.entries(body.slots)) {
            const bucket = byRarity.get(rarity) ?? [];
            if (!bucket.length) continue;
            for (let i = 0; i < count; i++) {
              opened.push(bucket[Math.floor(rng() * bucket.length)].cardId);
            }
          }
        } else {
          for (let i = 0; i < packSize; i++) {
            opened.push(pool[Math.floor(rng() * pool.length)].cardId);
          }
        }
      }

      return c.json({ data: { seed, packs, pool: opened } });
    }
  );

  // ══ 2. Deck builder ════════════════════════════════════════════════════════

  app.get(
    "/decks",
    {
      id: "list-my-decks",
      summary: "List my decks",
      description:
        "The caller's saved decks, most recently updated first, optionally for one `gameId`. Any account.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { query: query({ gameId: text("Only decks of this game id") }) },
      output: { schema: withData(z.array(Row)) },
    },
    async (c) => {
      const user = userOf(c);
      const gameId = c.req.query("gameId");
      const rows = await decks()
        .filter(gameId ? { ownerId: user?.id ?? "", gameId } : { ownerId: user?.id ?? "" })
        .orderBy("-updatedAt")
        .all();
      return c.json({ data: rows });
    }
  );

  /**
   * It is validated against the game's rules on SAVING, not when starting the
   * game: finding out the deck is illegal with the opponent waiting is the worst
   * way to find out.
   */
  app.post(
    "/decks",
    {
      id: "create-deck",
      summary: "Save a deck",
      description:
        "Saves a deck for a game: `cards` is a flat list of cardIds or a map section → cardIds. It is validated against the game's rules when SAVING (422 with `issues`). The deck is private; it gets a share code. A person with a session, or an agent with cardsim:create.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: SaveDeck },
      output: { status: 201, schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const user = userOf(c);
      // `create` is asked AFTER validating, as before (`h.can` = the
      // policy plus the operation's fine-grained scopes).
      if (!(await h.can({}, "create"))) return c.json({ error: "Forbidden" }, 403);
      const data = input.body as z.infer<typeof SaveDeck>;

      const game = await games().find(data.gameId);
      if (!game) return c.json({ error: "That game does not exist" }, 404);

      const errors = validateDeck(
        game.definition,
        data.cards as DeckInput,
        await loadCatalog(game.id)
      );
      if (errors.length) return c.json({ error: "Invalid deck", issues: errors }, 422);

      const row = await decks().create({
        gameId: data.gameId,
        name: data.name ?? "Deck",
        cards: data.cards,
        ownerId: user?.id ?? null,
        shareId: randomBytes(6).toString("hex"),
      });
      return c.json({ data: row }, 201);
    }
  );

  app.get(
    "/decks/:id",
    {
      id: "get-deck",
      summary: "Get a deck",
      description:
        "A deck by id. Decks are private: only the owner sees it, or whoever brings its share code in `share`. Someone else's deck without the code is a 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: {
        params: ParamId,
        query: query({ share: text("Share code of the deck") }),
      },
      output: { schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const user = userOf(c);
      const deck = await deckFor(c.req.param("id"), c.req.query("share"));
      if (!deck) return c.json({ error: "Not found" }, 404);
      // A deck is personal: in competitive, the opponent's list is truly
      // sensitive information. Only its owner (or whoever has the link) sees it.
      if (deck.ownerId && deck.ownerId !== user?.id && c.req.query("share") !== deck.shareId) {
        return c.json({ error: "Forbidden" }, 403);
      }
      return c.json({ data: deck });
    }
  );

  app.put(
    "/decks/:id",
    {
      id: "update-deck",
      summary: "Rewrite a deck",
      description:
        "Replaces a deck's name and cards, validated again against the game's rules (422 with `issues`). The game cannot change. Owner or admin; 409 if the game no longer exists.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId, body: SaveDeck },
      output: { schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const id = c.req.param("id");
      const deck = await decks().find(id);
      if (!deck) return c.json({ error: "Not found" }, 404);
      if (!(await h.can(deck, "update"))) return c.json({ error: "Forbidden" }, 403);

      const data = input.body as z.infer<typeof SaveDeck>;
      const game = await games().find(deck.gameId);
      if (!game) return c.json({ error: "That game no longer exists" }, 409);

      const errors = validateDeck(
        game.definition,
        data.cards as DeckInput,
        await loadCatalog(game.id)
      );
      if (errors.length) return c.json({ error: "Invalid deck", issues: errors }, 422);

      const [row] = await decks()
        .filter({ id })
        .update({ name: data.name ?? deck.name, cards: data.cards, updatedAt: new Date() });
      return c.json({ data: row });
    }
  );

  app.delete(
    "/decks/:id",
    {
      id: "delete-deck",
      summary: "Delete a deck",
      description: "Deletes a deck. Owner or admin. Cannot be undone.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, _input, h) => {
      const deck = await decks().find(c.req.param("id"));
      if (!deck) return c.json({ error: "Not found" }, 404);
      if (!(await h.can(deck, "delete"))) return c.json({ error: "Forbidden" }, 403);
      await decks().filter({ id: deck.id }).delete();
      return c.body(null, 204);
    }
  );

  /**
   * Paste a list from elsewhere. Returns the parsed deck AND its problems
   * separately: lines that are not understood are shown with their number instead of
   * being silently discarded, which is how you end up with 47 cards without
   * knowing why.
   */
  app.post(
    "/decks/import",
    {
      id: "import-deck",
      summary: "Import a deck list",
      description:
        "Parses a pasted deck list (`format: text`, e.g. `4 BP01-001` or `4 Card Name`, or `ydk`), resolves cards by id or by name, validates it and saves it only if clean (201). Otherwise 422 with the parsed deck, the lines that did not parse, the unknown cards and the rule issues. A person with a session, or an agent with cardsim:create.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: ImportDeck },
      output: { status: 201, schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const user = userOf(c);
      if (!(await h.can({}, "create"))) return c.json({ error: "Forbidden" }, 403);
      const data = input.body as z.infer<typeof ImportDeck>;
      const game = await games().find(data.gameId);
      if (!game) return c.json({ error: "That game does not exist" }, 404);

      const sections = sectionsOf(game.definition);
      const parsed =
        data.format === "ydk" ? parseYdk(data.content) : parseDeckList(data.content, sections);

      /**
       * It is resolved by id AND by NAME.
       *
       * Half the family of games writes its lists by number (`4 BP01-001`) and
       * the other half by name (`4 Ariel - On Human Legs`, which is how a Lorcana
       * list is copied anywhere). Accepting only ids would turn "paste your list"
       * into "retype your list".
       */
      const catalogue = await cards().filter({ gameId: game.id }).all();
      const known = new Set(catalogue.map((r) => r.cardId));
      const byName = new Map(catalogue.map((r) => [r.name.toLowerCase(), r.cardId]));

      const unresolved = new Set<string>();
      for (const [section, list] of Object.entries(parsed.cards)) {
        parsed.cards[section] = list.map((token) => {
          // Without a loaded catalog nothing is resolved: it is accepted as is, which is
          // what it did before there were imported cards.
          if (!known.size || known.has(token)) return token;
          const hit = byName.get(token.toLowerCase());
          if (hit) return hit;
          unresolved.add(token);
          return token;
        });
      }
      const unknown = [...unresolved];
      const issues = validateDeck(game.definition, parsed.cards, await loadCatalog(game.id));

      // It is saved only if clean; otherwise the diagnosis is returned so
      // the builder paints it and the user fixes their list.
      if (parsed.errors.length || unknown.length || issues.length) {
        return c.json(
          {
            error: "The list has problems",
            parsed: parsed.cards,
            lines: parsed.errors,
            unknown,
            issues,
          },
          422
        );
      }

      const row = await decks().create({
        gameId: data.gameId,
        name: data.name ?? "Deck imported",
        cards: parsed.cards,
        ownerId: user?.id ?? null,
        shareId: randomBytes(6).toString("hex"),
      });
      return c.json({ data: row }, 201);
    }
  );

  app.get(
    "/decks/:id/export",
    {
      id: "export-deck",
      summary: "Export a deck as text",
      description:
        "The deck as a plain-text list (`format=ydk` for a YDK file). Same visibility as get-deck: owner, or the share code in `share`.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: {
        params: ParamId,
        query: query({
          share: text("Share code of the deck"),
          format: text("`ydk` for a YDK file; anything else is a text list"),
        }),
      },
      output: { type: "text/plain", description: "The deck list" },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const user = userOf(c);
      const deck = await deckFor(c.req.param("id"), c.req.query("share"));
      if (!deck) return c.json({ error: "Not found" }, 404);
      if (deck.ownerId && deck.ownerId !== user?.id && c.req.query("share") !== deck.shareId) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const game = await games().find(deck.gameId);
      if (!game) return c.json({ error: "That game no longer exists" }, 409);

      const sections = sectionsOf(game.definition);
      const bySection = Array.isArray(deck.cards) ? { [sections[0].id]: deck.cards } : deck.cards;
      const text =
        c.req.query("format") === "ydk"
          ? formatYdk(bySection)
          : formatDeckList(bySection, sections);
      return c.text(text);
    }
  );

  /**
   * Goldfish: shuffles the deck N times and counts.
   *
   * It is what people really look for in a "practice mode": not an opponent,
   * but knowing how often the deck does what it wants. Zero AI — just
   * the engine's seeded shuffle, ten thousand times.
   *
   * It accepts a SAVED deck or a loose one, because the question is asked while
   * building, not afterwards: forcing a save in order to measure would turn
   * the tool into a chore.
   *
   * It returns the seed. With it the exact report is reproduced — and two decks
   * are compared on the SAME hands, which is the only honest comparison.
   */
  app.post(
    "/goldfish",
    {
      id: "simulate-goldfish",
      summary: "Goldfish a deck (opening-hand statistics)",
      description:
        'Shuffles a deck many times (`iterations`, default 10,000, max 50,000) and answers `queries` such as "at least 2 lands by turn 3". Takes a saved deck (`deckId`; yours, or with its code in `share`) or a loose one (`gameId` + `cards`). Returns the seed, so the same report (and the same hands for another deck) can be reproduced. Saves nothing. Public for loose decks.',
      access: "optional",
      readOnly: true,
      input: {
        query: query({ share: text("Share code of `deckId`, if it is not yours") }),
        body: GoldfishRequest,
      },
      output: { schema: withData(Obj) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const user = userOf(c);
      const data = input.body as z.infer<typeof GoldfishRequest>;

      let gameId = data.gameId;
      let deck: DeckInput | undefined = data.cards;

      if (data.deckId) {
        const saved = await deckFor(data.deckId, c.req.query("share"));
        if (!saved) return c.json({ error: "That deck does not exist" }, 404);
        // A deck is personal: measuring it is reading it.
        if (saved.ownerId && saved.ownerId !== user?.id && c.req.query("share") !== saved.shareId) {
          return c.json({ error: "Forbidden" }, 403);
        }
        gameId = saved.gameId;
        deck = saved.cards;
      }

      const game = gameId ? await games().find(gameId) : null;
      if (!game) return c.json({ error: "That game does not exist" }, 404);

      try {
        const report = await goldfishAsync(
          game.definition,
          deck!,
          await loadCatalog(game.id),
          data.queries,
          {
            iterations: data.iterations,
            // Without an explicit seed the server chooses it and returns it: that way the
            // report can be requested again identically.
            seed: data.seed ?? randomInt(0, 2 ** 31),
            onThePlay: data.onThePlay,
            drawsPerTurn: data.drawsPerTurn,
            curveProperty: data.curveProperty,
            sampleHands: data.sampleHands,
            mulliganUnless: data.mulliganUnless,
          }
        );
        return c.json({ data: report });
      } catch (err) {
        const message = err instanceof GoldfishError ? err.message : "Could not simulate";
        return c.json({ error: message }, 422);
      }
    }
  );

  // ══ 3. Rooms ═══════════════════════════════════════════════════════════════

  /** The lobby: public games with a free seat. */
  app.get(
    "/sessions",
    {
      id: "list-rooms",
      summary: "List open public rooms",
      description:
        "The lobby: open public rooms (latest 50), optionally of one `gameId`. Only what is needed to decide to join (seats taken, password or not, spectators) — never decks or the action log. Public.",
      access: "optional",
      input: { query: query({ gameId: text("Only rooms of this game id") }) },
      output: { schema: withData(z.array(Row)) },
    },
    async (c) => {
      const gameId = c.req.query("gameId");
      const rows = await sessions()
        .filter(
          gameId
            ? { status: "open", visibility: "public", gameId }
            : { status: "open", visibility: "public" }
        )
        .orderBy("-createdAt")
        .limit(50)
        .all();
      return c.json({
        // Neither the decks nor the log of a lobby room are ever leaked:
        // only what is needed to decide whether you join.
        data: rows.map((r) => ({
          id: r.id,
          code: r.code,
          gameId: r.gameId,
          name: r.name,
          seats: r.seats.map((s) => (s === null ? null : "taken")),
          hasPassword: Boolean(r.passwordHash),
          allowSpectators: r.allowSpectators,
          createdAt: r.createdAt,
        })),
      });
    }
  );

  app.post(
    "/sessions",
    {
      id: "create-room",
      summary: "Create a room (a game session)",
      description:
        "Opens a room for a game with your deck(s) (`deckIds`, yours). Open seats wait for players (take-seat); `solo: true` seats you everywhere. Optional password, spectators, best-of match and chess clock. The shuffle seed is the server's; `seed` is only accepted in solo (422 otherwise). A person with a session, or an agent with cardsim:create.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: CreateSession },
      output: {
        status: 201,
        schema: withData(
          z
            .object({
              id: z.string(),
              code: z.string().nullable(),
              gameId: z.string(),
              seats: z.array(z.string().nullable()),
              matchId: z.string().nullable(),
            })
            .passthrough()
        ),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const user = userOf(c);
      if (!(await h.can({}, "create"))) return c.json({ error: "Forbidden" }, 403);

      const data = input.body as z.infer<typeof CreateSession>;
      const game = await games().find(data.gameId);
      if (!game) return c.json({ error: "That game does not exist" }, 404);

      if (data.seed !== undefined && !data.solo) {
        return c.json(
          {
            error:
              "The seed can only be set in solo: in a game the server sets it",
          },
          422
        );
      }

      const seatCount = data.seatCount ?? game.definition.players.min;
      const loaded: DeckInput[] = [];
      for (const deckId of data.deckIds) {
        const deck = await decks().find(deckId);
        // A deck is personal (see GET /decks/:id): seating it at a table is
        // reading it card by card. Someone else's and unknown give the same — distinguishing them
        // would be an oracle for which ids exist.
        if (!deck || (deck.ownerId && deck.ownerId !== user?.id)) {
          return c.json({ error: `The deck "${deckId}" does not exist` }, 404);
        }
        if (deck.gameId !== data.gameId) {
          return c.json({ error: `The deck "${deckId}" belongs to another game` }, 422);
        }
        loaded.push(deck.cards);
      }
      // Empty seats start with the creator's deck so the
      // definition validates; on sitting, each player puts in their own.
      const deckList: DeckInput[] = Array.from(
        { length: seatCount },
        (_, i) => loaded[i] ?? loaded[0]
      );

      /**
       * The seed is generated by the SERVER and with a cryptographic RNG. With
       * `Math.random()` a client observing several games could predict
       * the next one — and predicting the seed is knowing the shuffled deck.
       */
      const seed = data.seed ?? randomInt(0, 2 ** 31);
      // Randomness secret except with a fixed seed (solitaire): see cardsim.seed.ts
      const secretRng = data.seed === undefined ? newRandomSecret() : null;

      try {
        // It is created once to validate that the game STARTS. It is discarded: the
        // truth is the actions, and there are none yet.
        replay(
          game.definition,
          deckList,
          seedOf({ seed, secretRng }),
          [],
          await loadCatalog(game.id)
        );
      } catch (err) {
        const message = err instanceof CardSimError ? err.message : "Could not create the game";
        return c.json({ error: message }, 422);
      }

      let matchId: string | null = null;
      if (data.bestOf && data.bestOf > 1) {
        const match = await matches().create({
          gameId: data.gameId,
          bestOf: data.bestOf,
          seats: Array.from({ length: seatCount }, (_, i) => (i === 0 ? (user?.id ?? null) : null)),
          wins: Array.from({ length: seatCount }, () => 0),
        });
        matchId = match.id;
      }

      const row = await sessions().create({
        gameId: data.gameId,
        name: data.name ?? null,
        seed,
        secretRng,
        decks: deckList,
        // In solo all seats are occupied: the rest of the logic does not
        // notice anything, because "you act from your seat" is already satisfied in both.
        seats: Array.from({ length: seatCount }, (_, i) =>
          data.solo || i === 0 ? (user?.id ?? null) : null
        ),
        actions: [],
        status: data.solo ? "playing" : "open",
        // Short, readable code to dictate or paste into a chat.
        code: randomBytes(3).toString("hex").toUpperCase(),
        visibility: data.visibility,
        passwordHash: data.password ? hashPassword(data.password) : null,
        allowSpectators: data.allowSpectators,
        matchId,
        clocks: data.timeControlSeconds
          ? Array.from({ length: seatCount }, () => data.timeControlSeconds! * 1000)
          : null,
        clockStartedAt: data.timeControlSeconds ? new Date() : null,
        incrementMs: data.incrementSeconds * 1000,
        ownerId: user?.id ?? null,
      });

      return c.json(
        { data: { id: row.id, code: row.code, gameId: row.gameId, seats: row.seats, matchId } },
        201
      );
    }
  );

  /**
   * Room code → session id. It is what is typed to enter or to
   * watch a game when someone passes you the code by voice or chat.
   *
   * It returns the id and nothing else: who can sit is still decided by
   * `/join` with its password, and what is seen is still decided by `viewFor`.
   * Knowing the code grants no permission by itself.
   */
  app.get(
    "/rooms/:code",
    {
      id: "find-room-by-code",
      summary: "Find a room by its code",
      description:
        "Short room code → session id, game, status, whether it has a password and allows spectators. Knowing the code grants nothing by itself. Public.",
      access: "optional",
      input: { params: CodeParam },
      output: { schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const session = await sessions()
        .filter({ code: c.req.param("code").toUpperCase() })
        .first();
      if (!session) return c.json({ error: "Not found" }, 404);
      return c.json({
        data: {
          id: session.id,
          gameId: session.gameId,
          status: session.status,
          hasPassword: Boolean(session.passwordHash),
          allowSpectators: session.allowSpectators,
        },
      });
    }
  );

  /** Sit in a room with your deck. */
  app.post(
    "/sessions/:id/join",
    {
      id: "take-seat",
      summary: "Take a seat in a room",
      description:
        "Sits you in an open seat with one of your decks (of the room's game), with the room password if it has one (403 if wrong; rate-limited). The game starts when every seat is taken. 409 if the room is no longer open, the seat is taken or you are already seated.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId, body: JoinSession },
      output: {
        schema: withData(
          z
            .object({
              seat: z.number(),
              seats: z.array(z.string().nullable()),
              status: z.string(),
            })
            .passthrough()
        ),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const user = userOf(c);
      const id = c.req.param("id");
      const session = await sessions().find(id);
      if (!session) return c.json({ error: "Not found" }, 404);
      if (session.status !== "open")
        return c.json({ error: "That game no longer admits players" }, 409);

      const { seat, deckId, password } = input.body as z.infer<typeof JoinSession>;
      if (!verifyPassword(password ?? "", session.passwordHash)) {
        return c.json({ error: "Incorrect password" }, 403);
      }
      if (seat >= session.seats.length) return c.json({ error: "That seat does not exist" }, 400);
      if (session.seats[seat] !== null) return c.json({ error: "That seat is taken" }, 409);
      if (session.seats.includes(user?.id ?? null) && user) {
        return c.json({ error: "You are already seated in this game" }, 409);
      }

      const deck = await decks().find(deckId);
      if (!deck) return c.json({ error: "That deck does not exist" }, 404);
      if (deck.ownerId && deck.ownerId !== user?.id)
        return c.json({ error: "That deck is not yours" }, 403);
      if (deck.gameId !== session.gameId)
        return c.json({ error: "That deck belongs to another game" }, 422);

      const seats = [...session.seats];
      seats[seat] = user?.id ?? null;
      const deckList = [...session.decks];
      deckList[seat] = deck.cards;

      // If there are already actions, changing the deck would rewrite the game: decks
      // are only touched while the table is empty of plays.
      if (session.actions.length) return c.json({ error: "The game has already started" }, 409);

      const full = seats.every((s) => s !== null);
      await sessions()
        .filter({ id })
        .update({
          seats,
          decks: deckList,
          status: full ? "playing" : "open",
          // Sitting changes the DECKS, so the cached state (even the one
          // with zero actions) describes another game.
          stateEpoch: session.stateEpoch + 1,
          updatedAt: new Date(),
        });
      stateCache.forget(id);

      ctx.realtime.broadcast(`cardsim:session:${id}`, { type: "join", seat, full });
      return c.json({ data: { seat, seats, status: full ? "playing" : "open" } });
    }
  );

  // ══ 4. Game ════════════════════════════════════════════════════════════════

  /** Loads the session and rebuilds its state. It is the base read operation. */
  async function loadSession(id: string) {
    const session = await sessions().find(id);
    if (!session) return { error: "Not found" as const, status: 404 as const };
    const game = await games().find(session.gameId);
    if (!game) return { error: "The game no longer exists" as const, status: 409 as const };
    return { session, game };
  }

  /**
   * Closes the game if the active player has run out of time.
   *
   * The clock is NOT in the engine: time is wall-clock and the engine has to
   * be reproducible, so a clock inside would make every replay give a
   * different game. Here it is subtracted against `clockStartedAt` and, on running out,
   * a NORMAL `concede` is sent — which does enter the log, is replayed
   * and does trigger the result by the same path as a manual concession.
   *
   * It is checked on READING as well as on acting: if it were only looked at when sending
   * an action, whoever runs out of time would win just by ceasing to play.
   */
  async function enforceClock(
    session: typeof cardsimSessions.$inferSelect,
    game: typeof cardsimGames.$inferSelect
  ): Promise<number | null> {
    if (!session.clocks || !session.clockStartedAt || session.status === "finished") return null;

    const state = stateCache.stateFor(session, game.definition);
    if (state.result) return null;
    // With a macro stopped, the clock runs on whoever has to DECIDE, not on
    // whoever has the turn: otherwise, the opponent could burn your time by doing nothing more
    // than staring at their discard dialog.
    const active = state.pending?.player ?? state.activePlayer;
    const left = (session.clocks[active] ?? 0) - (Date.now() - session.clockStartedAt.getTime());
    if (left > 0) return null;

    const timeout: Action = { type: "concede", player: active };
    applyAction(state, timeout, seedOf(session));
    const clocks = [...session.clocks];
    clocks[active] = 0;

    await sessions()
      .filter({ id: session.id })
      .update({
        actions: [...session.actions, timeout],
        clocks,
        status: "finished",
        updatedAt: new Date(),
      });
    await finishSession(session.id, state);
    ctx.realtime.broadcast(`cardsim:session:${session.id}`, { type: "timeout", seat: active });
    return active;
  }

  /** Milliseconds remaining per seat RIGHT NOW, to paint them on the table. */
  function clocksNow(
    session: typeof cardsimSessions.$inferSelect,
    activePlayer: number
  ): number[] | null {
    if (!session.clocks) return null;
    if (!session.clockStartedAt || session.status === "finished") return session.clocks;
    const elapsed = Date.now() - session.clockStartedAt.getTime();
    return session.clocks.map((ms, i) => (i === activePlayer ? Math.max(0, ms - elapsed) : ms));
  }

  const seatOf = (seats: (string | null)[], user: AuthzUser | null) =>
    user ? seats.findIndex((s) => s !== null && s === user.id) : -1;

  /**
   * The game state FOR whoever asks.
   *
   * It never returns the full state: it returns `viewFor(seat)`. The opponent's
   * hand travels as "5 cards" without identities, and the deck order does not travel.
   * A client that reads all its traffic knows nothing it would not see at a table.
   */
  app.get(
    "/sessions/:id",
    {
      id: "get-session",
      summary: "Get the table as you may see it",
      description:
        "The game state FOR the caller: a seated player gets their seat's view (own hand visible, opponents' hands as counts, deck order never), anyone else the spectator view with no secrets (403 if the room has no spectators). Also the definition, action count, pending undo, clocks; reading also enforces the clock (`timedOut`).",
      access: "optional",
      input: { params: ParamId },
      output: {
        schema: z
          .object({ data: Obj, seat: z.number().nullable(), actionCount: z.number() })
          .passthrough(),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const first = await loadSession(c.req.param("id"));
      if ("error" in first) return c.json({ error: first.error }, first.status);

      // Looking at the table is also when it is discovered that someone has run out of
      // time: if it were only checked on acting, ceasing to play would be winning.
      const timedOut = await enforceClock(first.session, first.game);
      const loaded = timedOut === null ? first : await loadSession(c.req.param("id"));
      if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);
      const { session, game } = loaded;

      const user = userOf(c);
      const seat = seatOf(session.seats, user);
      // Whoever does not occupy a seat is a spectator: sees what is public and no secret.
      if (seat === -1 && !session.allowSpectators) {
        return c.json({ error: "This game does not admit spectators" }, 403);
      }

      // Incremental: if we already had the state at action N and they are at N+3,
      // three are applied, not three hundred.
      const state = stateCache.stateFor(session, game.definition);
      return c.json({
        data: viewFor(state, seat === -1 ? null : seat),
        definition: game.definition,
        seat: seat === -1 ? null : seat,
        actionCount: session.actions.length,
        undoRequest: session.undoRequest ?? null,
        matchId: session.matchId,
        status: session.status,
        clocks: clocksNow(session, state.activePlayer),
        timedOut,
      });
    }
  );

  /**
   * Sends an action. **It is applied before being stored**: if it is illegal, it does not enter
   * the log. The log only contains what happened — that is the property
   * that makes the replay reliable.
   */
  app.post(
    "/sessions/:id/action",
    {
      id: "send-action",
      summary: "Play an action at the table",
      description:
        "Applies one action from YOUR seat (`seat` must be yours; the action's player is forced to it). Illegal actions, actions that would reveal an opponent's hidden cards and late actions (clock out) are a 409 and never enter the log. Returns your new view, the action count, the result and the clocks.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId, body: SubmitAction },
      output: { schema: z.object({ data: Obj, actionCount: z.number() }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const id = c.req.param("id");
      const loaded = await loadSession(id);
      if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);
      const { session, game } = loaded;

      const user = userOf(c);
      const { seat, action } = input.body as z.infer<typeof SubmitAction>;

      // One only acts from one's own seat: without this, a player could
      // send actions "of the opponent" and empty their hand.
      if (!user || session.seats[seat] !== user.id) {
        return c.json({ error: "That seat is not yours" }, 403);
      }

      // Time is checked BEFORE applying: a play that arrives late arrives
      // late, even if the packet was on its way.
      const timedOut = await enforceClock(session, game);
      if (timedOut !== null) {
        return c.json({ error: `Player ${timedOut + 1} ran out of time`, timedOut }, 409);
      }

      // And the action declares its player: the checked seat is forced instead
      // of trusting the one in the body.
      const submitted = { ...action, player: seat } as unknown as Action;

      try {
        const state = stateCache.stateFor(session, game.definition);
        // The customs check: what arrives over the network cannot uncover the opponent's secrets
        // (looking at their hand, moving their hidden card to the table…). See `checkSecrecy`.
        checkSecrecy(state, submitted);
        // Whose time THIS play is charged to: whoever had to decide if
        // there was a macro stopped, and if not, whoever has the turn.
        const wasActive = state.pending?.player ?? state.activePlayer;
        applyAction(state, submitted, seedOf(session));

        // It is charged to whoever HAD the turn, not whoever acts: in most
        // games the opponent also plays on your turn, and charging them
        // would stop their clock while you think.
        const clocks = clocksNow(session, wasActive);
        if (clocks && submitted.type === "endTurn") {
          clocks[wasActive] += session.incrementMs;
        }

        const actions = [...session.actions, submitted];
        await sessions()
          .filter({ id })
          .update({
            actions,
            // A new action invalidates any pending undo: it was requested
            // to go back to a point that is no longer the end.
            undoRequest: null,
            status: state.result ? "finished" : "playing",
            clocks,
            clockStartedAt: clocks ? new Date() : null,
            updatedAt: new Date(),
          });

        // The ALREADY advanced state is stored: the next read repeats nothing.
        stateCache.remember(session.id, session.stateEpoch, actions.length, state);

        if (state.result) await finishSession(session.id, state);

        // It is broadcast to the table: each client recomputes ITS view. The action is
        // sent, not the state — it is what makes synchronization cheap.
        ctx.realtime.broadcast(`cardsim:session:${id}`, { type: "action", action: submitted });

        return c.json({
          data: viewFor(state, seat),
          actionCount: actions.length,
          result: state.result,
          clocks,
        });
      } catch (err) {
        const message = err instanceof CardSimError ? err.message : "Illegal action";
        return c.json({ error: message }, 409);
      }
    }
  );

  /**
   * Undo. With event sourcing it is TRUNCATING the list: no inverse
   * actions or intermediate states are needed.
   *
   * One player requests it and the other accepts, because undoing changes information
   * the opponent has already seen — leaving it unilateral would turn "I undo" into "I look at your
   * reaction and rethink".
   */
  app.post(
    "/sessions/:id/undo",
    {
      id: "request-undo",
      summary: "Ask to undo back to an action count",
      description:
        "Truncates the game back to `toActionCount` actions. Solo games undo at once; with an opponent it is a request (`pending: true`) that applies when the other seat asks for the same count. Seated players only; not on finished games (409).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId, body: UndoRequest },
      output: {
        schema: z.object({ data: Obj }).passthrough(),
        description: "`data` is `{ pending, toActionCount }` for a request, or your new view",
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const id = c.req.param("id");
      const loaded = await loadSession(id);
      if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);
      const { session, game } = loaded;

      const user = userOf(c);
      const seat = seatOf(session.seats, user);
      if (seat === -1) return c.json({ error: "You are not seated in this game" }, 403);

      // A finished game is not undone: `finishSession` would add the
      // win to the match again and move the Elo (earlier audit).
      if (session.status === "finished") {
        return c.json({ error: "The game has already ended" }, 409);
      }

      const { toActionCount } = input.body as z.infer<typeof UndoRequest>;
      if (toActionCount >= session.actions.length) {
        return c.json({ error: "There is nothing to undo" }, 422);
      }

      const occupied = session.seats.filter((s) => s !== null).length;
      const pending = session.undoRequest;
      // In solo (or if the other seat accepts) it is applied immediately.
      const approved =
        occupied <= 1 ||
        (pending && pending.by !== seat && pending.toActionCount === toActionCount);

      if (!approved) {
        await sessions()
          .filter({ id })
          .update({ undoRequest: { by: seat, toActionCount } });
        ctx.realtime.broadcast(`cardsim:session:${id}`, {
          type: "undoRequest",
          by: seat,
          toActionCount,
        });
        return c.json({ data: { pending: true, toActionCount } });
      }

      const actions = session.actions.slice(0, toActionCount);
      // It is replayed BEFORE storing: if the truncated prefix were not playable,
      // storing it would leave the game broken with no way back.
      let state: SessionState;
      try {
        state = replay(game.definition, session.decks, seedOf(session), actions);
      } catch {
        return c.json({ error: "Cannot undo back to that point" }, 422);
      }

      // Undo TRUNCATES: the cached prefix no longer describes this game. The
      // epoch goes up (which invalidates any copy, including other processes') and
      // this one's is discarded.
      await sessions()
        .filter({ id })
        .update({
          actions,
          undoRequest: null,
          status: "playing",
          result: null,
          finishedAt: null,
          stateEpoch: session.stateEpoch + 1,
          updatedAt: new Date(),
        });
      stateCache.forget(id);
      ctx.realtime.broadcast(`cardsim:session:${id}`, { type: "undo", toActionCount });
      return c.json({ data: viewFor(state, seat), actionCount: actions.length });
    }
  );

  app.delete(
    "/sessions/:id/undo",
    {
      id: "cancel-undo",
      summary: "Cancel the pending undo request",
      description: "Clears the room's pending undo request. Seated players only.",
      access: "session",
      permission: ANY_ACCOUNT,
      // Withdrawing an undo request destroys nothing in the game.
      sensitive: false,
      input: { params: ParamId },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const id = c.req.param("id");
      const session = await sessions().find(id);
      if (!session) return c.json({ error: "Not found" }, 404);
      const seat = seatOf(session.seats, userOf(c));
      if (seat === -1) return c.json({ error: "You are not seated in this game" }, 403);
      await sessions().filter({ id }).update({ undoRequest: null });
      ctx.realtime.broadcast(`cardsim:session:${id}`, { type: "undoCancelled" });
      return c.body(null, 204);
    }
  );

  /**
   * The complete replay. Only when the game has ended: while it is being played,
   * the action list would leak what a spectator must not see — shuffling
   * and drawing do not appear, but "put card 34 face down" does, and with the whole
   * list the real state is rebuilt without going through `viewFor`.
   */
  app.get(
    "/sessions/:id/replay",
    {
      id: "get-replay",
      summary: "Get the full replay of a finished game",
      description:
        "Definition, every deck, seed, the random sub-seeds used and the whole action log, to replay the game. Only once the game is finished (409 before); a room without spectators only shows it to its players (403).",
      access: "optional",
      input: { params: ParamId },
      output: { schema: withData(Obj) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const loaded = await loadSession(c.req.param("id"));
      if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);
      const { session, game } = loaded;
      if (session.status !== "finished") {
        return c.json({ error: "The replay is published when the game ends" }, 409);
      }
      // The replay carries everyone's whole DECKS. A room without spectators is
      // private afterwards too: only those who played see it.
      if (!session.allowSpectators && seatOf(session.seats, userOf(c)) === -1) {
        return c.json({ error: "This game does not admit spectators" }, 403);
      }
      return c.json({
        data: {
          definition: game.definition,
          decks: session.decks,
          seed: session.seed,
          // Games with a secret: the subseeds used (the secret does not leave).
          // The client replays with `(cursor) => subseeds[cursor]`.
          subseeds: usedSubseeds(
            seedOf(session),
            replay(
              game.definition,
              session.decks,
              seedOf(session),
              session.actions,
              await loadCatalog(game.id)
            ).rngCursor
          ),
          actions: session.actions,
          result: session.result,
        },
      });
    }
  );

  /** Rematch: same table, new seed. In a match, it counts as the next game. */
  app.post(
    "/sessions/:id/rematch",
    {
      id: "request-rematch",
      summary: "Start a rematch",
      description:
        "Same table, same decks and seats, new seed. In an undecided match it counts as the next game; after a decided match it is a friendly game. Seated players of a finished game only (409 if not finished).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId },
      output: {
        status: 201,
        schema: withData(z.object({ id: z.string(), gameIndex: z.number() }).passthrough()),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const session = await sessions().find(c.req.param("id"));
      if (!session) return c.json({ error: "Not found" }, 404);
      const user = userOf(c);
      const seat = seatOf(session.seats, user);
      if (seat === -1) return c.json({ error: "You are not seated in this game" }, 403);
      if (session.status !== "finished")
        return c.json({ error: "The game has not ended" }, 409);

      // A rematch of an ALREADY decided match does not add to that match: if it did,
      // every rematch would move the Elo again (two accounts in agreement could
      // inflate their ranking through rematches and concessions).
      const parent = session.matchId ? await matches().find(session.matchId) : null;
      const matchId = parent && parent.status !== "finished" ? parent.id : null;

      const row = await sessions().create({
        gameId: session.gameId,
        name: session.name,
        seed: randomInt(0, 2 ** 31),
        secretRng: newRandomSecret(),
        decks: session.decks,
        seats: session.seats,
        actions: [],
        visibility: session.visibility,
        passwordHash: session.passwordHash,
        allowSpectators: session.allowSpectators,
        matchId,
        gameIndex: matchId ? session.gameIndex + 1 : 0,
        status: "playing",
        ownerId: session.ownerId,
      });
      ctx.realtime.broadcast(`cardsim:session:${session.id}`, {
        type: "rematch",
        sessionId: row.id,
      });
      return c.json({ data: { id: row.id, gameIndex: row.gameIndex } }, 201);
    }
  );

  /**
   * Closes the game: freezes the result, adds to the match and moves the Elo.
   *
   * The result is STORED even though it is derivable from the actions: reading
   * a score should not cost replaying the whole game, and a ranking
   * queries thousands.
   */
  async function finishSession(sessionId: string, state: SessionState): Promise<void> {
    const session = await sessions().find(sessionId);
    if (!session || session.result) return;

    await sessions()
      .filter({ id: sessionId })
      .update({ result: state.result, finishedAt: new Date(), status: "finished" });

    if (!session.matchId) return;
    const match = await matches().find(session.matchId);
    // A closed match has already scored: it neither adds wins nor moves the Elo again.
    if (!match || match.status === "finished") return;

    const wins = [...match.wins];
    for (const seat of state.result?.winners ?? []) wins[seat] = (wins[seat] ?? 0) + 1;
    const needed = Math.floor(match.bestOf / 2) + 1;
    const decided = wins.some((w) => w >= needed);
    await matches()
      .filter({ id: match.id })
      .update({ wins, status: decided ? "finished" : "open", updatedAt: new Date() });

    if (!decided || !match.rated) return;

    // Elo only on closing the MATCH, not each game: in a Bo3, scoring all
    // three would give triple weight to a single encounter.
    const [a, b] = match.seats;
    if (!a || !b) return;
    // In series: the request is ONE transaction (one connection), and a
    // `Promise.all` over it is not allowed (docs/kons/README.md).
    const rows: (typeof cardsimRatings.$inferSelect)[] = [];
    for (const userId of [a, b]) {
      const found = await ratings().filter({ gameId: match.gameId, userId }).first();
      rows.push(found ?? (await ratings().create({ gameId: match.gameId, userId })));
    }
    const gamesOf = (r: (typeof rows)[number]) => r.wins + r.losses + r.draws;
    const score = wins[0] > wins[1] ? 1 : wins[0] < wins[1] ? 0 : 0.5;
    const next = applyElo(
      { rating: rows[0].rating, games: gamesOf(rows[0]) },
      { rating: rows[1].rating, games: gamesOf(rows[1]) },
      score
    );

    await ratings()
      .filter({ id: rows[0].id })
      .update({
        rating: next.a,
        wins: rows[0].wins + (score === 1 ? 1 : 0),
        losses: rows[0].losses + (score === 0 ? 1 : 0),
        draws: rows[0].draws + (score === 0.5 ? 1 : 0),
        updatedAt: new Date(),
      });
    await ratings()
      .filter({ id: rows[1].id })
      .update({
        rating: next.b,
        wins: rows[1].wins + (score === 0 ? 1 : 0),
        losses: rows[1].losses + (score === 1 ? 1 : 0),
        draws: rows[1].draws + (score === 0.5 ? 1 : 0),
        updatedAt: new Date(),
      });
  }

  app.get(
    "/matches/:id",
    {
      id: "get-match",
      summary: "Get a match (best-of series)",
      description:
        "A match with its wins per seat and the games played (id, index, status, result). Public.",
      access: "optional",
      input: { params: ParamId },
      output: { schema: withData(Row) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const match = await matches().find(c.req.param("id"));
      if (!match) return c.json({ error: "Not found" }, 404);
      const played = await sessions().filter({ matchId: match.id }).orderBy("gameIndex").all();
      return c.json({
        data: {
          ...match,
          games: played.map((s) => ({
            id: s.id,
            gameIndex: s.gameIndex,
            status: s.status,
            result: s.result,
          })),
        },
      });
    }
  );

  // ══ 5. Matchmaking and ranking ═════════════════════════════════════════════

  /**
   * Matchmaking queue. On entering it checks whether someone is already waiting for the
   * same game: if so, the game is created with both and they are notified.
   *
   * It pairs with the OLDEST, not the closest in Elo, on purpose:
   * with few players in the queue, looking for an even opponent leaves people waiting
   * for no one. When the queue is large, this is the place to narrow the range.
   */
  app.post(
    "/queue",
    {
      id: "join-queue",
      summary: "Join the matchmaking queue",
      description:
        "Queues you for a game with one of your decks. If someone else is already waiting for the same game (and rated flag), a best-of-1 game starts at once (201 with the session and your seat); otherwise you wait (202, the other player is notified when matched). A person with a session, or an agent with cardsim:create.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: JoinQueue },
      output: QUEUE_OUTPUT,
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      // Queuing requires real identity: the game that comes out of here
      // scores, and a seat without an `id` cannot be paired or ranked.
      const userId = userOf(c)?.id;
      if (!userId) return c.json({ error: "Unauthorized" }, 401);
      if (!(await h.can({}, "create"))) return c.json({ error: "Forbidden" }, 403);
      const data = input.body as z.infer<typeof JoinQueue>;

      const deck = await decks().find(data.deckId);
      if (!deck || (deck.ownerId && deck.ownerId !== userId)) {
        return c.json({ error: "That deck is not yours" }, 403);
      }
      if (deck.gameId !== data.gameId) return c.json({ error: "That deck belongs to another game" }, 422);
      const game = await games().find(data.gameId);
      if (!game) return c.json({ error: "That game does not exist" }, 404);

      const waiting = await queue()
        .where(and(eq(cardsimQueue.gameId, data.gameId), eq(cardsimQueue.rated, data.rated))!)
        .orderBy("createdAt")
        .all();
      const rival = waiting.find((w) => w.userId !== userId);

      if (!rival) {
        await queue().filter({ userId }).delete();
        await queue().create({
          gameId: data.gameId,
          userId,
          deckId: data.deckId,
          rated: data.rated,
        });
        return c.json({ data: { waiting: true } }, 202);
      }

      // The OPPONENT's deck: matchmaking is exactly what makes two people play
      // with decks the other cannot read. As system, after having
      // checked that one's own belongs to whoever asks.
      const rivalDeck = await asSystem(() => decks().find(rival.deckId));
      if (!rivalDeck) {
        // Their deck disappeared while they waited: they are removed from the queue instead of
        // creating a game that cannot start.
        await queue().filter({ id: rival.id }).delete();
        return c.json({ error: "Try again: the opponent no longer had a valid deck" }, 409);
      }

      const seed = randomInt(0, 2 ** 31);
      const secretRng = newRandomSecret();
      const deckList: DeckInput[] = [rivalDeck.cards, deck.cards];
      try {
        replay(
          game.definition,
          deckList,
          seedOf({ seed, secretRng }),
          [],
          await loadCatalog(game.id)
        );
      } catch (err) {
        return c.json(
          { error: err instanceof CardSimError ? err.message : "Could not create the game" },
          422
        );
      }

      const match = await matches().create({
        gameId: data.gameId,
        bestOf: 1,
        seats: [rival.userId, userId],
        wins: [0, 0],
        rated: data.rated,
      });
      const session = await sessions().create({
        gameId: data.gameId,
        seed,
        secretRng,
        decks: deckList,
        seats: [rival.userId, userId],
        actions: [],
        visibility: "public",
        matchId: match.id,
        status: "playing",
        ownerId: rival.userId,
      });
      await queue().filter({ id: rival.id }).delete();
      await queue().filter({ userId }).delete();

      ctx.realtime.sendToUser(rival.userId, {
        type: "cardsim:matched",
        sessionId: session.id,
        seat: 0,
      });
      return c.json({ data: { sessionId: session.id, seat: 1, matchId: match.id } }, 201);
    }
  );

  app.delete(
    "/queue",
    {
      id: "leave-queue",
      summary: "Leave the matchmaking queue",
      description: "Removes you from every queue. Any account.",
      access: "session",
      permission: ANY_ACCOUNT,
      // Leaving the queue destroys nothing.
      sensitive: false,
      output: { status: 204 },
    },
    async (c) => {
      const userId = userOf(c)?.id;
      if (!userId) return c.json({ error: "Unauthorized" }, 401);
      await queue().filter({ userId }).delete();
      return c.body(null, 204);
    }
  );

  app.get(
    "/ratings/:slug",
    {
      id: "get-ranking",
      summary: "Get a game's Elo leaderboard",
      description: "Top 100 ratings of a game (rating, wins, losses, draws per user). Public.",
      access: "optional",
      input: { params: ParamSlug },
      output: { schema: withData(z.array(Row)) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const game = await games()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!game) return c.json({ error: "Not found" }, 404);
      const board = await ratings().filter({ gameId: game.id }).orderBy("-rating").limit(100).all();
      return c.json({ data: board });
    }
  );

  return app.ops;
}

/**
 * Every operation of the kon: the simulator's, then the showcase's (`/showcase/...`) and the hand
 * generator's (`/hands/...`). Their paths do not overlap, so the order between blocks does not
 * decide any match.
 */
export function allOperations(ctx: KonContext): AnyOperation[] {
  return [...cardsimOperations(ctx), ...deckshowOperations(ctx), ...handlabOperations(ctx)];
}

/** The kon's router (used by tests and whoever mounts it by hand). */
export function createKonCardsim(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, allOperations(ctx), ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`cardsimOperations`, `deckshowOperations`, `handlabOperations`), with its OpenAPI, its MCP
 * tool and its fine-grained scope `kon:cardsim:<id>`.
 */
export const kon = defineKonSdk({
  id: KON_ID,
  name: "CardSim",
  version: manifest.version,
  description:
    "Card simulator builder: data-defined games, rooms, matches, replay and ranking, a deck showcase and a hand generator",
  icon: "Layers",
  mountPath: "/api/cardsim",
  operations: (ctx: KonContext) => allOperations(ctx),

  // Sitting in a private room checks its password: without a brake,
  // passwords are tried at API speed. The quota is per room and client (the
  // key carries the path with the id). fail-closed: with Valkey down it counts in
  // memory and, if it cannot do that either, rejects rather than allow unlimited guessing.
  rateLimits: [
    {
      path: "/sessions/:id/join",
      limit: 10,
      window: 300,
      message: "Too many attempts to enter this room. Wait a few minutes.",
      failClosed: true,
    },
    // The hand generator's dealing and simulating is public and EXPENSIVE: a goldfish is up to
    // 50,000 hands. Without a brake, anyone can occupy the API's CPU with a loop of requests.
    { path: "/hands/goldfish", limit: 20, window: 60, message: "Too many simulations in a row." },
    { path: "/hands/hands", limit: 60, window: 60 },
    { path: "/hands/datasets/:slug/random-deck", limit: 60, window: 60 },
  ],

  tables: konTables,

  // kon.json `admin` is the one list of admin views; the definition copies it.
  admin: {
    category: manifest.admin.category as "tools",
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid",
      title: v.title,
      table: v.table,
    })),
  },

  dependencies: { kons: [], core: ["auth"] },

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info(
        "🃏 CardSim ready — deterministic sessions with replay, rooms and ranking; showcase at /showcase, hand generator at /hands"
      );
    },
  },
});

export default kon;
