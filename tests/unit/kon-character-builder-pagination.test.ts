/**
 * kon-character-builder: pages of the gallery, `GET /api/builder/builds` (list-builds)
 * ============================================================================
 *
 * The gallery took `limit` (1-100, default 24) and had no way past it: builds
 * beyond the first page were unreachable (api-contract, 2026-11-18). It keeps
 * that `limit`, takes `offset`, orders by votes, publication date and then id,
 * and adds `hasMore` next to `docs`. Same harness as
 * kon-builder-security.test.ts (PGlite, test users by header).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { respondError } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

const USERS: Record<string, { id: string; role: string; name: string }> = {
  alicia: { id: "u-alicia", role: "user", name: "Alicia" },
  bruno: { id: "u-bruno", role: "user", name: "Bruno" },
};

let client: PGlite;
let app: any;
let registerPolicy: () => void;

const who = (c: any) => USERS[c.req.header("x-test-user") ?? ""];
const PLAN = "link:grim-dawn:/grim-dawn/calculadora";
const GALLERY = `/builds?builder=${encodeURIComponent(PLAN)}`;

async function request(user: string | null, method: string, route: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user;
  const res = await app.request(route, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status as number, json: (await res.json().catch(() => null)) as any };
}

const savePublic = (user: string, link: string) =>
  request(user, "POST", "/builds", {
    builderId: PLAN,
    name: link,
    build: { selections: {}, link },
    visibility: "public",
  });

beforeAll(async () => {
  client = new PGlite();
  for (const f of ["0001_builder.sql", "0002_public_builds.sql", "0004_english_names.sql"]) {
    await client.exec(
      readFileSync(resolve(__dirname, "../../kons/kon-character-builder/migrations", f), "utf8")
    );
  }
  const mod = await import("../../kons/kon-character-builder/index");
  registerPolicy = (await import("../../kons/kon-character-builder/character-builder.policy"))
    .registerBuilderPolicy;
  const auth = {
    requireAuth: (c: any, next: any) => {
      const u = who(c);
      if (!u) return c.json({ error: "Unauthorized" }, 401);
      c.set("user", u);
      return next();
    },
    optionalAuth: (c: any, next: any) => {
      const u = who(c);
      if (u) c.set("user", u);
      return next();
    },
  };
  app = mod.createKonBuilder(
    createTestKonContext({ db: { instance: drizzle(client) } as any, auth: auth as any })
  );
  app.onError((err: unknown, c: any) => respondError(c, err));
});

beforeEach(async () => {
  registerPolicy();
  await client.exec(
    "DELETE FROM builder_build_votes; DELETE FROM builder_builds; DELETE FROM builder_definitions;"
  );
  for (const [user, link] of [
    ["alicia", "#a1"],
    ["alicia", "#a2"],
    ["bruno", "#b1"],
  ] as const) {
    expect((await savePublic(user, link)).status).toBe(201);
  }
  // A private build never shows up, on any page.
  await request("bruno", "POST", "/builds", {
    builderId: PLAN,
    name: "private",
    build: { selections: {}, link: "#b2" },
  });
  // Same votes and publication date: only the id orders them.
  await client.exec("UPDATE builder_builds SET published_at = '2030-01-01T00:00:00Z'");
});

afterAll(async () => {
  await client?.close();
});

const ids = (docs: Array<{ id: string }>) => docs.map((d) => d.id);

describe("list-builds pages", () => {
  test("without parameters: every public build, as before, and `hasMore: false`", async () => {
    const { status, json } = await request(null, "GET", GALLERY);
    expect(status).toBe(200);
    expect(json.docs).toHaveLength(3);
    expect(json.docs.every((d: { visibility: string }) => d.visibility === "public")).toBe(true);
    expect(json.hasMore).toBe(false);
  });

  test("`limit=1` has more; `limit=1&offset=1` is the second build; walking visits each once", async () => {
    const all = ids((await request(null, "GET", GALLERY)).json.docs);
    const first = await request(null, "GET", `${GALLERY}&limit=1`);
    expect(ids(first.json.docs)).toEqual([all[0]]);
    expect(first.json.hasMore).toBe(true);
    const second = await request(null, "GET", `${GALLERY}&limit=1&offset=1`);
    expect(ids(second.json.docs)).toEqual([all[1]]);
    expect(second.json.hasMore).toBe(true);
    const last = await request(null, "GET", `${GALLERY}&limit=1&offset=2`);
    expect(ids(last.json.docs)).toEqual([all[2]]);
    expect(last.json.hasMore).toBe(false);
  });

  test("votes still come first, and `voted` still marks the viewer's", async () => {
    const all = ids((await request(null, "GET", GALLERY)).json.docs);
    const target = all[2];
    expect((await request("alicia", "POST", `/builds/${target}/vote`)).status).toBeLessThan(300);
    const first = await request("alicia", "GET", `${GALLERY}&limit=1`);
    expect(ids(first.json.docs)).toEqual([target]);
    expect(first.json.docs[0].voted).toBe(true);
    expect(first.json.hasMore).toBe(true);
  });

  test("a negative `offset` is refused; a non-numeric `limit` is still the default", async () => {
    expect((await request(null, "GET", `${GALLERY}&offset=-1`)).status).toBe(422);
    const lenient = await request(null, "GET", `${GALLERY}&limit=abc`);
    expect(lenient.status).toBe(200);
    expect(lenient.json.docs).toHaveLength(3);
  });
});
