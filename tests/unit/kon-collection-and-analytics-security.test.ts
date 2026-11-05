/**
 * kon-collection and kon-analytics — personal data does not cross over, and public
 * data is not filled from outside
 * ============================================================================
 *
 * Against PGlite. Security review of 2026-10-15.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { respondError } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

const USERS: Record<string, { id: string; role: string }> = {
  alicia: { id: "u-alicia", role: "user" },
  bruno: { id: "u-bruno", role: "user" },
  // Phase D: an agent arrives with role "agent" and its scopes.
  agent: { id: "ag-nulo", role: "agent", scopes: ["mcp:connect"] } as any,
  collectionAgent: { id: "ag-col", role: "agent", scopes: ["collection:*"] } as any,
};
const DATASET = "22222222-2222-4222-8222-222222222222";
const MADE_UP = "33333333-3333-4333-8333-333333333333";
const GAME = "44444444-4444-4444-8444-444444444444";

let client: PGlite;
let collection: any;
let analytics: any;
let collectionModule: any;
let registerPolicy: () => void;

const who = (c: any) => USERS[c.req.header("x-test-user") ?? ""];

async function request(
  app: any,
  user: string | null,
  method: string,
  route: string,
  body?: unknown
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user;
  const res = await app.request(route, {
    method: method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status as number, json: (await res.json().catch(() => null)) as any };
}

beforeAll(async () => {
  client = new PGlite();
  for (const f of [
    "../../kons/kon-collection/migrations/0001_collection.sql",
    "../../kons/kon-analytics/migrations/0000_analytics.sql",
  ]) {
    await client.exec(readFileSync(resolve(__dirname, f), "utf8"));
  }
  await client.exec(
    "CREATE TABLE data_sets (id uuid PRIMARY KEY, name text);" +
      `INSERT INTO data_sets VALUES ('${DATASET}', 'Índice');` +
      "CREATE TABLE games (id uuid PRIMARY KEY, name text);" +
      `INSERT INTO games VALUES ('${GAME}', 'Juego');`
  );

  const db = drizzle(client);
  const auth = {
    requireAuth: (c: any, next: any) => {
      const u = who(c);
      if (!u) return c.json({ error: "Unauthorized" }, 401);
      c.set("user", u);
      return next();
    },
  };

  collectionModule = await import("../../kons/kon-collection/index");
  registerPolicy = (await import("../../kons/kon-collection/collection.policy"))
    .registerCollectionPolicy;
  collection = collectionModule.createKonCollection(
    createTestKonContext({ db: { instance: db } as any, auth: auth as any })
  );
  collection.onError((err: unknown, c: any) => respondError(c, err));

  const analyticsModule = await import("../../kons/kon-analytics/index");
  analytics = analyticsModule.createKonAnalytics(
    createTestKonContext({ db: { instance: db } as any })
  );
});

beforeEach(async () => {
  registerPolicy();
  await client.exec("DELETE FROM collection_marks; DELETE FROM analytics_views;");
});

afterAll(async () => {
  await client?.close();
});

describe("collection: each one has their own", () => {
  test("Bruno neither reads nor empties Alicia's collection", async () => {
    await request(collection, "alicia", "PUT", `/${DATASET}`, { entryKey: "emberpup", have: true });

    const ofBruno = await request(collection, "bruno", "GET", `/${DATASET}`);
    expect(ofBruno.json.data.marks).toEqual([]);

    await request(collection, "bruno", "DELETE", `/${DATASET}`);
    const ofAlicia = await request(collection, "alicia", "GET", `/${DATASET}`);
    expect(ofAlicia.json.data.marks).toEqual(["emberpup"]);
  });

  test("you cannot mark on behalf of another: the userId in the body does not count", async () => {
    const r = await request(collection, "bruno", "PUT", `/${DATASET}`, {
      entryKey: "x",
      have: true,
      userId: "u-alicia",
    });
    expect(r.status).toBe(422);
    const rows: any = await client.query("SELECT user_id FROM collection_marks");
    expect(rows.rows).toEqual([]);
  });

  test("an agent without the collection scope does not mark (phase D: before 200)", async () => {
    const r = await request(collection, "agent", "PUT", `/${DATASET}`, { entryKey: "x", have: true });
    expect(r.status).toBe(403);
    const batch = await request(collection, "agent", "POST", `/${DATASET}/many`, { entryKeys: ["a", "b"] });
    expect(batch.status).toBe(403);
    const n: any = await client.query("SELECT count(*)::int AS n FROM collection_marks");
    expect(n.rows[0].n).toBe(0);
    // With its scope, yes (and in its own name).
    const ok = await request(collection, "collectionAgent", "PUT", `/${DATASET}`, { entryKey: "x", have: true });
    expect(ok.status).toBe(200);
  });

  test("without a session there is nothing", async () => {
    expect((await request(collection, null, "GET", `/${DATASET}`)).status).toBe(401);
  });

  test("the table cannot be filled with made-up indexes", async () => {
    const one = await request(collection, "bruno", "PUT", `/${MADE_UP}`, {
      entryKey: "x",
      have: true,
    });
    expect(one.status).toBe(404);
    const batch = await request(collection, "bruno", "POST", `/${MADE_UP}/many`, {
      entryKeys: Array.from({ length: 2000 }, (_, i) => `k${i}`),
    });
    expect(batch.status).toBe(404);
    const n: any = await client.query("SELECT count(*)::int AS n FROM collection_marks");
    expect(n.rows[0].n).toBe(0);
  });

  test("and on a real index there is a per-person cap", async () => {
    const before = collectionModule.MAX_MARKS;
    // The cap is a module constant; here it is tested with its real value
    // trimming the batch so as not to generate 20,000 rows.
    expect(before).toBe(20_000);
    await client.query(
      `INSERT INTO collection_marks (user_id, dataset_id, entry_key)
       SELECT 'u-bruno', '${DATASET}', 'k' || g FROM generate_series(1, 20000) g`
    );
    const one = await request(collection, "bruno", "PUT", `/${DATASET}`, {
      entryKey: "newItem",
      have: true,
    });
    expect(one.status).toBe(409);
    const batch = await request(collection, "bruno", "POST", `/${DATASET}/many`, {
      entryKeys: ["otra1", "otra2"],
    });
    expect(batch.json.data.marks).toHaveLength(20_000);
    // Unmarking is always allowed.
    expect(
      (await request(collection, "bruno", "PUT", `/${DATASET}`, { entryKey: "k1", have: false }))
        .status
    ).toBe(200);
  });
});

describe("analytics: no personal data and no inflation from what does not exist", () => {
  const hit = (body: unknown, agent = "Mozilla/5.0") =>
    analytics.request("/hit", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": agent },
      body: JSON.stringify(body),
    });

  test("a subject that does not exist creates no rows (and responds the same)", async () => {
    const r = await hit({ type: "game", id: MADE_UP });
    expect(r.status).toBe(204);
    const n: any = await client.query("SELECT count(*)::int AS n FROM analytics_views");
    expect(n.rows[0].n).toBe(0);
  });

  test("one that exists adds ONE view per request, whatever the body says", async () => {
    await hit({ type: "game", id: GAME, views: 1000 });
    const r: any = await client.query("SELECT views FROM analytics_views");
    expect(r.rows).toEqual([{ views: 1 }]);
  });

  test("the table stores no IP, agent or anything that identifies", async () => {
    const cols: any = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'analytics_views' ORDER BY column_name"
    );
    expect(cols.rows.map((c: any) => c.column_name)).toEqual([
      "created_at",
      "day",
      "id",
      "subject_id",
      "subject_type",
      "updated_at",
      "views",
    ]);
  });

  test("hit declares its own per-connection limit (the general one is for reading)", async () => {
    const { kon } = await import("../../kons/kon-analytics/index");
    const rule = kon.rateLimits?.find((r) => r.path === "/hit");
    expect(rule).toBeDefined();
    expect(rule!.limit).toBeLessThanOrEqual(60);
  });
});
