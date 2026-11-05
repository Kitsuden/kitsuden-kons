/**
 * kon-wiki: creating a wiki whose slug is taken answers 409
 * ============================================================================
 *
 * `create-wiki` built the message as «A wiki named « already exists<slug>».» and
 * then decided the status with `startsWith("Already exists")`, which never matched:
 * a taken slug answered 400 with a garbled message. It must be 409 with a clear one.
 *
 * Against PGlite with the kon's migrations (same setup as sec-data-wiki-maps-formulas).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { respondError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import manifest from "../../kons/kon-wiki/kon.json" with { type: "json" };
import { createKonWiki, kon } from "../../kons/kon-wiki/index";
import { registerWikiPolicy } from "../../kons/kon-wiki/wiki.policy";

const ADMIN = { id: "u-admin", role: "admin" };
const GAME_A = "00000000-0000-4000-8000-00000000000a";
const GAME_B = "00000000-0000-4000-8000-00000000000b";
const GAME_C = "00000000-0000-4000-8000-00000000000c";

let client: PGlite;
let app: Hono;

const create = (body: unknown) =>
  app.request("/wikis", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": JSON.stringify(ADMIN) },
    body: JSON.stringify(body),
  });

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
});

beforeEach(() => {
  registerWikiPolicy();
});

afterAll(async () => {
  await client?.close();
});

describe("create-wiki", () => {
  it("a taken slug answers 409 with a clear English message", async () => {
    const first = await create({ title: "Elden Ring", slug: "elden", gameId: GAME_A });
    expect(first.status, await first.clone().text()).toBe(201);

    const again = await create({ title: "Elden again", slug: "elden", gameId: GAME_B });
    expect(again.status).toBe(409);
    const body = (await again.json()) as { error: string; field: string };
    expect(body.field).toBe("slug");
    expect(body.error).toBe('A wiki with the slug "elden" already exists.');
  });

  it("a game that already has a wiki answers 409; an invalid slug stays 400", async () => {
    const sameGame = await create({ title: "Other", slug: "other", gameId: GAME_A });
    expect(sameGame.status).toBe(409);
    expect(((await sameGame.json()) as { field: string }).field).toBe("gameId");

    const invalid = await create({ title: "Bad", slug: "-bad-", gameId: GAME_C });
    expect(invalid.status).toBe(400);
  });
});

describe("admin views", () => {
  it("the kon definition declares the same admin views as kon.json", () => {
    expect(kon.admin?.category).toBe(manifest.admin.category);
    expect(kon.admin?.views?.map((v) => [v.id, v.type, v.title, v.table ?? null])).toEqual(
      manifest.admin.views.map((v) => [v.id, v.type, v.title, (v as { table?: string }).table ?? null])
    );
  });
});
