/**
 * kon-tierlist: `GET /api/tierlist/templates` pages on request, and only then
 * ============================================================================
 *
 * `list-templates` returned every editorial template with no way to page. Now
 * `limit` and `offset` give one page and `hasMore`; without `limit` the answer
 * is what it always was (every template), plus `hasMore: false`. Personal lists
 * never appear. Real migrations on PGlite, as in sec-cards-tierlist.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { respondError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonTierlist } from "../../kons/kon-tierlist/index";
import { registerTierlistPolicy } from "../../kons/kon-tierlist/tierlist.policy";

const ROOT = resolve(__dirname, "../..");
const EDITOR = { id: "u-ed", role: "editor" };
const ANA = { id: "u-ana", role: "user" };

let client: PGlite;
let app: Hono;

function userFrom(c: any) {
  const raw = c.req.header("x-test-user");
  return raw ? JSON.parse(raw) : null;
}

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

beforeAll(async () => {
  client = new PGlite();
  const dir = join(ROOT, "kons/kon-tierlist/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: {
      requireAuth: (c: any, next: any) => {
        const u = userFrom(c);
        if (!u) return c.json({ error: "Unauthorized" }, 401);
        c.set("user", u);
        return next();
      },
    } as any,
  });
  app = new Hono();
  app.use("*", async (c, next) => {
    const u = userFrom(c);
    if (u) c.set("user" as never, u as never);
    await next();
  });
  app.route("/", createKonTierlist(ctx));
  app.onError((err, c) => respondError(c, err));
  registerTierlistPolicy();

  for (const slug of ["tpl-a", "tpl-b", "tpl-c"]) {
    const r = await call("PUT", "/templates", EDITOR, {
      slug,
      title: slug,
      items: [{ id: "x", label: "X" }],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }
  // A personal list (a fork) is not a template and must not show up.
  const fork = await call("POST", "/templates/tpl-a/fork", ANA, {});
  expect(fork.status, JSON.stringify(fork.json)).toBe(201);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => registerTierlistPolicy());

describe("GET /templates", () => {
  it("without `limit`, every template, and `hasMore: false`", async () => {
    const { status, json } = await call("GET", "/templates", null);
    expect(status).toBe(200);
    expect(json.data.map((t: { slug: string }) => t.slug).sort()).toEqual(["tpl-a", "tpl-b", "tpl-c"]);
    expect(json.hasMore).toBe(false);
  });

  it("`limit=1` gives one template and `hasMore: true`; the pages cover every template once", async () => {
    const first = await call("GET", "/templates?limit=1", null);
    expect(first.status).toBe(200);
    expect(first.json.data).toHaveLength(1);
    expect(first.json.hasMore).toBe(true);

    const seen: string[] = [];
    for (let offset = 0; offset < 3; offset++) {
      const page = await call("GET", `/templates?limit=1&offset=${offset}`, null);
      seen.push(page.json.data[0].slug);
      expect(page.json.hasMore).toBe(offset < 2);
    }
    expect(seen.sort()).toEqual(["tpl-a", "tpl-b", "tpl-c"]);
  });

  it("a page size outside 1-500 is refused", async () => {
    expect((await call("GET", "/templates?limit=0", null)).status).toBeGreaterThanOrEqual(400);
    expect((await call("GET", "/templates?limit=501", null)).status).toBeGreaterThanOrEqual(400);
  });
});
