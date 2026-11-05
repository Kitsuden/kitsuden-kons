/**
 * @kitsuden/kon-collection
 * ============================================================================
 *
 * "What I already have" over an index with records: a creature log, a card
 * game's box, the characters you have pulled in a gacha.
 *
 * The index is the same dataset the website already draws; this only stores WHICH
 * records each reader has marked. That is why there is no records table here: if
 * the index changes, the collection does not notice and need not.
 *
 * ── EVERYTHING IS PERSONAL ─────────────────────────────────────────────────
 *
 * No route reads anyone else's collection. Without a session there is nothing to read
 * or write: the page works the same without an account, saving in the browser,
 * and what is stored here is what follows the person from one device to
 * another.
 */

import {
  defineKonSdk,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import "./collection.policy.js";
import { collectionMarks } from "./collection.schema.js";
import { ANY_ACCOUNT, KON_ID, MARK, registry } from "./operations.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./collection.schema.js";

/** A record key: what fits in an address, and nothing more. */
const KEY = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._-]+$/, "That key does not belong to a record");

const MarkOne = z.object({
  entryKey: KEY,
  /** `true` marks it, `false` removes it. The button is a single one. */
  have: z.boolean(),
});

/**
 * The one-shot upload: what someone marked WITHOUT an account, when they sign in.
 * It is limited to 2,000 keys — the biggest index we have (Master Duel)
 * is around 14,000 cards, but such an upload arrives from a browser and whatever
 * does not fit is sent in another batch.
 */
const MarkMany = z.object({
  entryKeys: z.array(KEY).max(2000),
});

/**
 * How many marks a person can have in ONE index.
 *
 * The biggest index we have (Master Duel) is around 14,000 cards: with
 * 20,000 no legitimate person gets there. Without a cap, the one-at-a-time `PUT` and the
 * 2,000 batch let any account (sign-up is public) fill the table with
 * invented keys.
 */
export const MAX_MARKS = 20_000;

// ── Parameters and outputs (OpenAPI and MCP) ─────────────────────────────────

const IndexParam = z.object({
  datasetId: z
    .string()
    .describe("Id (uuid) of the dataset that is the index; anything else is a 404"),
});
const Marks = z.object({
  data: z.object({ marks: z.array(z.string()).describe("Keys of the entries you have") }),
});

export function collectionOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const db = ctx.db.instance;

  // Nothing here is public: every route needs to know whose it is. It used to be an
  // `app.use("*", requireAuth)`; now `access: "session"` on each operation.

  const who = (c: { get: (k: string) => unknown }) => (c.get("user") ?? null) as AuthzUser | null;

  /** A dataset is a uuid; anything else is not queried. */
  const esDataset = (id: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  const rows = (r: unknown): unknown[] =>
    Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? []);

  /**
   * Does that index really exist? Only before WRITING.
   *
   * The uuid shape was enough to mark: each invented uuid was a new index
   * with its 2,000 marks per request, and the per-index cap stopped
   * nothing. It answers 404, the same as with a malformed uuid.
   */
  const datasetExists = async (id: string): Promise<boolean> => {
    try {
      return (
        rows(await db.execute(sql`SELECT 1 FROM data_sets WHERE id = ${id} LIMIT 1`)).length > 0
      );
    } catch {
      return false;
    }
  };

  const marksOf = async (userId: string, datasetId: string): Promise<number> => {
    const r = rows(
      await db.execute(
        sql`SELECT COUNT(*)::int AS n FROM collection_marks WHERE user_id = ${userId} AND dataset_id = ${datasetId}`
      )
    ) as { n: number }[];
    return Number(r[0]?.n ?? 0);
  };

  /**
   * What I have of this index: only the keys.
   *
   * The page draws the 208 records the same; this tells it which carry a mark. An
   * array of keys is the smallest thing that works for that, and it is read on every
   * visit.
   */
  app.get(
    "/:datasetId",
    {
      id: "get-my-collection",
      summary: "Read your collection of an index",
      description:
        "The keys of the entries of index `datasetId` that YOU have marked (only yours: nobody reads someone else's collection). An index you never marked returns an empty list. 404 if `datasetId` is not a uuid.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: IndexParam },
      output: { schema: Marks },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const user = who(c);
      const datasetId = c.req.param("datasetId");
      if (!user?.id) return c.json({ error: "Unauthorized" }, 401);
      if (!esDataset(datasetId)) return c.json({ error: "That index does not exist" }, 404);

      const rows = await db
        .select({ entryKey: collectionMarks.entryKey })
        .from(collectionMarks)
        .where(and(eq(collectionMarks.userId, user.id), eq(collectionMarks.datasetId, datasetId)));

      return c.json({ data: { marks: rows.map((f: { entryKey: string }) => f.entryKey) } });
    }
  );

  /** Mark or unmark a record. The same button does both. */
  app.put(
    "/:datasetId",
    {
      id: "mark-entry",
      summary: "Mark or unmark one entry as yours",
      description:
        "`have: true` marks the entry `entryKey` of index `datasetId` as yours, `have: false` unmarks it (same button). Marking twice is not an error. 404 if the index does not exist, 409 when your collection of that index is full (20,000). A signed-in person, or an agent with collection:create.",
      access: "session",
      permission: MARK,
      input: { params: IndexParam, body: MarkOne },
      output: {
        schema: z.object({ data: z.object({ entryKey: z.string(), have: z.boolean() }) }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const user = who(c);
      const datasetId = c.req.param("datasetId");
      if (!user?.id) return c.json({ error: "Unauthorized" }, 401);
      if (!esDataset(datasetId)) return c.json({ error: "That index does not exist" }, 404);
      if (!(await h.can({ userId: user.id }))) {
        return c.json({ error: "Forbidden" }, 403);
      }

      const { entryKey, have } = input.body as z.infer<typeof MarkOne>;
      const theirs = and(
        eq(collectionMarks.userId, user.id),
        eq(collectionMarks.datasetId, datasetId),
        eq(collectionMarks.entryKey, entryKey)
      );
      if (have) {
        if (!(await datasetExists(datasetId)))
          return c.json({ error: "That index does not exist" }, 404);
        if ((await marksOf(user.id, datasetId)) >= MAX_MARKS) {
          // Full, but marking what is ALREADY marked adds nothing: still not an error.
          const [already] = await db
            .select({ entryKey: collectionMarks.entryKey })
            .from(collectionMarks)
            .where(theirs)
            .limit(1);
          if (!already) {
            return c.json({ error: "Your collection for this index is already full" }, 409);
          }
        }
      }

      if (have) {
        // `onConflictDoNothing`: marking twice from two tabs is not an error
        await db
          .insert(collectionMarks)
          .values({ userId: user.id, datasetId, entryKey })
          .onConflictDoNothing();
      } else {
        await db.delete(collectionMarks).where(theirs);
      }

      return c.json({ data: { entryKey, have } });
    }
  );

  /**
   * What was marked without an account, all at once.
   *
   * It ADDS, it does not replace: whoever already had marks in their account and also brought some
   * from the browser keeps both. Deleting what is in the account because the
   * browser came empty would mean losing someone's collection on their first
   * sign-in from another computer.
   */
  app.post(
    "/:datasetId/many",
    {
      id: "mark-many",
      summary: "Mark many entries as yours at once",
      description:
        "Adds up to 2,000 entry keys to your collection of index `datasetId` (what was marked in the browser before signing in). It ADDS, never replaces; keys beyond the 20,000 cap are left out. Returns your whole collection of that index. 404 if the index does not exist. A signed-in person, or an agent with collection:create.",
      access: "session",
      permission: MARK,
      // Repeating the upload leaves the same: it adds without duplicating.
      idempotent: true,
      input: { params: IndexParam, body: MarkMany },
      output: { schema: Marks },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const user = who(c);
      const datasetId = c.req.param("datasetId");
      if (!user?.id) return c.json({ error: "Unauthorized" }, 401);
      if (!esDataset(datasetId)) return c.json({ error: "That index does not exist" }, 404);
      if (!(await h.can({ userId: user.id }))) {
        return c.json({ error: "Forbidden" }, 403);
      }

      const { entryKeys } = input.body as z.infer<typeof MarkMany>;
      if (!(await datasetExists(datasetId))) return c.json({ error: "That index does not exist" }, 404);
      // What does not fit stays out, as the comment above says: whatever
      // does not fit is sent in another batch (and will no longer fit).
      const gap = Math.max(0, MAX_MARKS - (await marksOf(user.id, datasetId)));
      const unique = [...new Set(entryKeys)];
      // The room goes to keys the account does NOT have yet: a key already marked takes none.
      // (Slicing first let already-marked keys use up the room and then be skipped by the
      // insert, so a new key that fitted was left out — the usual upload is mostly old keys.)
      const marked = new Set(
        unique.length === 0
          ? []
          : (
              await db
                .select({ entryKey: collectionMarks.entryKey })
                .from(collectionMarks)
                .where(
                  and(
                    eq(collectionMarks.userId, user.id),
                    eq(collectionMarks.datasetId, datasetId),
                    inArray(collectionMarks.entryKey, unique)
                  )
                )
            ).map((r: { entryKey: string }) => r.entryKey)
      );
      const fresh = unique.filter((k) => !marked.has(k)).slice(0, gap);
      if (fresh.length > 0) {
        await db
          .insert(collectionMarks)
          .values(fresh.map((entryKey) => ({ userId: user.id as string, datasetId, entryKey })))
          .onConflictDoNothing();
      }

      const rows = await db
        .select({ entryKey: collectionMarks.entryKey })
        .from(collectionMarks)
        .where(and(eq(collectionMarks.userId, user.id), eq(collectionMarks.datasetId, datasetId)));

      return c.json({ data: { marks: rows.map((f: { entryKey: string }) => f.entryKey) } });
    }
  );

  /** Empty the collection of this index. Asked for by whoever wants to start from zero. */
  app.delete(
    "/:datasetId",
    {
      id: "clear-my-collection",
      summary: "Empty your collection of an index",
      description:
        "Removes all YOUR marks of index `datasetId` (only yours). Cannot be undone. 404 if `datasetId` is not a uuid.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: IndexParam },
      output: { schema: z.object({ data: z.object({ marks: z.array(z.string()).max(0) }) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const user = who(c);
      const datasetId = c.req.param("datasetId");
      if (!user?.id) return c.json({ error: "Unauthorized" }, 401);
      if (!esDataset(datasetId)) return c.json({ error: "That index does not exist" }, 404);

      await db
        .delete(collectionMarks)
        .where(and(eq(collectionMarks.userId, user.id), eq(collectionMarks.datasetId, datasetId)));
      return c.json({ data: { marks: [] } });
    }
  );

  return app.ops;
}

export function createKonCollection(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, collectionOperations(ctx), ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`collectionOperations`), with its OpenAPI, its MCP tool and its fine-grained scope
 * `kon:collection:<id>`.
 */
export const kon = defineKonSdk({
  id: KON_ID,
  name: "Collection",
  version: manifest.version,
  description: "What each reader already has from an index with records",
  icon: "CircleCheckBig",
  mountPath: "/api/collection",
  operations: (ctx: KonContext) => collectionOperations(ctx),

  tables: konTables,

  // kon.json `admin` is the one list of admin views; the definition copies it.
  admin: {
    category: manifest.admin.category as "tools",
    views: manifest.admin.views.map((v) => ({ id: v.id, type: v.type as "grid", title: v.title, table: v.table })),
  },

  dependencies: { kons: [], core: ["auth"] },

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("✅ Collection ready — what each reader has, theirs alone");
    },
  },
});

export default kon;
