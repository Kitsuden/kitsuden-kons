/**
 * kon-autobattler — pages of list-set-comps, and `/comps/{ref}`
 * ============================================================================
 *
 * `list-set-comps` returned every published comp of a set (api-contract,
 * 2026-11-18). It takes `limit` and `offset` now and answers `hasMore` next to
 * `data`; `meta.total` still counts every comp that matches, and with no
 * `limit` the response is what it always was.
 *
 * `/comps/{slug}` (GET) and `/comps/{id}` (DELETE) became `/comps/{ref}`: the
 * URLs and what each route accepts did not change, which the last block checks.
 *
 * Same harness as sec-cards-deckshow-autobattler.test.ts: real routes on PGlite.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { respondError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonAutobattler } from "../../kons/kon-autobattler/index";
import { registerAutobattlerPolicy } from "../../kons/kon-autobattler/autobattler.policy";

const ROOT = resolve(__dirname, "../..");

const ANA = { id: "u-ana", role: "user" };
const EDITOR = { id: "u-ed", role: "editor" };

let client: PGlite;
let app: ReturnType<typeof createKonAutobattler>;

function userFrom(c: any) {
  const raw = c.req.header("x-test-user");
  return raw ? JSON.parse(raw) : null;
}
const fakeAuth = {
  requireAuth: (c: any, next: any) => {
    const u = userFrom(c);
    if (!u) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", u);
    return next();
  },
  optionalAuth: (c: any, next: any) => {
    const u = userFrom(c);
    if (u) c.set("user", u);
    return next();
  },
};

async function call(method: string, path: string, user: object | null, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = JSON.stringify(user);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const SET = {
  slug: "page-set",
  name: "Set de páginas",
  rules: {
    boardRows: 4,
    boardCols: 7,
    itemsPerUnit: 3,
    teamSizeByLevel: { "1": 1, "9": 9 },
    augmentSlots: 3,
    costs: [1, 2, 3, 4, 5],
  },
  entities: [{ kind: "unit", id: "u1", name: "Unidad", data: { cost: 1, traits: [] } }],
};

const comps: Array<{ id: string; slug: string }> = [];

beforeAll(async () => {
  client = new PGlite();
  const dir = join(ROOT, "kons", "kon-autobattler", "migrations");
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  const ctx = createTestKonContext({ db: { instance: drizzle(client) } as any, auth: fakeAuth as any });
  app = createKonAutobattler(ctx);
  app.onError((err, c) => respondError(c, err));
  registerAutobattlerPolicy();

  const imported = await call("POST", "/sets/import", EDITOR, SET);
  expect(imported.status, JSON.stringify(imported.json)).toBe(201);
  for (const title of ["Primera comp", "Segunda comp"]) {
    const r = await call("POST", "/comps", ANA, {
      setSlug: "page-set",
      title,
      level: 1,
      slots: [{ unitId: "u1", row: 0, col: 0 }],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    comps.push({ id: r.json.data.id, slug: r.json.data.slug });
  }
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerAutobattlerPolicy();
});

describe("list-set-comps pages", () => {
  test("limit=1 returns one comp and hasMore: true; the next page is the other", async () => {
    const first = await call("GET", "/sets/page-set/comps?limit=1", null);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.data).toHaveLength(1);
    expect(first.json.hasMore).toBe(true);
    expect(first.json.meta.total).toBe(2);
    const second = await call("GET", "/sets/page-set/comps?limit=1&offset=1", null);
    expect(second.json.data).toHaveLength(1);
    expect(second.json.data[0].id).not.toBe(first.json.data[0].id);
    expect(second.json.hasMore).toBe(false);
  });

  test("without limit it returns every comp, hasMore: false", async () => {
    const all = await call("GET", "/sets/page-set/comps", null);
    expect(all.json.data).toHaveLength(2);
    expect(all.json.meta.total).toBe(2);
    expect(all.json.hasMore).toBe(false);
  });
});

describe("/comps/{ref}: same URLs, same lookups", () => {
  test("GET by slug, DELETE by id", async () => {
    const [comp] = comps;
    expect((await call("GET", `/comps/${comp.slug}`, null)).status).toBe(200);
    // The GET looks up by slug only, as before: the id is not a slug.
    expect((await call("GET", `/comps/${comp.id}`, null)).status).toBe(404);
    expect((await call("DELETE", `/comps/${comp.id}`, ANA)).status).toBe(204);
    expect((await call("GET", `/comps/${comp.slug}`, null)).status).toBe(404);
  });
});
