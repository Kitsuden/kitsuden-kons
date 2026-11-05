/**
 * kon-analytics over HTTP: what is counted, what is ranked, and who is turned away
 * ============================================================================
 *
 * `analytics-without-personal-data` pins the table's shape and the source text; the
 * collection-and-analytics security test checks that a made-up subject is not counted. Here the
 * three operations run for real, behind the same per-request RLS transaction the host opens
 * (`rlsHost`), on PGlite with the kon's own migrations and a non-superuser role:
 *
 *   · `hit` adds exactly one view per request (also under concurrency), drops bots, rejects a bad
 *     type or id with 400 and leaves no row behind;
 *   · a subject whose kon is not installed, or whose table has another shape, is still counted, and
 *     the failed existence check does not abort the request's transaction (the SAVEPOINT the code
 *     comment promises);
 *   · `top` sums the window, orders, bounds `days` and `limit`, filters by type and by `ids`;
 *   · `subject` returns the series oldest first with its total;
 *   · everything is public, but an agent key that DENIES an operation is refused even there.
 *
 * The migrations are listed from the kon's folder, never named: they are being renamed.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { analyticsOperations, createKonAnalytics } from "../../kons/kon-analytics";

import { APP_ROLE, dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

const KON = "kon-analytics";
const migrations = () =>
  readdirSync(resolve(__dirname, `../../kons/${KON}/migrations`))
    .filter((f) => f.endsWith(".sql"))
    .sort();

// Subjects that exist in their own (fake) kon tables.
const GAME = "11111111-1111-4111-8111-111111111111";
const GAME_2 = "11111111-1111-4111-8111-111111111112";
const GAME_3 = "11111111-1111-4111-8111-111111111113";
const POST = "22222222-2222-4222-8222-222222222222";
const STREAMER = "55555555-5555-4555-8555-555555555555";
const TOURNAMENT = "66666666-6666-4666-8666-666666666666";
const MADE_UP = "99999999-9999-4999-8999-999999999999";

let client: PGlite;
let request: ReturnType<typeof requestAs>;

/** A date `n` days ago, the way the kon writes `day` (UTC, YYYY-MM-DD). */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** A uuid built from a number, for seeding many subjects. */
const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function seed(rows: Array<[type: string, id: string, ago: number, views: number]>) {
  for (const [type, id, ago, views] of rows) {
    await client.query(
      "INSERT INTO analytics_views (subject_type, subject_id, day, views) VALUES ($1, $2, $3, $4)",
      [type, id, daysAgo(ago), views]
    );
  }
}

const views = async () =>
  (
    await client.query<{ subject_type: string; subject_id: string; views: number }>(
      "SELECT subject_type, subject_id, views FROM analytics_views ORDER BY subject_type, subject_id"
    )
  ).rows;

const hit = (body: unknown, extra: Record<string, string> = {}) =>
  request("anon", "POST", "/hit", body, { "user-agent": "Mozilla/5.0 (X11; Linux) Firefox/131.0", ...extra });

const json = async (res: Response): Promise<any> => res.json();

beforeAll(async () => {
  client = await migratedBase(KON, migrations());
  // The subjects' own tables, as their kons would leave them: `games` with uuid ids, `blog_posts`
  // with text ids, and a `streamers` table of ANOTHER shape (no `id` column), so the existence
  // check fails inside the request. `esports_tournaments` does not exist: that kon is not installed.
  await client.exec(`
    CREATE TABLE games (id uuid PRIMARY KEY, name text);
    INSERT INTO games VALUES ('${GAME}', 'G1'), ('${GAME_2}', 'G2'), ('${GAME_3}', 'G3');
    CREATE TABLE blog_posts (id text PRIMARY KEY, title text);
    INSERT INTO blog_posts VALUES ('${POST}', 'Guide');
    CREATE TABLE streamers (handle text PRIMARY KEY);
    GRANT SELECT ON games, blog_posts, streamers TO ${APP_ROLE};
  `);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never } as never);
  request = requestAs(host.mount(createKonAnalytics(ctx)));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.query("DELETE FROM analytics_views");
});

// ════════════════════════════════════════════════════════════════════════════

describe("hit: one request, one view", () => {
  it("two views of the same subject on the same day are one row with 2, and the answer is an empty 204", async () => {
    const first = await hit({ type: "game", id: GAME });
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    await hit({ type: "game", id: GAME });
    expect(await views()).toEqual([{ subject_type: "game", subject_id: GAME, views: 2 }]);
  });

  it("ten views at once are ten: the UPSERT does not lose any", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => hit({ type: "game", id: GAME })));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(204));
    expect(await views()).toEqual([{ subject_type: "game", subject_id: GAME, views: 10 }]);
  });

  it("each subject and type keeps its own counter (a text-id table is checked too)", async () => {
    await hit({ type: "game", id: GAME });
    await hit({ type: "blog_post", id: POST });
    await hit({ type: "game", id: GAME_2 });
    expect(await views()).toEqual([
      { subject_type: "blog_post", subject_id: POST, views: 1 },
      { subject_type: "game", subject_id: GAME, views: 1 },
      { subject_type: "game", subject_id: GAME_2, views: 1 },
    ]);
  });

  it("a bot gets the same 204 and counts nothing", async () => {
    for (const agent of ["Mozilla/5.0 (compatible; Googlebot/2.1)", "Discordbot/2.0", "Lighthouse"]) {
      expect((await hit({ type: "game", id: GAME }, { "user-agent": agent })).status).toBe(204);
    }
    expect(await views()).toEqual([]);
  });

  it("a number of views in the body is ignored, even a negative one", async () => {
    await hit({ type: "game", id: GAME, views: -1000, count: 50 });
    expect(await views()).toEqual([{ subject_type: "game", subject_id: GAME, views: 1 }]);
  });

  it.each([
    ["an unknown type", { type: "deck", id: GAME }],
    ["a type with odd case", { type: "GAME", id: GAME }],
    ["an id that is not a uuid", { type: "game", id: "1 OR 1=1" }],
    ["a uuid with something after it", { type: "game", id: `${GAME}x` }],
    ["no id", { type: "game" }],
    ["an array", [{ type: "game", id: GAME }]],
  ])("400 for %s, and no row", async (_label, body) => {
    const res = await hit(body);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid type or id");
    expect(await views()).toEqual([]);
  });

  it("400 with no body or a body that is not JSON", async () => {
    expect((await hit(undefined)).status).toBe(400);
    expect((await hit("{not json")).status).toBe(400);
    expect(await views()).toEqual([]);
  });

  it("a null character never reaches Postgres: 422, not a 500", async () => {
    const res = await hit({ type: "game", id: "\u0000" });
    expect(res.status).toBe(422);
    expect(await views()).toEqual([]);
  });

  it("a subject that does not exist answers the same 204 as one that does", async () => {
    const real = await hit({ type: "game", id: GAME });
    const fake = await hit({ type: "game", id: MADE_UP });
    expect(fake.status).toBe(real.status);
    expect(await fake.text()).toBe(await real.text());
    expect(await views()).toEqual([{ subject_type: "game", subject_id: GAME, views: 1 }]);
  });

  it("a subject whose kon is not installed is still counted", async () => {
    expect((await hit({ type: "tournament", id: TOURNAMENT })).status).toBe(204);
    expect(await views()).toEqual([{ subject_type: "tournament", subject_id: TOURNAMENT, views: 1 }]);
  });

  it("a subject table of another shape is counted, and the failed check does not abort the request's transaction", async () => {
    // `SELECT 1 FROM streamers WHERE id = …` fails (no `id` column). Without the SAVEPOINT the
    // request's transaction would be aborted and the INSERT after it would fail too.
    const res = await hit({ type: "streamer", id: STREAMER });
    expect(res.status).toBe(204);
    expect(await views()).toEqual([{ subject_type: "streamer", subject_id: STREAMER, views: 1 }]);
  });
});

describe("top: the most viewed in a window", () => {
  it("sums the days of the window, most viewed first, with integer counts", async () => {
    await seed([
      ["game", GAME, 0, 3],
      ["game", GAME, 2, 4],
      ["game", GAME_2, 1, 10],
      ["game", GAME_3, 5, 1],
    ]);
    const res = await request("anon", "GET", "/top");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      type: "game",
      days: 30,
      docs: [
        { subjectId: GAME_2, views: 10 },
        { subjectId: GAME, views: 7 },
        { subjectId: GAME_3, views: 1 },
      ],
    });
  });

  it("leaves out what is older than `days`", async () => {
    await seed([
      ["game", GAME, 0, 1],
      ["game", GAME_2, 40, 100],
    ]);
    expect((await json(await request("anon", "GET", "/top?days=30"))).docs).toEqual([{ subjectId: GAME, views: 1 }]);
    expect((await json(await request("anon", "GET", "/top?days=60"))).docs).toEqual([
      { subjectId: GAME_2, views: 100 },
      { subjectId: GAME, views: 1 },
    ]);
  });

  it("bounds `days` to 1-365: a huge window does not scan the whole table, and nonsense falls back to 30", async () => {
    await seed([
      ["game", GAME, 300, 5],
      ["game", GAME_2, 400, 50],
    ]);
    const huge = await json(await request("anon", "GET", "/top?days=100000"));
    expect(huge.days).toBe(365);
    expect(huge.docs).toEqual([{ subjectId: GAME, views: 5 }]);
    expect((await json(await request("anon", "GET", "/top?days=abc"))).days).toBe(30);
    expect((await json(await request("anon", "GET", "/top?days=0"))).days).toBe(30);
    expect((await json(await request("anon", "GET", "/top?days=-5"))).days).toBe(1);
  });

  it("returns 5 by default, at most 50, at least 1", async () => {
    await seed(Array.from({ length: 60 }, (_, i) => ["game", uuidOf(i + 1), 0, i + 1] as [string, string, number, number]));
    const byDefault = (await json(await request("anon", "GET", "/top"))).docs;
    expect(byDefault).toHaveLength(5);
    expect(byDefault[0]).toEqual({ subjectId: uuidOf(60), views: 60 });
    expect((await json(await request("anon", "GET", "/top?limit=1000"))).docs).toHaveLength(50);
    expect((await json(await request("anon", "GET", "/top?limit=-3"))).docs).toHaveLength(1);
  });

  it("ranks one type only, `game` by default", async () => {
    await seed([
      ["game", GAME, 0, 1],
      ["blog_post", POST, 0, 99],
    ]);
    expect((await json(await request("anon", "GET", "/top"))).docs).toEqual([{ subjectId: GAME, views: 1 }]);
    expect((await json(await request("anon", "GET", "/top?type=blog_post"))).docs).toEqual([{ subjectId: POST, views: 99 }]);
  });

  it("400 for an unknown type", async () => {
    const res = await request("anon", "GET", "/top?type=users");
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid type");
  });

  it("`ids` ranks only inside the set, dropping anything that is not a uuid", async () => {
    await seed([
      ["game", GAME, 0, 1],
      ["game", GAME_2, 0, 50],
      ["game", GAME_3, 0, 7],
    ]);
    const docs = (await json(await request("anon", "GET", `/top?ids=${GAME},${GAME_3},drop-me,' OR 1=1`))).docs;
    expect(docs).toEqual([
      { subjectId: GAME_3, views: 7 },
      { subjectId: GAME, views: 1 },
    ]);
  });

  it("`ids` takes at most a hundred: the 101st is ignored", async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => uuidOf(i + 1));
    await seed([["game", GAME, 0, 9]]);
    const docs = (await json(await request("anon", "GET", `/top?ids=${[...hundred, GAME].join(",")}`))).docs;
    expect(docs).toEqual([]);
  });

  // Fixed (found by this test): when every value in `ids` is malformed, the filter becomes an
  // empty list and the handler drops it (`ids.length > 0 ? inArray(...) : undefined`), so the answer
  // is the GLOBAL ranking, i.e. subjects OUTSIDE the set the caller asked about. The esports
  // "trends" block, which passes its own entries' ids, would then show the blog's top entries.
  it("`ids` with nothing valid in it returns nothing, never the subjects outside the set", async () => {
    await seed([["game", GAME_2, 0, 50]]);
    const docs = (await json(await request("anon", "GET", "/top?ids=not-a-uuid"))).docs;
    expect(docs).toEqual([]);
  });
});

describe("subject: one subject's series", () => {
  it("returns the days oldest first, with the total, inside the window", async () => {
    await seed([
      ["game", GAME, 0, 2],
      ["game", GAME, 3, 5],
      ["game", GAME, 1, 1],
      ["game", GAME, 90, 1000],
      ["game", GAME_2, 0, 77],
      ["blog_post", GAME, 0, 33],
    ]);
    const res = await request("anon", "GET", `/subject/game/${GAME}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      type: "game",
      id: GAME,
      days: 30,
      total: 8,
      docs: [
        { day: daysAgo(3), views: 5 },
        { day: daysAgo(1), views: 1 },
        { day: daysAgo(0), views: 2 },
      ],
    });
    expect((await json(await request("anon", "GET", `/subject/game/${GAME}?days=365`))).total).toBe(1008);
  });

  it("a subject with no views is an empty series, not a 404", async () => {
    expect(await json(await request("anon", "GET", `/subject/wiki/${MADE_UP}`))).toEqual({
      type: "wiki",
      id: MADE_UP,
      days: 30,
      total: 0,
      docs: [],
    });
  });

  it.each([
    ["an unknown type", `/subject/user/${GAME}`],
    ["an id that is not a uuid", "/subject/game/1%20OR%201%3D1"],
  ])("400 for %s", async (_label, route) => {
    expect((await request("anon", "GET", route)).status).toBe(400);
  });
});

describe("who may call it", () => {
  it("all three operations are open to anyone, signed in or not", async () => {
    await seed([["game", GAME, 0, 1]]);
    for (const actor of ["anon", "a", "admin"] as const) {
      expect((await request(actor, "GET", "/top")).status).toBe(200);
      expect((await request(actor, "GET", `/subject/game/${GAME}`)).status).toBe(200);
    }
    expect((await request({ agent: ["mcp:connect"] }, "GET", "/top")).status).toBe(200);
  });

  it("a key that denies `add-view` is refused even though the route is public, and counts nothing", async () => {
    const res = await request({ agent: ["admin", "!kon:analytics:add-view"] }, "POST", "/hit", { type: "game", id: GAME });
    expect(res.status).toBe(403);
    expect(await views()).toEqual([]);
  });

  it("`!analytics:*` closes the reads as well", async () => {
    const denied = { agent: ["mcp:connect", "!analytics:*"] };
    expect((await request(denied, "GET", "/top")).status).toBe(403);
    expect((await request(denied, "GET", `/subject/game/${GAME}`)).status).toBe(403);
  });

  it("counting a view is not an MCP tool (an agent reading is not a browser view); the reads are", () => {
    const ops = analyticsOperations(createTestKonContext({ db: { instance: {} } as never }));
    const byId = Object.fromEntries(ops.map((o) => [o.id, o]));
    expect((byId["add-view"]!.mcp as { exclude?: string } | undefined)?.exclude).toBeTruthy();
    expect(byId["get-most-viewed"]!.mcp).toBeUndefined();
    expect(byId["get-subject-series"]!.mcp).toBeUndefined();
    expect(ops.every((o) => o.access === "public")).toBe(true);
  });
});
