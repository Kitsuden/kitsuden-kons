/**
 * @kitsuden/kon-autobattler
 * ============================================================================
 *
 * Autobattler compositions: units, traits with thresholds, items,
 * augments and board. Designed for TFT, but the engine does not know which game it is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS KON BRINGS THAT NO OTHER HAD
 *
 * `kon-tierlist` knows how to sort things into tiers and `kon-character-builder` knows how to build a
 * character with slots and formulas. Neither knows the one operation
 * that defines an autobattler: **counting how many DISTINCT units share a
 * trait and translating it into a threshold**. That is not a slot or a modifier — it is
 * something that emerges from the set, and it is what is computed here.
 *
 * Meta statistics (average placement, top 4) **are not produced by this
 * kon**: they are stored with their provenance in `stats_source` because they come from
 * your own game ingestion, not from a local calculation. Pretending otherwise
 * would be inventing the authority of a number.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomBytes } from "node:crypto";

import {
  repo,
  can,
  defineKonSdk,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq, ilike } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { compIsFull, compSummary, suggestUnits, traitPlan } from "./autobattler.builder.js";
import {
  activateTraits,
  compCost,
  componentsOf,
  craftableFrom,
  onlyActive,
  validateComp,
} from "./autobattler.engine.js";
import "./autobattler.policy.js";
import { autobattlerComps, autobattlerEntities, autobattlerSets } from "./autobattler.schema.js";
import { ANY_ACCOUNT, KON_ID, registry } from "./operations.js";
import type {
  AugmentDefinition,
  Comp,
  ItemDefinition,
  SetDefinition,
  TraitDefinition,
  UnitDefinition,
} from "./autobattler.types.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./autobattler.engine.js";
export * from "./autobattler.schema.js";
export * from "./autobattler.types.js";

// ── Input ────────────────────────────────────────────────────────────────────

const Rules = z.object({
  boardRows: z.number().int().min(1).max(20),
  boardCols: z.number().int().min(1).max(20),
  itemsPerUnit: z.number().int().min(0).max(10),
  teamSizeByLevel: z.record(z.string(), z.number().int().min(0).max(30)),
  augmentSlots: z.number().int().min(0).max(10),
  costs: z.array(z.number().int().min(0).max(20)).max(20),
});

const Entity = z.object({
  kind: z.enum(["unit", "trait", "item", "augment"]),
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  // It ends up in a `src`: only http(s) or own path, never `javascript:`/`data:`.
  icon: z
    .string()
    .max(600)
    .refine((v) => /^(https?:\/\/|\/)/i.test(v), {
      message: "The icon must be http(s) or /path",
    })
    .nullish(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const ImportSet = z.object({
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "The slug must be lowercase letters, numbers and hyphens"),
  name: z.string().min(1).max(120),
  game: z.string().min(1).max(40).default("tft"),
  source: z.string().max(300).optional(),
  patch: z.string().max(40).optional(),
  current: z.boolean().default(false),
  rules: Rules,
  entities: z.array(Entity).min(1).max(20_000),
});

const SlotSchema = z.object({
  unitId: z.string().min(1).max(120),
  row: z.number().int().min(0).max(20),
  col: z.number().int().min(0).max(20),
  items: z.array(z.string().min(1)).max(10).optional(),
  extraTraits: z.array(z.string().min(1)).max(6).optional(),
  star: z.number().int().min(1).max(3).optional(),
  core: z.boolean().optional(),
});

const CompBody = z.object({
  slots: z.array(SlotSchema).max(30),
  level: z.number().int().min(1).max(15).optional(),
  augments: z.array(z.string().min(1)).max(10).optional(),
  carousel: z.array(z.string().min(1)).max(12).optional(),
});

const AnalyseBody = CompBody.extend({ setSlug: z.string().min(1) });

const TraitPlanBody = AnalyseBody.extend({ traitId: z.string().min(1).max(120) });

const SuggestBody = AnalyseBody.extend({
  limit: z.number().int().min(1).max(50).optional(),
  costs: z.array(z.number().int().min(1).max(10)).max(6).optional(),
  traitId: z.string().min(1).max(120).optional(),
  ignoreLevel: z.boolean().optional(),
});

const SaveComp = z.object({
  setSlug: z.string().min(1),
  title: z.string().min(3).max(120),
  description: z.string().max(8000).optional(),
  tags: z.array(z.string().min(1).max(30)).max(8).default([]),
  slots: z.array(SlotSchema).min(1).max(30),
  level: z.number().int().min(1).max(15).optional(),
  augments: z.array(z.string().min(1)).max(10).default([]),
  carousel: z.array(z.string().min(1)).max(12).default([]),
});

const RankComp = z.object({
  tier: z.string().max(4).nullish(),
  hide: z.boolean().optional(),
  stats: z.record(z.string(), z.number()).nullish(),
  statsSource: z.string().max(200).nullish(),
});

const CraftBody = z.object({
  setSlug: z.string().min(1),
  components: z.array(z.string().min(1)).min(1).max(12),
});

// ── Parameters, query and outputs (OpenAPI and MCP) ─────────────────────────
//
// Parameters are declared as text: a slug or id that does not exist is a 404
// from the handler, not a 422. Outputs are loose on purpose (`passthrough`):
// they are database rows and engine results, which grow field by field.

const ParamSlug = z.object({ slug: z.string().describe("Set slug") });
const ParamKind = z.object({
  slug: z.string().describe("Set slug"),
  kind: z.string().describe("units | traits | items | augments (anything else is a 404)"),
});
const ObjectParam = z.object({
  slug: z.string().describe("Set slug"),
  id: z.string().describe("Item id inside the set"),
});
const ParamComp = z.object({ slug: z.string().describe("Comp slug") });
const ParamId = z.object({ id: z.string().describe("Comp id (autobattler_comps)") });

/** Free-text query: whatever is not declared is ignored, as always. */
const text = (that: string) => z.string().optional().describe(that);

/** A database row: it carries `id`, and the rest as is. */
const Row = z.object({ id: z.string() }).passthrough();
/** Result of an engine: an object. */
const Obj = z.record(z.string(), z.unknown());

function slugify(title: string): string {
  const base = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "comp"}-${randomBytes(3).toString("hex")}`;
}

export function autobattlerOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const db = ctx.db.instance;

  const sets = () => repo(autobattlerSets, { db });
  const entities = () => repo(autobattlerEntities, { db });
  const comps = () => repo(autobattlerComps, { db });

  const userOf = (c: { get: (k: string) => unknown }) =>
    (c.get("user") ?? null) as AuthzUser | null;

  /**
   * The whole set, assembled in memory and cached.
   *
   * The engine needs ALL the units and traits to count synergies, so
   * each calculation would ask for 4000 rows. A set is editorial data: it changes
   * when someone imports a patch, not between two requests.
   */
  const cache = new Map<string, { at: number; set: SetDefinition }>();
  const TTL_MS = 120_000;

  async function loadSet(slug: string): Promise<SetDefinition | null> {
    const hit = cache.get(slug);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.set;

    const row = await sets().filter({ slug }).first();
    if (!row) return null;
    const all = await entities().filter({ setId: row.id }).all();

    const of = (kind: string) => all.filter((e) => e.kind === kind);
    const set: SetDefinition = {
      id: row.slug,
      name: row.name,
      rules: row.rules,
      units: of("unit").map((e) => ({
        id: e.entityId,
        name: e.name,
        icon: e.icon,
        ...(e.data as object),
      })) as UnitDefinition[],
      traits: of("trait").map((e) => ({
        id: e.entityId,
        name: e.name,
        icon: e.icon,
        ...(e.data as object),
      })) as TraitDefinition[],
      items: of("item").map((e) => ({
        id: e.entityId,
        name: e.name,
        icon: e.icon,
        ...(e.data as object),
      })) as ItemDefinition[],
      augments: of("augment").map((e) => ({
        id: e.entityId,
        name: e.name,
        icon: e.icon,
        ...(e.data as object),
      })) as AugmentDefinition[],
    };
    cache.set(slug, { at: Date.now(), set });
    return set;
  }

  // Looking and CALCULATING is public: checking synergies is what people come for.
  // What writes declares `access: "session"`; the rest, `"optional"` (the user is
  // only filled in if there is one). Before it was an `app.use("*", optionalAuth)`.

  // ══ 1. Sets ════════════════════════════════════════════════════════════════

  app.get(
    "/sets",
    {
      id: "list-sets",
      summary: "List autobattler sets",
      description:
        "Every imported set (e.g. a TFT set), the current one of each game first, then by name; `game` filters by game. Public.",
      access: "optional",
      input: {
        query: z.object({ game: text("Only sets of this game (e.g. tft)") }).passthrough(),
      },
      output: { schema: z.object({ data: z.array(Row) }) },
    },
    async (c) => {
      const game = c.req.query("game");
      const rows = await sets()
        .filter(game ? { game } : {})
        .orderBy("-current", "name")
        .all();
      return c.json({ data: rows });
    }
  );

  app.get(
    "/sets/:slug",
    {
      id: "get-set",
      summary: "Read an autobattler set",
      description:
        "The set row (rules: board size, items per unit, team size by level, costs) and how many units, traits, items and augments it has. 404 if it does not exist.",
      access: "optional",
      input: { params: ParamSlug },
      output: {
        schema: z.object({ data: Row, counts: z.record(z.string(), z.number().int()) }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const row = await sets()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!row) return c.json({ error: "Not found" }, 404);
      const counts = await entities().filter({ setId: row.id }).all();
      const byKind: Record<string, number> = {};
      for (const e of counts) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      return c.json({ data: row, counts: byKind });
    }
  );

  /**
   * Uploads a whole set at once: rules and the four kinds of entity.
   *
   * It is an UPSERT by `(set, kind, id)`: re-importing a corrected patch
   * updates instead of duplicating, which is what makes it viable to re-scrape every
   * time Riot rebalances.
   */
  app.post(
    "/sets/import",
    {
      id: "import-set",
      summary: "Import or update a whole autobattler set",
      description:
        "Upserts a set by `slug` (rules and every unit, trait, item and augment, matched by kind + id: re-importing a patch updates instead of duplicating; repeated ids in the batch are collapsed). `current: true` makes it the current set of its game. Returns the set and the created/updated counts. Admin/editor, or an agent with autobattler:import.",
      access: "session",
      permission: ANY_ACCOUNT,
      // It rewrites the game data everyone consults.
      sensitive: true,
      input: { body: ImportSet },
      output: {
        status: 201,
        schema: z.object({
          data: Row,
          import: z.object({
            created: z.number().int(),
            updated: z.number().int(),
            total: z.number().int(),
            collapsed: z.number().int(),
          }),
        }),
      },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const user = userOf(c);
      if (!(await h.can({}, "import"))) return c.json({ error: "Forbidden" }, 403);
      const data = input.body as z.infer<typeof ImportSet>;

      const existing = await sets().filter({ slug: data.slug }).first();
      const values = {
        slug: data.slug,
        name: data.name,
        game: data.game,
        rules: data.rules as SetDefinition["rules"],
        source: data.source ?? null,
        patch: data.patch ?? null,
        current: data.current,
        ownerId: user?.id ?? null,
        updatedAt: new Date(),
      };
      const set = existing
        ? (await sets().filter({ id: existing.id }).update(values))[0]
        : await sets().create(values);

      // Only one current set per game: if this one is, the others stop being so.
      if (data.current) {
        for (const other of await sets().filter({ game: data.game, current: true }).all()) {
          if (other.id !== set.id) await sets().filter({ id: other.id }).update({ current: false });
        }
      }

      // The batch is collapsed by `(kind, id)` before touching the database: a catalog
      // with a repeated id would blow up the unique index and with it the import.
      const batch = new Map<string, typeof autobattlerEntities.$inferInsert>();
      for (const e of data.entities) {
        batch.set(`${e.kind}:${e.id}`, {
          setId: set.id,
          kind: e.kind,
          entityId: e.id,
          name: e.name,
          icon: e.icon ?? null,
          data: e.data ?? {},
        });
      }

      const known = new Map(
        (await entities().filter({ setId: set.id }).all()).map((e) => [
          `${e.kind}:${e.entityId}`,
          e.id,
        ])
      );
      const newOnes: (typeof autobattlerEntities.$inferInsert)[] = [];
      let updated = 0;
      for (const [key, values2] of batch) {
        const id = known.get(key);
        if (id) {
          await entities().filter({ id }).update(values2);
          updated++;
        } else {
          newOnes.push(values2);
        }
      }
      for (let i = 0; i < newOnes.length; i += 500) {
        await entities().createMany(newOnes.slice(i, i + 500));
      }
      cache.delete(set.slug);

      return c.json(
        {
          data: set,
          import: {
            created: newOnes.length,
            updated,
            total: batch.size,
            collapsed: data.entities.length - batch.size,
          },
        },
        201
      );
    }
  );

  // Before `/sets/:slug/:kind`, which captured `comps` as a kind.
  /** The tier list: the set's comps, the best first. */
  app.get(
    "/sets/:slug/comps",
    {
      id: "list-set-comps",
      summary: "Tier list of comps of a set",
      description:
        "Published comps of the set in tier list order (S, A, B… then unranked; inside a tier, best average placement first, then most recently updated); `tag` filters. 404 if the set does not exist.",
      access: "optional",
      input: {
        params: ParamSlug,
        query: z.object({ tag: text("Only comps with this tag") }).passthrough(),
      },
      output: {
        schema: z.object({ data: z.array(Row), meta: z.object({ total: z.number().int() }) }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const row = await sets()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!row) return c.json({ error: "Not found" }, 404);

      const rows = await comps().filter({ setId: row.id, status: "published" }).all();
      const tag = c.req.query("tag");
      const filtered = tag ? rows.filter((r) => r.tags.includes(tag)) : rows;

      // Tier list order: S, A, B… and untiered at the end. Within each
      // tier, the best average placement first if there is one.
      const rank = (t: string | null) => (t ? "SABCDEF".indexOf(t.toUpperCase()[0]) : 99);
      filtered.sort(
        (a, b) =>
          rank(a.tier) - rank(b.tier) ||
          (a.stats?.avgPlacement ?? 9) - (b.stats?.avgPlacement ?? 9) ||
          b.updatedAt.getTime() - a.updatedAt.getTime()
      );
      return c.json({ data: filtered, meta: { total: filtered.length } });
    }
  );

  /** Entity search: the comp editor's catalog. */
  app.get(
    "/sets/:slug/:kind",
    {
      id: "search-entities",
      summary: "Search the units, traits, items or augments of a set",
      description:
        "The catalogue of the comp editor: entities of one kind (`units`, `traits`, `items`, `augments`) of the set, by name; `q` matches the name and any other query key filters on that data field (exact match, arrays match any element). 404 for an unknown kind or set.",
      access: "optional",
      input: {
        params: ParamKind,
        query: z
          .object({ q: text("Name contains (case-insensitive)") })
          .passthrough()
          .describe("Any other key filters on that data field"),
      },
      output: {
        schema: z.object({ data: z.array(Row), meta: z.object({ total: z.number().int() }) }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const kind = c.req.param("kind");
      if (!["units", "traits", "items", "augments"].includes(kind)) {
        return c.json({ error: "Not found" }, 404);
      }
      const row = await sets()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!row) return c.json({ error: "Not found" }, 404);

      const q = c.req.query("q");
      const singular = kind.slice(0, -1);
      let rows = await entities()
        .where(
          q
            ? and(
                eq(autobattlerEntities.setId, row.id),
                eq(autobattlerEntities.kind, singular),
                ilike(autobattlerEntities.name, `%${q}%`)
              )!
            : and(eq(autobattlerEntities.setId, row.id), eq(autobattlerEntities.kind, singular))!
        )
        .orderBy("name")
        .all();

      // Facets over `data` in memory: a set is hundreds of entities, not
      // millions, and indexing every field of a JSON would cost more than it saves.
      const reserved = new Set(["q"]);
      for (const [key, value] of Object.entries(c.req.query()).filter(([k]) => !reserved.has(k))) {
        rows = rows.filter((r) => {
          const raw = (r.data as Record<string, unknown>)[key];
          return (Array.isArray(raw) ? raw : [raw]).some((v) => String(v) === value);
        });
      }
      return c.json({ data: rows, meta: { total: rows.length } });
    }
  );

  // ══ 2. What this kon does ══════════════════════════════════════════════════

  /**
   * A composition's synergies: **the operation that defines the genre**.
   *
   * It counts DISTINCT units per trait (three copies of the same are not three),
   * adds emblems and picks the highest threshold reached. It also returns the
   * traits that do NOT reach it, with what they lack: "you are missing 1 for Challenger 4"
   * is half a comps tool.
   */
  app.post(
    "/analyse",
    {
      id: "analyze-comp",
      summary: "Compute the trait synergies of a comp",
      description:
        "For a board (`slots` of unit ids with items, level, augments) of the set `setSlug`: every trait with its count of DISTINCT units (plus emblems) and the threshold reached or what is missing, the active ones, the comp's rule issues and its gold cost. Saves nothing. 404 if the set does not exist.",
      access: "optional",
      readOnly: true,
      input: { body: AnalyseBody },
      output: {
        schema: z.object({
          data: z
            .object({
              traits: z.array(Obj),
              active: z.array(Obj),
              issues: z.array(z.unknown()),
              goldCost: z.number(),
              units: z.number().int(),
            })
            .passthrough(),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const body = input.body as z.infer<typeof AnalyseBody>;
      const set = await loadSet(body.setSlug);
      if (!set) return c.json({ error: "That set does not exist" }, 404);

      const comp: Comp = { slots: body.slots, level: body.level, augments: body.augments };
      const traits = activateTraits(comp, set);
      return c.json({
        data: {
          traits,
          active: onlyActive(traits),
          issues: validateComp(comp, set),
          goldCost: compCost(comp, set),
          units: comp.slots.length,
        },
      });
    }
  );

  /**
   * The team builder: which unit to add now.
   * ==========================================================================
   *
   * `/analyse` answers "what do I have". This one answers "what am I missing and who gives it
   * to me", which is the question that does the work in a builder: whoever assembles
   * a comp does not want to read that they are 2 short of Bastion, they want the units
   * that provide it and their cost.
   *
   * It scores by TIERS gained, not by traits touched. A unit with four
   * traits that completes none is worth less than one with one that closes a
   * tier: in this game the value is in crossing the threshold, not in getting close.
   * Traits it only gets closer to come back separately, unscored.
   *
   * `traitId` is the panel's "I want to go for this trait": it filters to the units
   * that provide it.
   */
  app.post(
    "/suggest",
    {
      id: "suggest-units",
      summary: "Suggest the next unit to add to a comp",
      description:
        "Ranks the units of the set that fit the board by trait thresholds they would complete (traits merely approached come apart, unscored), with their cost. Options: `limit`, `costs`, `traitId` (only units that bring that trait), `ignoreLevel`. `meta.full` tells an empty list because the board is full from one with nothing left to add. Saves nothing. 404 if the set does not exist.",
      access: "optional",
      readOnly: true,
      input: { body: SuggestBody },
      output: {
        schema: z.object({
          data: z.array(Obj),
          meta: z.object({ full: z.boolean(), summary: Obj }).passthrough(),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const body = input.body as z.infer<typeof SuggestBody>;
      const set = await loadSet(body.setSlug);
      if (!set) return c.json({ error: "That set does not exist" }, 404);

      const comp: Comp = { slots: body.slots, level: body.level, augments: body.augments };
      const suggestions = suggestUnits(comp, set, {
        limit: body.limit,
        costs: body.costs,
        traitId: body.traitId,
        ignoreLevel: body.ignoreLevel,
      });

      return c.json({
        data: suggestions,
        meta: {
          // An empty list has two very different reasons and they must be
          // distinguishable: nobody else fits, or nothing is left that provides anything.
          full: suggestions.length === 0 && !body.ignoreLevel ? compIsFull(comp, set) : false,
          summary: compSummary(comp, set),
        },
      });
    }
  );

  /**
   * A trait's panel: where it stands and who completes it.
   *
   * It is what opens when a trait is clicked in the synergy list.
   */
  app.post(
    "/trait-plan",
    {
      id: "trait-plan",
      summary: "Plan one trait of a comp",
      description:
        "For the trait `traitId` and the given board: where it stands (count, thresholds, next one) and which units of the set would complete it. Saves nothing. 404 if the set or the trait does not exist.",
      access: "optional",
      readOnly: true,
      input: { body: TraitPlanBody },
      output: { schema: z.object({ data: Obj }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const body = input.body as z.infer<typeof TraitPlanBody>;
      const set = await loadSet(body.setSlug);
      if (!set) return c.json({ error: "That set does not exist" }, 404);

      const comp: Comp = { slots: body.slots, level: body.level, augments: body.augments };
      const plan = traitPlan(body.traitId, comp, set);
      if (!plan) return c.json({ error: "That trait does not exist in this set" }, 404);
      return c.json({ data: plan });
    }
  );

  /** The items cheat sheet: what comes out of these components. */
  app.post(
    "/craft",
    {
      id: "craftable-items",
      summary: "Items craftable from some components",
      description:
        "The item cheat sheet: every item of the set `setSlug` that can be built from the given `components` (item ids), with its composition and icon. Saves nothing. 404 if the set does not exist.",
      access: "optional",
      readOnly: true,
      input: { body: CraftBody },
      output: {
        schema: z.object({
          data: z.array(
            z
              .object({ id: z.string(), name: z.string(), icon: z.string().nullable() })
              .passthrough()
          ),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const body = input.body as z.infer<typeof CraftBody>;
      const set = await loadSet(body.setSlug);
      if (!set) return c.json({ error: "That set does not exist" }, 404);
      return c.json({
        data: craftableFrom(body.components, set.items).map((i) => ({
          id: i.id,
          name: i.name,
          composition: i.composition,
          icon: i.icon ?? null,
        })),
      });
    }
  );

  app.get(
    "/sets/:slug/items/:id/components",
    {
      id: "item-components",
      summary: "Components of an item",
      description:
        "The components the item `id` of the set is built from. 404 if the set or the item does not exist.",
      access: "optional",
      input: { params: ObjectParam },
      output: { schema: z.object({ data: z.array(z.unknown()) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const set = await loadSet(c.req.param("slug"));
      if (!set) return c.json({ error: "Not found" }, 404);
      const id = c.req.param("id");
      if (!set.items.some((i) => i.id === id)) return c.json({ error: "Not found" }, 404);
      return c.json({ data: componentsOf(id, set.items) });
    }
  );

  // ══ 3. Compositions ════════════════════════════════════════════════════════

  app.get(
    "/comps/:slug",
    {
      id: "get-comp",
      summary: "Read a comp with its board resolved",
      description:
        "The comp, its set (slug, name, rules), its trait synergies (all and active) and the board with each unit and item resolved. A hidden comp is a 404 except for its author and staff; 409 if its set no longer exists.",
      access: "optional",
      input: { params: ParamComp },
      output: {
        schema: z.object({
          data: Row,
          set: z.object({ slug: z.string(), name: z.string(), rules: Obj }),
          traits: z.array(Obj),
          active: z.array(Obj),
          board: z.array(Obj),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const comp = await comps()
        .filter({ slug: c.req.param("slug") })
        .first();
      if (!comp) return c.json({ error: "Not found" }, 404);
      if (!(await can(userOf(c), "view", comp, "autobattler"))) {
        return c.json({ error: "Not found" }, 404);
      }
      const row = await sets().find(comp.setId);
      const set = row ? await loadSet(row.slug) : null;
      if (!set) return c.json({ error: "That set no longer exists" }, 409);

      const model: Comp = {
        slots: comp.slots,
        level: comp.level ?? undefined,
        augments: comp.augments,
      };
      const traits = activateTraits(model, set);
      // The entities are returned already resolved: without this the client would have to
      // ask for the whole set to draw a single comp.
      const unit = new Map(set.units.map((u) => [u.id, u]));
      const item = new Map(set.items.map((i) => [i.id, i]));
      return c.json({
        data: comp,
        set: { slug: row!.slug, name: set.name, rules: set.rules },
        traits,
        active: onlyActive(traits),
        board: comp.slots.map((s) => ({
          ...s,
          unit: unit.get(s.unitId) ?? null,
          itemDetails: (s.items ?? []).map((i) => item.get(i) ?? null),
        })),
      });
    }
  );

  app.post(
    "/comps",
    {
      id: "create-comp",
      summary: "Save a comp",
      description:
        "Saves a comp of the set `setSlug` as yours (published), with title, description, tags, board, level, augments and carousel; the slug is derived from the title and the gold cost is computed. Only playable comps (422 with `issues`). 404 if the set does not exist. Any signed-in person; an agent needs an autobattler scope.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: SaveComp },
      output: { status: 201, schema: z.object({ data: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const user = userOf(c);
      if (!(await h.can({}, "create"))) return c.json({ error: "Forbidden" }, 403);
      const data = input.body as z.infer<typeof SaveComp>;

      const row = await sets().filter({ slug: data.setSlug }).first();
      const set = row ? await loadSet(row.slug) : null;
      if (!row || !set) return c.json({ error: "That set does not exist" }, 404);

      const model: Comp = {
        slots: data.slots,
        level: data.level,
        augments: data.augments,
        carousel: data.carousel,
      };
      // A published comp has to be playable: a tier list full of impossible
      // comps stops being useful as a reference, which is the only thing it does.
      const issues = validateComp(model, set);
      if (issues.length) return c.json({ error: "The comp is not valid", issues }, 422);

      const created = await comps().create({
        setId: row.id,
        slug: slugify(data.title),
        title: data.title,
        description: data.description ?? null,
        slots: data.slots,
        level: data.level ?? null,
        augments: data.augments,
        carousel: data.carousel,
        tags: data.tags,
        goldCost: compCost(model, set),
        authorId: user?.id ?? null,
      });
      return c.json({ data: created }, 201);
    }
  );

  app.delete(
    "/comps/:id",
    {
      id: "delete-comp",
      summary: "Delete a comp",
      description: "Deletes the comp. Its author or staff (403 otherwise). 204 with no body.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, _input, h) => {
      const comp = await comps().find(c.req.param("id"));
      if (!comp) return c.json({ error: "Not found" }, 404);
      if (!(await h.can(comp, "delete"))) {
        return c.json({ error: "Forbidden" }, 403);
      }
      await comps().filter({ id: comp.id }).delete();
      return c.body(null, 204);
    }
  );

  /**
   * Tier list tier, statistics and hide. It is the `rank` action, not
   * `update`: if it were the same, each author would put themselves in S.
   *
   * The `stats` come from OUTSIDE (your game ingestion) and are always stored
   * with their provenance: an average placement number without a source cannot be
   * audited or defended.
   */
  app.post(
    "/comps/:id/rank",
    {
      id: "rank-comp",
      summary: "Set the tier, stats or visibility of a comp",
      description:
        "Curation: the comp's tier list row (`tier`, null removes it), `hide`, and meta `stats` (e.g. avgPlacement) which need a `statsSource` (422 otherwise) because they come from an external match ingest. Omitted fields keep their value. Admin/editor only — never the author (403).",
      access: "session",
      permission: ANY_ACCOUNT,
      // Sets the public tier list tier.
      sensitive: true,
      input: { params: ParamId, body: RankComp },
      output: { schema: z.object({ data: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const comp = await comps().find(c.req.param("id"));
      if (!comp) return c.json({ error: "Not found" }, 404);
      if (!(await h.can(comp, "rank"))) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const data = input.body as z.infer<typeof RankComp>;
      if (data.stats && !data.statsSource && !comp.statsSource) {
        return c.json({ error: "Stats without `statsSource` cannot be audited" }, 422);
      }

      const [row] = await comps()
        .filter({ id: comp.id })
        .update({
          tier: data.tier === undefined ? comp.tier : data.tier,
          status: data.hide === undefined ? comp.status : data.hide ? "hidden" : "published",
          stats: data.stats === undefined ? comp.stats : data.stats,
          statsSource: data.statsSource ?? comp.statsSource,
          statsUpdatedAt: data.stats ? new Date() : comp.statsUpdatedAt,
          updatedAt: new Date(),
        });
      return c.json({ data: row });
    }
  );

  return app.ops;
}

export function createKonAutobattler(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, autobattlerOperations(ctx), ctx);
}

export { KON_ID };

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`autobattlerOperations`), with its OpenAPI, its MCP tool and its fine-grained
 * scope `kon:autobattler:<id>`.
 */
export const kon = defineKonSdk({
  id: KON_ID,
  name: "Autobattler",
  version: manifest.version,
  description: "Autobattler compositions: threshold synergies, items, board and tier list",
  icon: "Grid3x3",
  mountPath: "/api/autobattler",
  operations: (ctx: KonContext) => autobattlerOperations(ctx),

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
      ctx.logger.info("♟️ Autobattler ready — POST /api/autobattler/sets/import");
    },
  },
});

export default kon;
