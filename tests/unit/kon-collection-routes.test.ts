/**
 * kon-collection over HTTP and in the database: whose marks, which keys, how many
 * ============================================================================
 *
 * `kon-collection-and-analytics-security` covers the headline cases (Bruno cannot read or empty
 * Alicia's collection, made-up indexes, the 20,000 cap at exactly 20,000, one agent case) on a
 * superuser PGlite, where RLS never runs. Here the kon runs as the host runs it: its migrations
 * (listed from the folder, never named), the core's `rls-owned-tables.sql` that puts
 * `collection_marks` behind owner isolation, a NON-superuser role, and the per-request RLS
 * transaction (`rlsHost`). On top of that:
 *
 *   · every route needs a session; an agent key needs `user:act` or a collection scope to read,
 *     and `collection:create` (or the fine scope) to mark; a denial beats `admin`;
 *   · a bad key or a bad batch is a 422 that names every problem, and nothing is stored;
 *   · marking is idempotent, the batch ADDS and dedupes, emptying touches one index and one person;
 *   · the cap leaves out only what does not fit;
 *   · the database itself refuses another person's rows, whatever the route does.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonCollection, MAX_MARKS } from "../../kons/kon-collection";
import { registerCollectionPolicy } from "../../kons/kon-collection/collection.policy";

import {
  ACTORS,
  APP_ROLE,
  dropToAppRole,
  migratedBase,
  requestAs,
  sqlAs,
  testAuth,
} from "./helpers/safe-kons-bench";

const KON = "kon-collection";
const migrations = () =>
  readdirSync(resolve(__dirname, `../../kons/${KON}/migrations`))
    .filter((f) => f.endsWith(".sql"))
    .sort();

/** The core's owner isolation for personal tables (the host applies it after the migrations). */
const OWNED_TABLES_RLS = resolve(__dirname, "../../.kitsuden/apps/api/src/db/rls-owned-tables.sql");

const INDEX = "22222222-2222-4222-8222-222222222222";
const OTHER_INDEX = "33333333-3333-4333-8333-333333333333";
const MADE_UP = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "agente-de-prueba";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const json = async (res: Response): Promise<any> => res.json();
const agent = (...scopes: string[]) => ({ agent: scopes });

/** Marks as the system (empty RLS context), straight in the table. */
async function marksIn(where = "TRUE"): Promise<Array<{ user_id: string; dataset_id: string; entry_key: string }>> {
  return (
    await client.query<{ user_id: string; dataset_id: string; entry_key: string }>(
      `SELECT user_id, dataset_id, entry_key FROM collection_marks WHERE ${where} ORDER BY user_id, dataset_id, entry_key`
    )
  ).rows;
}

/** `n` marks `k1…kn` for a person in an index, as the system. */
async function fill(userId: string, n: number, datasetId = INDEX) {
  await client.query(
    `INSERT INTO collection_marks (user_id, dataset_id, entry_key)
     SELECT $1, $2, 'k' || g FROM generate_series(1, ${n}) g`,
    [userId, datasetId]
  );
}

beforeAll(async () => {
  client = await migratedBase(KON, migrations());
  await client.exec(`
    CREATE TABLE IF NOT EXISTS data_sets (id uuid PRIMARY KEY, name text);
    INSERT INTO data_sets VALUES ('${INDEX}', 'Creatures'), ('${OTHER_INDEX}', 'Cards');
    GRANT SELECT ON data_sets TO ${APP_ROLE};
  `);
  await client.exec(readFileSync(OWNED_TABLES_RLS, "utf8"));
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never } as never);
  request = requestAs(host.mount(createKonCollection(ctx)));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  registerCollectionPolicy();
  await client.query("DELETE FROM collection_marks");
});

// ════════════════════════════════════════════════════════════════════════════

describe("the database wall is really up", () => {
  it("collection_marks has forced RLS and the test role does not skip it", async () => {
    const r = await client.query<{ rls: boolean; forced: boolean }>(
      "SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relname = 'collection_marks'"
    );
    expect(r.rows[0]).toEqual({ rls: true, forced: true });
  });

  it("another person, and an anonymous one, see none of your rows; an admin sees them for support", async () => {
    await fill(ACTORS.a.id, 3);
    expect(await sqlAs(client, "b", "SELECT * FROM collection_marks")).toEqual([]);
    expect(await sqlAs(client, "anon", "SELECT * FROM collection_marks")).toEqual([]);
    expect(await sqlAs(client, "a", "SELECT * FROM collection_marks")).toHaveLength(3);
    expect(await sqlAs(client, "admin", "SELECT * FROM collection_marks")).toHaveLength(3);
  });

  it("nobody writes a row in someone else's name, and nobody deletes someone else's", async () => {
    await expect(
      sqlAs(client, "b", "INSERT INTO collection_marks (user_id, dataset_id, entry_key) VALUES ($1, $2, 'x')", [ACTORS.a.id, INDEX])
    ).rejects.toThrow(/row-level security/);
    await fill(ACTORS.a.id, 2);
    await sqlAs(client, "b", "DELETE FROM collection_marks");
    expect(await marksIn()).toHaveLength(2);
  });
});

describe("who may use it", () => {
  it.each([
    ["GET", `/${INDEX}`, undefined],
    ["PUT", `/${INDEX}`, { entryKey: "emberpup", have: true }],
    ["POST", `/${INDEX}/many`, { entryKeys: ["emberpup"] }],
    ["DELETE", `/${INDEX}`, undefined],
  ])("%s %s without a session: 401, and nothing stored", async (method, route, body) => {
    expect((await request("anon", method, route, body)).status).toBe(401);
    expect(await marksIn()).toEqual([]);
  });

  it("any signed-in person reads, marks, uploads and empties their own", async () => {
    expect((await request("a", "PUT", `/${INDEX}`, { entryKey: "emberpup", have: true })).status).toBe(200);
    expect((await json(await request("a", "POST", `/${INDEX}/many`, { entryKeys: ["fluffin"] }))).data.marks.sort()).toEqual(["emberpup", "fluffin"]);
    expect((await json(await request("a", "GET", `/${INDEX}`))).data.marks.sort()).toEqual(["emberpup", "fluffin"]);
    expect(await json(await request("a", "DELETE", `/${INDEX}`))).toEqual({ data: { marks: [] } });
    expect(await marksIn()).toEqual([]);
  });

  it("an admin's GET is the admin's own collection, not everyone's", async () => {
    await fill(ACTORS.a.id, 2);
    expect((await json(await request("admin", "GET", `/${INDEX}`))).data.marks).toEqual([]);
  });

  it("an agent key with no collection scope does nothing at all", async () => {
    await fill(AGENT_ID, 1);
    const key = agent("mcp:connect", "datasets:x:read");
    expect((await request(key, "GET", `/${INDEX}`)).status).toBe(403);
    expect((await request(key, "PUT", `/${INDEX}`, { entryKey: "x", have: true })).status).toBe(403);
    expect((await request(key, "POST", `/${INDEX}/many`, { entryKeys: ["x"] })).status).toBe(403);
    expect((await request(key, "DELETE", `/${INDEX}`)).status).toBe(403);
    expect(await marksIn()).toEqual([{ user_id: AGENT_ID, dataset_id: INDEX, entry_key: "k1" }]);
  });

  it("`user:act` lets an agent read and empty as an account, but marking needs `collection:create`", async () => {
    const key = agent("user:act");
    expect((await request(key, "GET", `/${INDEX}`)).status).toBe(200);
    expect((await request(key, "PUT", `/${INDEX}`, { entryKey: "x", have: true })).status).toBe(403);
    expect((await request(key, "DELETE", `/${INDEX}`)).status).toBe(200);
  });

  it("`collection:create` marks one and many, always in the agent's own name", async () => {
    const key = agent("collection:create");
    expect((await request(key, "PUT", `/${INDEX}`, { entryKey: "one", have: true })).status).toBe(200);
    expect((await request(key, "POST", `/${INDEX}/many`, { entryKeys: ["two"] })).status).toBe(200);
    expect(await marksIn()).toEqual([
      { user_id: AGENT_ID, dataset_id: INDEX, entry_key: "one" },
      { user_id: AGENT_ID, dataset_id: INDEX, entry_key: "two" },
    ]);
  });

  it("a fine scope opens its own operation and no other", async () => {
    const key = agent("kon:collection:mark-entry");
    expect((await request(key, "PUT", `/${INDEX}`, { entryKey: "one", have: true })).status).toBe(200);
    expect((await request(key, "POST", `/${INDEX}/many`, { entryKeys: ["two"] })).status).toBe(403);
    expect(await marksIn()).toEqual([{ user_id: AGENT_ID, dataset_id: INDEX, entry_key: "one" }]);
  });

  it("a denial beats a broad grant, `admin` included", async () => {
    const noClearing = agent("collection:*", "!kon:collection:clear-my-collection");
    expect((await request(noClearing, "GET", `/${INDEX}`)).status).toBe(200);
    expect((await request(noClearing, "DELETE", `/${INDEX}`)).status).toBe(403);
    const deniedAdmin = agent("admin", "!collection:*");
    expect((await request(deniedAdmin, "GET", `/${INDEX}`)).status).toBe(403);
    expect((await request(deniedAdmin, "PUT", `/${INDEX}`, { entryKey: "x", have: true })).status).toBe(403);
    expect(await marksIn()).toEqual([]);
  });
});

describe("what is accepted", () => {
  /** The field names a 422 complains about, whatever the envelope nests them in. */
  const fieldsOf = async (res: Response): Promise<string[]> => {
    const body = await json(res);
    const details = body?.error?.details ?? body?.details ?? {};
    const fields = details.fields ?? details;
    return Object.keys(fields).sort();
  };

  it("a bad key and a bad `have` are one 422 naming both", async () => {
    const res = await request("a", "PUT", `/${INDEX}`, { entryKey: "../etc/passwd", have: "yes" });
    expect(res.status).toBe(422);
    expect(await fieldsOf(res)).toEqual(["entryKey", "have"]);
    expect(await marksIn()).toEqual([]);
  });

  it.each([
    ["empty", ""],
    ["with a space", "ember pup"],
    ["with a slash", "a/b"],
    ["too long", "k".repeat(121)],
    ["not text", 42],
  ])("a key %s is a 422", async (_label, entryKey) => {
    expect((await request("a", "PUT", `/${INDEX}`, { entryKey, have: true })).status).toBe(422);
  });

  it("a key of exactly 120 safe characters is fine", async () => {
    expect((await request("a", "PUT", `/${INDEX}`, { entryKey: `A-z_0.${"k".repeat(114)}`, have: true })).status).toBe(200);
  });

  it("an unknown field is a 422 that suggests the right one", async () => {
    const res = await request("a", "PUT", `/${INDEX}`, { entryKey: "x", hav: true });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await json(res))).toContain("have");
  });

  it("a batch over 2,000 keys, or with one bad key, is refused whole", async () => {
    const big = await request("a", "POST", `/${INDEX}/many`, { entryKeys: Array.from({ length: 2001 }, (_, i) => `k${i}`) });
    expect(big.status).toBe(422);
    const oneBad = await request("a", "POST", `/${INDEX}/many`, { entryKeys: ["good", "bad key", "fine"] });
    expect(oneBad.status).toBe(422);
    expect(await fieldsOf(oneBad)).toEqual(["entryKeys.1"]);
    expect(await marksIn()).toEqual([]);
  });

  it.each([
    ["GET", "/not-a-uuid", undefined],
    ["PUT", "/not-a-uuid", { entryKey: "x", have: true }],
    ["POST", "/not-a-uuid/many", { entryKeys: ["x"] }],
    ["DELETE", "/not-a-uuid", undefined],
  ])("%s on a malformed index is a 404, never a query", async (method, route, body) => {
    expect((await request("a", method, route, body)).status).toBe(404);
  });

  it("an index that does not exist cannot be marked, but unmarking there is harmless", async () => {
    expect((await request("a", "PUT", `/${MADE_UP}`, { entryKey: "x", have: true })).status).toBe(404);
    expect((await request("a", "PUT", `/${MADE_UP}`, { entryKey: "x", have: false })).status).toBe(200);
    expect(await marksIn()).toEqual([]);
  });
});

describe("marking, uploading and emptying", () => {
  it("marking twice keeps one row; unmarking removes it; unmarking again is not an error", async () => {
    const mark = (have: boolean) => request("a", "PUT", `/${INDEX}`, { entryKey: "emberpup", have });
    expect(await json(await mark(true))).toEqual({ data: { entryKey: "emberpup", have: true } });
    expect((await mark(true)).status).toBe(200);
    expect(await marksIn()).toHaveLength(1);
    expect(await json(await mark(false))).toEqual({ data: { entryKey: "emberpup", have: false } });
    expect(await marksIn()).toEqual([]);
    expect((await mark(false)).status).toBe(200);
  });

  it("the batch ADDS to what the account had, drops duplicates, and returns the whole collection", async () => {
    await request("a", "PUT", `/${INDEX}`, { entryKey: "from-account", have: true });
    const res = await json(await request("a", "POST", `/${INDEX}/many`, { entryKeys: ["b1", "b2", "b1", "from-account"] }));
    expect(res.data.marks.sort()).toEqual(["b1", "b2", "from-account"]);
    // Repeating the upload changes nothing.
    const again = await json(await request("a", "POST", `/${INDEX}/many`, { entryKeys: ["b1", "b2"] }));
    expect(again.data.marks.sort()).toEqual(["b1", "b2", "from-account"]);
    expect(await marksIn()).toHaveLength(3);
  });

  it("an empty batch is fine and returns what you had", async () => {
    await fill(ACTORS.a.id, 2);
    expect((await json(await request("a", "POST", `/${INDEX}/many`, { entryKeys: [] }))).data.marks.sort()).toEqual(["k1", "k2"]);
  });

  it("each index is its own collection", async () => {
    await request("a", "PUT", `/${INDEX}`, { entryKey: "creature", have: true });
    await request("a", "PUT", `/${OTHER_INDEX}`, { entryKey: "card", have: true });
    expect((await json(await request("a", "GET", `/${INDEX}`))).data.marks).toEqual(["creature"]);
    expect((await json(await request("a", "GET", `/${OTHER_INDEX}`))).data.marks).toEqual(["card"]);
  });

  it("emptying removes one index of one person, nothing else", async () => {
    await fill(ACTORS.a.id, 2, INDEX);
    await fill(ACTORS.a.id, 2, OTHER_INDEX);
    await fill(ACTORS.b.id, 2, INDEX);
    await request("a", "DELETE", `/${INDEX}`);
    expect(await marksIn(`user_id = '${ACTORS.a.id}' AND dataset_id = '${INDEX}'`)).toEqual([]);
    expect(await marksIn(`user_id = '${ACTORS.a.id}' AND dataset_id = '${OTHER_INDEX}'`)).toHaveLength(2);
    expect(await marksIn(`user_id = '${ACTORS.b.id}'`)).toHaveLength(2);
  });

  it("near the cap, the batch adds only what fits", async () => {
    await fill(ACTORS.b.id, MAX_MARKS - 1);
    const res = await json(await request("b", "POST", `/${INDEX}/many`, { entryKeys: ["n1", "n2", "n3"] }));
    expect(res.data.marks).toHaveLength(MAX_MARKS);
    expect(await marksIn(`user_id = '${ACTORS.b.id}' AND entry_key LIKE 'n%'`)).toHaveLength(1);
    // The cap is per index: another index still takes marks.
    expect((await request("b", "PUT", `/${OTHER_INDEX}`, { entryKey: "x", have: true })).status).toBe(200);
  });

  // Fixed (found by this test): the batch computes the free room (`gap`) and then takes the first
  // `gap` keys of the batch BEFORE knowing which are already marked. A key the account already had
  // uses up the room and is then skipped by ON CONFLICT DO NOTHING, so a new key that fitted is left
  // out. The typical upload (the browser's marks, mostly already in the account) loses marks.
  it("near the cap, a key already in the account does not take the room of a new one", async () => {
    await fill(ACTORS.b.id, MAX_MARKS - 1);
    const res = await json(await request("b", "POST", `/${INDEX}/many`, { entryKeys: ["k1", "new-one"] }));
    expect(res.data.marks).toContain("new-one");
  });

  // Fixed (found by this test): the operation says "Marking twice is not an error", but at the cap
  // the count check runs before the insert, so re-marking a key you ALREADY have answers 409.
  it("at the cap, marking a key you already have is still not an error", async () => {
    await fill(ACTORS.b.id, MAX_MARKS);
    expect((await request("b", "PUT", `/${INDEX}`, { entryKey: "k1", have: true })).status).toBe(200);
  });
});
