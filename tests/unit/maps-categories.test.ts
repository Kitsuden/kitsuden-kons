/**
 * kon-maps: the whole flow over HTTP (phase D, 2026-10-25)
 * ============================================================================
 *
 * `POST /maps/:slug/markers` requires each marker to point to a category
 * in `map_categories`, and NO route wrote that table: through the API you
 * could not import a single marker (422 "The category … does not exist" every time).
 * `PUT /maps` now accepts `categories` and upserts them by id.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { respondError } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonMaps } from "../../kons/kon-maps/index";
import { registerMapsPolicy } from "../../kons/kon-maps/maps.policy";

const EDITOR = { id: "u-editor", role: "editor" };

let client: PGlite;
let maps: Hono;

function request(method: string, route: string, user: object | null, body?: unknown) {
  return maps.request(route, {
    method: method,
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => registerMapsPolicy());
afterAll(async () => client?.close());

beforeAll(async () => {
  client = new PGlite();
  const dir = join(__dirname, "../../kons/kon-maps/migrations");
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  const requireAuth = async (c: any, next: any) =>
    c.get("user") ? next() : c.json({ error: "Unauthorized" }, 401);
  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: { requireAuth } as any,
  });
  const app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.use("*", async (c, next) => {
    const rawValue = c.req.header("x-test-user");
    c.set("user" as never, (rawValue ? JSON.parse(rawValue) : null) as never);
    await next();
  });
  app.route("/", createKonMaps(ctx));
  maps = app;
});

const def = {
  name: "Valle",
  imageUrl: "/media/valle.webp",
  aspectRatio: 1.5,
  layers: [{ id: "superficie", name: "Superficie" }],
};

describe("kon-maps: map → categories → markers → public read", () => {
  it("the PUT's categories allow importing markers", async () => {
    const put = await request("PUT", "/maps", EDITOR, {
      slug: "valle",
      definition: def,
      categories: [{ id: "cofre", name: "Cofres", color: "#ffaa00" }],
    });
    expect(put.status).toBe(201);

    const imp = await request("POST", "/maps/valle/markers", EDITOR, {
      markers: [
        { layerId: "superficie", categoryId: "cofre", x: 0.25, y: 0.5, title: "Cofre 1" },
        { layerId: "superficie", categoryId: "cofre", x: 0.26, y: 0.51, title: "Cofre 2" },
      ],
    });
    expect(imp.status).toBe(201);

    const read = await request("GET", "/maps/valle", null);
    const body = (await read.json()) as any;
    expect(body.categories.map((c: any) => [c.categoryId, c.color])).toEqual([
      ["cofre", "#ffaa00"],
    ]);
    expect(body.markers).toHaveLength(2);
  });

  it("saving again without categories does not delete the existing ones; with them, it updates them", async () => {
    expect((await request("PUT", "/maps", EDITOR, { slug: "valle", definition: def })).status).toBe(
      200
    );
    let body = (await (await request("GET", "/maps/valle", null)).json()) as any;
    expect(body.categories).toHaveLength(1);

    await request("PUT", "/maps", EDITOR, {
      slug: "valle",
      definition: def,
      categories: [
        { id: "cofre", name: "Cofres grandes" },
        { id: "jefe", name: "Jefes", icon: "skull" },
      ],
    });
    body = (await (await request("GET", "/maps/valle", null)).json()) as any;
    const byId = Object.fromEntries(body.categories.map((c: any) => [c.categoryId, c.name]));
    expect(byId).toEqual({ cofre: "Cofres grandes", jefe: "Jefes" });
  });

  it("a malformed category is 400", async () => {
    for (const categories of [
      [{ id: "a", name: "A", color: "red;}" }],
      [
        { id: "a", name: "A" },
        { id: "a", name: "B" },
      ],
    ]) {
      const r = await request("PUT", "/maps", EDITOR, { slug: "valle", definition: def, categories });
      expect(r.status, JSON.stringify(categories)).toBe(400);
    }
  });
});
