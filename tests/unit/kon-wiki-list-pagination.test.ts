/**
 * kon-wiki: `GET /api/wiki/wikis` pages on request, and only then
 * ============================================================================
 *
 * `list-wikis` returned every wiki with no way to page (one per game, and the
 * catalogue of games grows). Now `limit` and `offset` give one page and
 * `hasMore`; without `limit` the answer is what it always was, plus
 * `hasMore: false`. `total` keeps counting every matching wiki. Real migrations
 * on PGlite, as in kon-wiki-create-conflict.test.ts.
 *
 * `list-pages` (`GET /wikis/:wiki/pages`) stopped at `limit` (100 by default)
 * with no way past it. It keeps that `limit`, takes `offset`, and adds
 * `hasMore`; `total` is still the size of the page answered.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { respondError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonWiki } from "../../kons/kon-wiki/index";
import { registerWikiPolicy } from "../../kons/kon-wiki/wiki.policy";

const ADMIN = { id: "u-admin", role: "admin" };
const GAMES = [
  "00000000-0000-4000-8000-00000000000a",
  "00000000-0000-4000-8000-00000000000b",
  "00000000-0000-4000-8000-00000000000c",
];

let client: PGlite;
let app: Hono;

const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  client = new PGlite();
  const dir = join(__dirname, "../../kons/kon-wiki/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  const requireAuth = async (c: any, next: any) =>
    c.get("user") ? next() : c.json({ error: "Unauthorized" }, 401);
  const ctx = createTestKonContext({ db: { instance: drizzle(client) } as any, auth: { requireAuth } as any });
  app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.use("*", async (c, next) => {
    const raw = c.req.header("x-test-user");
    c.set("user" as never, (raw ? JSON.parse(raw) : null) as never);
    await next();
  });
  app.route("/", createKonWiki(ctx));

  registerWikiPolicy();
  for (const [i, gameId] of GAMES.entries()) {
    const res = await app.request("/wikis", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": JSON.stringify(ADMIN) },
      body: JSON.stringify({ title: `Wiki ${i}`, slug: `wiki-${i}`, gameId }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
  }
  for (const slug of ["alpha", "beta", "gamma"]) {
    const res = await app.request(`/wikis/wiki-0/pages/${slug}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-test-user": JSON.stringify(ADMIN) },
      body: JSON.stringify({ title: slug, content: `# ${slug}` }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  }
  // An import writes several pages in the same instant: only the id orders them.
  await client.query("UPDATE wiki_pages SET updated_at = '2030-01-01T00:00:00Z'");
});

beforeEach(() => {
  registerWikiPolicy();
});

afterAll(async () => {
  await client?.close();
});

describe("GET /wikis", () => {
  it("without `limit`, every wiki, and `hasMore: false`", async () => {
    const { status, body } = await get("/wikis");
    expect(status).toBe(200);
    expect(body.docs).toHaveLength(3);
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(false);
  });

  it("`limit=1` gives one wiki and `hasMore: true`; the pages cover every wiki once", async () => {
    const first = await get("/wikis?limit=1");
    expect(first.status).toBe(200);
    expect(first.body.docs).toHaveLength(1);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.total).toBe(3);

    const seen = new Set<string>();
    for (let offset = 0; offset < 3; offset++) {
      const page = await get(`/wikis?limit=1&offset=${offset}`);
      seen.add(page.body.docs[0].id);
      expect(page.body.hasMore).toBe(offset < 2);
    }
    expect(seen.size).toBe(3);
  });

  it("`game` still filters, with or without a page", async () => {
    const one = await get(`/wikis?game=${GAMES[1]}&limit=5`);
    expect(one.body.docs.map((w: { slug: string }) => w.slug)).toEqual(["wiki-1"]);
    expect(one.body.total).toBe(1);
    expect(one.body.hasMore).toBe(false);
  });
});

describe("GET /wikis/:wiki/pages", () => {
  it("without parameters: every page, as before, `total` its size and `hasMore: false`", async () => {
    const { status, body } = await get("/wikis/wiki-0/pages");
    expect(status).toBe(200);
    expect(body.wiki.slug).toBe("wiki-0");
    expect(body.docs.map((p: { slug: string }) => p.slug).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(false);
  });

  it("`limit=1` has more; `limit=1&offset=1` is the second row of the whole index", async () => {
    const all = await get("/wikis/wiki-0/pages");
    const first = await get("/wikis/wiki-0/pages?limit=1");
    expect(first.body.docs).toHaveLength(1);
    expect(first.body.total).toBe(1);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.docs[0].slug).toBe(all.body.docs[0].slug);

    const second = await get("/wikis/wiki-0/pages?limit=1&offset=1");
    expect(second.body.docs[0].slug).toBe(all.body.docs[1].slug);
    expect(second.body.hasMore).toBe(true);

    const last = await get("/wikis/wiki-0/pages?limit=1&offset=2");
    expect(last.body.docs[0].slug).toBe(all.body.docs[2].slug);
    expect(last.body.hasMore).toBe(false);
  });

  it("a negative `offset` is a 422; a non-numeric `limit` is still the default", async () => {
    expect((await get("/wikis/wiki-0/pages?offset=-1")).status).toBe(422);
    const lenient = await get("/wikis/wiki-0/pages?limit=abc");
    expect(lenient.status).toBe(200);
    expect(lenient.body.docs).toHaveLength(3);
  });
});
