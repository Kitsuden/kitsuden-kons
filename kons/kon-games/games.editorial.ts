/**
 * Editorial layer of a game's blocks
 * ============================================================================
 *
 * `games.blocks` is an array of `{ id, type, order, data }` that the loaders
 * REGENERATE on every reload. What the team edits by hand —with Inti or with an agent— cannot
 * live in `data`: the next reload would erase it. It goes in `editorial`, a per-block layer that
 * reloads preserve by `id` (see `sqlBlocksWithEditorial`).
 *
 * Whoever renders uses `editorial.title ?? data.title`,
 * `editorial.description ?? data.description`, skips those with `hidden === true` and
 * sorts by `editorial.order ?? order`. Without `editorial`, the page looks
 * exactly the same as before.
 *
 * Up to Kitsuden 0.8 the layer's keys were Spanish (`titulo`, `descripcion`, `oculto`, `orden`).
 * Migration `0003_english_block_keys.sql` rewrites the stored ones; until 0.10 the READS here also
 * accept a 0.8 key that is still there (`readGameBlocks`, `layerOf`), and the WRITES answer one
 * with a 422 that names the English key. The table of names is `@kitsuden/shared` block-keys.ts.
 *
 * Writes are ONE SQL statement each, merging with jsonb on the
 * server: two edits of different blocks at the same time do not clobber each other, because
 * neither reads the array, changes it in memory and writes it back whole.
 */

import {
  EDITORIAL_KEYS,
  findSpanishBlockKeys,
  findSpanishEditorialKeys,
  readBlockData,
  readEditorial,
  spanishKeysError,
  type SpanishKey,
} from "@kitsuden/shared";
import { sql, type SQL } from "drizzle-orm";

export interface BlockEditorial {
  title?: string;
  description?: string;
  hidden?: boolean;
  order?: number;
}

/** What `PATCH …/editorial` accepts. `null` = remove that field from the layer. */
export interface EditorialPatch {
  title?: string | null;
  description?: string | null;
  hidden?: boolean | null;
}

export const MAX_TITLE = 500;
export const MAX_DESCRIPTION = 5000;

/**
 * A failed validation. `status` 422 is a body that still uses the 0.8 key names (`hint` and
 * `renamed` say which English ones to use); anything else is the usual 400.
 */
export type Failure = {
  ok: false;
  error: string;
  status?: 400 | 422;
  hint?: string;
  renamed?: SpanishKey[];
};
type Result<T> = { ok: true; value: T } | Failure;

/** The body and status of a failed validation, for `c.json(...)`. */
export function failureResponse(f: Failure): [Record<string, unknown>, 400 | 422] {
  const { ok: _ok, status, ...body } = f;
  return [body, status ?? 400];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

/**
 * Body of `PATCH /:id/blocks/:blockId/editorial`.
 *
 * Strict on purpose: an unknown key is a 400, it is not ignored. A client that sends `order`
 * here believes it has saved something and has saved nothing; better that it finds out. A 0.8
 * key (`titulo`, `oculto`…) is a 422 whose hint names the English one.
 */
export function validateEditorialPatch(body: unknown): Result<EditorialPatch> {
  if (!isPlainObject(body)) return { ok: false, error: "The body must be a JSON object" };
  const old = findSpanishEditorialKeys(body);
  if (old.length) return { ok: false, status: 422, ...spanishKeysError(old, "editorial layer") };
  const patch: EditorialPatch = {};
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case "title":
      case "description": {
        if (value === null) {
          patch[key] = null;
          break;
        }
        if (typeof value !== "string")
          return { ok: false, error: `«${key}» must be text or null` };
        const max = key === "title" ? MAX_TITLE : MAX_DESCRIPTION;
        if (value.length > max) {
          return { ok: false, error: `«${key}» cannot exceed ${max} characters` };
        }
        patch[key] = value;
        break;
      }
      case "hidden":
        if (value !== null && typeof value !== "boolean") {
          return { ok: false, error: "«hidden» must be true, false or null" };
        }
        patch.hidden = value as boolean | null;
        break;
      default:
        return {
          ok: false,
          error: `Unsupported key: «${key}» (only title, description, hidden)`,
        };
    }
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "Nothing to change: send title, description or hidden" };
  }
  return { ok: true, value: patch };
}

/** Body of `PUT /:id/blocks/order`: `{ ids: string[] }` without repeats. */
export function validateOrder(body: unknown): Result<string[]> {
  if (!isPlainObject(body)) return { ok: false, error: "The body must be a JSON object" };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "ids") {
    return { ok: false, error: "The body must be exactly { ids: string[] }" };
  }
  const { ids } = body as { ids: unknown };
  if (!Array.isArray(ids) || ids.length === 0)
    return { ok: false, error: "«ids» must be a non-empty list" };
  if (!ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 500)) {
    return { ok: false, error: "Each id in «ids» must be non-empty text" };
  }
  if (new Set(ids).size !== ids.length) return { ok: false, error: "«ids» has repeated ids" };
  return { ok: true, value: ids as string[] };
}

/**
 * The 0.8 key names in a `blocks` array that is about to be saved whole (`POST /`, `PATCH /:id`):
 * in each block's `data` and, if the writer sent one, in its `editorial`. Empty = all English.
 */
export function oldKeysInBlocks(blocks: unknown): SpanishKey[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((b, i) => {
    if (!isPlainObject(b)) return [];
    const at = (where: string) => (k: SpanishKey) => ({
      path: `blocks[${i}].${where}.${k.path}`,
      use: `blocks[${i}].${where}.${k.use}`,
    });
    return [
      ...findSpanishBlockKeys(b.type, b.data).map(at("data")),
      ...findSpanishEditorialKeys(b.editorial).map(at("editorial")),
    ];
  });
}

/**
 * A game's blocks as they are served: `data` and `editorial` with the English keys, accepting
 * the 0.8 ones a block could still carry (a loader that wrote after the migration ran). Anything
 * that is not an array of objects comes back as it was.
 */
// Remove in 0.10: serve `games.blocks` as stored.
export function readGameBlocks<T>(blocks: T): T {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((b) => {
    if (!isPlainObject(b)) return b;
    const data = readBlockData(b.type, b.data);
    const editorial = readEditorial(b.editorial);
    return data === b.data && editorial === b.editorial ? b : { ...b, data, editorial };
  }) as T;
}

/** A game row with its blocks as they are served (see `readGameBlocks`). */
export function gameToServe<T>(game: T): T {
  if (!isPlainObject(game) || !Array.isArray(game.blocks)) return game;
  const blocks = readGameBlocks(game.blocks);
  return (blocks === game.blocks ? game : { ...game, blocks }) as T;
}

/** `:id` is the game's uuid; anything else is not a game (404, not a Postgres 500). */
export const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const json = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;

/**
 * A stored layer `x` with its 0.8 keys moved to the English ones, in SQL: each old key becomes
 * its English name (`titulo` → `title`…) unless the English one is already there, which wins.
 */
// Remove in 0.10: back to `x` itself.
const englishLayer = (x: SQL) => {
  const pairs = sql.join(
    Object.entries(EDITORIAL_KEYS).map(
      ([old, english]) => sql`${sql.raw(`'${english}'`)}, (${x}) -> ${sql.raw(`'${old}'`)}`
    ),
    sql`, `
  );
  const olds = Object.keys(EDITORIAL_KEYS)
    .map((k) => `'${k}'`)
    .join(", ");
  return sql`(jsonb_strip_nulls(jsonb_build_object(${pairs})) || ((${x}) - ${sql.raw(`ARRAY[${olds}]::text[]`)}))`;
};

/** The current layer of a block `b` (SQL alias), or `{}` if it has none or is not an object. */
const layerOf = (b: SQL) =>
  sql`(CASE WHEN jsonb_typeof(${b}->'editorial') = 'object' THEN ${englishLayer(sql`${b}->'editorial'`)} ELSE '{}'::jsonb END)`;

/**
 * Merges `patch` into the layer of block `blockId`, in a single statement.
 *
 * `layer || patch` and then `jsonb_strip_nulls`: a key set to `null` in the
 * patch ends up null and is removed. If the layer ends up empty, the whole `editorial`
 * key is deleted (the block goes back to how the loader left it).
 *
 * It returns the block's `{ editorial }` after the write, or no row if
 * the game or the block does not exist.
 */
export function sqlMergeEditorial(
  gameId: string,
  blockId: string,
  patch: EditorialPatch
): SQL {
  const b = sql.raw("t.b");
  return sql`
    UPDATE games SET
      blocks = (
        SELECT jsonb_agg(
          CASE WHEN ${b}->>'id' = ${blockId} THEN
            CASE WHEN n.layer = '{}'::jsonb THEN ${b} - 'editorial'
                 ELSE jsonb_set(${b}, '{editorial}', n.layer) END
          ELSE ${b} END
          ORDER BY t.i)
        FROM jsonb_array_elements(games.blocks) WITH ORDINALITY AS t(b, i)
        CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(${layerOf(b)} || ${json(patch)}) AS layer) AS n
      ),
      updated_at = now()
    WHERE games.id = ${gameId}
      AND jsonb_typeof(games.blocks) = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(games.blocks) AS x(b) WHERE x.b->>'id' = ${blockId})
    RETURNING (
      SELECT x.b->'editorial' FROM jsonb_array_elements(games.blocks) AS x(b)
      WHERE x.b->>'id' = ${blockId} LIMIT 1
    ) AS editorial`;
}

/**
 * Writes `editorial.order = index` into each block according to `ids`, in a single
 * statement. The check that `ids` is EXACTLY the set of the game's ids
 * goes in the same `WHERE`: if someone reloads the game between Inti's read
 * and this write, nothing is ordered halfway, zero rows are returned.
 */
export function sqlSortBlocks(gameId: string, ids: string[]): SQL {
  const b = sql.raw("t.b");
  return sql`
    UPDATE games SET
      blocks = (
        SELECT jsonb_agg(
          jsonb_set(${b}, '{editorial}', ${layerOf(b)} || jsonb_build_object('order', o.pos - 1))
          ORDER BY t.i)
        FROM jsonb_array_elements(games.blocks) WITH ORDINALITY AS t(b, i)
        JOIN jsonb_array_elements_text(${json(ids)}) WITH ORDINALITY AS o(id, pos) ON o.id = ${b}->>'id'
      ),
      updated_at = now()
    WHERE games.id = ${gameId}
      AND jsonb_typeof(games.blocks) = 'array'
      AND (SELECT coalesce(array_agg(x.b->>'id' ORDER BY x.b->>'id'), '{}') FROM jsonb_array_elements(games.blocks) AS x(b))
        = (SELECT coalesce(array_agg(v ORDER BY v), '{}') FROM jsonb_array_elements_text(${json(ids)}) AS v)
    RETURNING games.id`;
}

/**
 * The expression that replaces `blocks = <new ones>` in any write of
 * GENERATED blocks (loaders): each new block receives the `editorial` of the
 * block that currently has its same `id` in the database. A block that disappears from the
 * plan loses its layer; a new one has none.
 *
 * The database is read in the SAME statement (`games.blocks` inside an `UPDATE`
 * is the row's previous value), so an edit made between the loader's read
 * and its write is not lost either.
 *
 * Usage: sql`UPDATE games SET blocks = ${sqlBlocksWithEditorial(newest)} WHERE id = …`
 */
export function sqlBlocksWithEditorial(
  newOnes: unknown[],
  column: SQL = sql.raw("games.blocks")
): SQL {
  return sql`(
    SELECT coalesce(jsonb_agg(
      CASE WHEN v.layer IS NOT NULL THEN jsonb_set(n.b, '{editorial}', v.layer) ELSE n.b - 'editorial' END
      ORDER BY n.i), '[]'::jsonb)
    FROM jsonb_array_elements(${json(newOnes)}) WITH ORDINALITY AS n(b, i)
    LEFT JOIN LATERAL (
      SELECT ${layerOf(sql.raw("x.b"))} AS layer
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END) AS x(b)
      WHERE x.b->>'id' = n.b->>'id' AND jsonb_typeof(x.b->'editorial') = 'object'
      LIMIT 1
    ) AS v ON true
  )`;
}

/** The same in memory, for whoever already has both arrays (and for testing without a database). */
export function keepEditorial<T extends { id: string; editorial?: unknown }>(
  previousOnes: ReadonlyArray<{ id?: unknown; editorial?: unknown }> | null | undefined,
  newOnes: T[]
): T[] {
  const layerById = new Map<string, BlockEditorial>();
  for (const b of previousOnes ?? []) {
    if (b && typeof b.id === "string" && isPlainObject(b.editorial)) {
      // Remove in 0.10 (`readEditorial`): a 0.8 layer is carried over in English.
      if (!layerById.has(b.id)) layerById.set(b.id, readEditorial(b.editorial) as BlockEditorial);
    }
  }
  return newOnes.map((b) => {
    const { editorial: _discarded, ...rest } = b;
    const layer = layerById.get(b.id);
    return (layer ? { ...rest, editorial: layer } : rest) as T;
  });
}
