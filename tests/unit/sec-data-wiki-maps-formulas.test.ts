/**
 * Security (data): kon-wiki, kon-maps and kon-formulas
 * ============================================================================
 *
 *   · Wiki: "any session" could edit (sign-up is public) and so could an agent with
 *     ANY scope. Production wikis are written by the team and appear
 *     on the web immediately. The (public) diff was quadratic with no cap.
 *   · Maps: grouping (`?cluster=`, public) copied the entire cell for
 *     every marker — quadratic —, and `PUT /maps` did not validate the definition.
 *   · Formulas: `evaluate` (any session) accepted any number of inputs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { can, respondError } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonFormulas, MAX_EVALUATION_INPUTS } from "../../kons/kon-formulas/index";
import { registerFormulasPolicy } from "../../kons/kon-formulas/formulas.policy";
import { createKonMaps } from "../../kons/kon-maps/index";
import { clusterMarkers, type Marker } from "../../kons/kon-maps/maps.engine";
import { registerMapsPolicy } from "../../kons/kon-maps/maps.policy";
import { createKonWiki } from "../../kons/kon-wiki/index";
import { diffLines, MAX_DIFF_CELLS } from "../../kons/kon-wiki/wiki.engine";
import { registerWikiPolicy } from "../../kons/kon-wiki/wiki.policy";

const EDITOR = { id: "u-editor", role: "editor" };
const ADMIN = { id: "u-admin", role: "admin" };
const ANA = { id: "u-ana", role: "user" };
const READER_AGENT = { id: "ag-1", role: "agent", scopes: ["data:read"] };

let client: PGlite;
let wiki: Hono;
let maps: Hono;
let formulas: Hono;

function mount(router: Hono): Hono {
  const app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.use("*", async (c, next) => {
    const rawValue = c.req.header("x-test-user");
    c.set("user" as never, (rawValue ? JSON.parse(rawValue) : null) as never);
    await next();
  });
  app.route("/", router);
  return app;
}

function request(app: Hono, method: string, route: string, user: object | null, body?: unknown) {
  return app.request(route, {
    method: method,
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  registerWikiPolicy();
  registerMapsPolicy();
  registerFormulasPolicy();
});

afterAll(async () => {
  await client?.close();
});

beforeAll(async () => {
  client = new PGlite();
  for (const kon of ["kon-wiki", "kon-maps", "kon-formulas"]) {
    const dir = join(__dirname, "../../kons", kon, "migrations");
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await client.exec(readFileSync(join(dir, f), "utf8"));
    }
  }
  const db = drizzle(client);
  const requireAuth = async (c: any, next: any) =>
    c.get("user") ? next() : c.json({ error: "Unauthorized" }, 401);
  const ctx = createTestKonContext({ db: { instance: db } as any, auth: { requireAuth } as any });
  wiki = mount(createKonWiki(ctx));
  maps = mount(createKonMaps(ctx));
  formulas = mount(createKonFormulas(ctx));

  await client.query(`INSERT INTO wikis (id, slug, title) VALUES ('w1', 'elden', 'Elden')`);
  await client.query(
    `INSERT INTO wiki_pages (id, wiki_id, slug, title, current_revision) VALUES ('p1', 'w1', 'weapons', 'Armas', 1)`
  );
  await client.query(
    `INSERT INTO wiki_revisions (id, page_id, number, content, author_id) VALUES ('r1', 'p1', 1, 'Texto del equipo', 'u-editor')`
  );
});

describe("wiki: the team edits", () => {
  it("the policy does not let an arbitrary account or an agent without scope create or edit", async () => {
    for (const u of [ANA, READER_AGENT, null]) {
      expect(await can(u as never, "create", {}, "wiki"), JSON.stringify(u)).toBe(false);
      expect(await can(u as never, "update", { id: "p1", protection: "open" }, "wiki")).toBe(false);
    }
    expect(await can(EDITOR, "update", { id: "p1", protection: "open" }, "wiki")).toBe(true);
    expect(await can(EDITOR, "update", { id: "p1", protection: "locked" }, "wiki")).toBe(false);
    expect(await can(ADMIN, "update", { id: "p1", protection: "locked" }, "wiki")).toBe(true);
    // An agent passes with just the action's scope.
    expect(
      await can(
        { id: "ag", role: "agent", scopes: ["wiki:update"] },
        "update",
        { id: "p1" },
        "wiki"
      )
    ).toBe(true);
  });

  it("a normal account neither rewrites nor reverts a page", async () => {
    const r = await request(wiki, "PUT", "/wikis/elden/pages/weapons", ANA, { content: "VANDALISMO" });
    expect(r.status).toBe(403);
    const fresh = await request(wiki, "PUT", "/wikis/elden/pages/spam", ANA, { content: "spam" });
    expect(fresh.status).toBe(403);
    const read = await request(wiki, "GET", "/wikis/elden/pages/weapons", null);
    expect(((await read.json()) as any).content).toBe("Texto del equipo");
  });

  it("the team edits, and the server sets the authorship", async () => {
    // Sending an author or revision number does not get through: the body is validated strictly.
    const forged = await request(wiki, "PUT", "/wikis/elden/pages/weapons", EDITOR, {
      content: "Texto falso",
      authorId: "otro",
      number: 1,
    });
    expect(forged.status).toBe(422);
    const r = await request(wiki, "PUT", "/wikis/elden/pages/weapons", EDITOR, { content: "Texto v2" });
    expect(r.status).toBe(200);
    const hist = (await (
      await request(wiki, "GET", "/wikis/elden/pages/weapons/history", null)
    ).json()) as any;
    expect(hist.data.map((x: any) => [x.number, x.size])).toEqual([
      [2, 8],
      [1, 16],
    ]);
    // The history is public: it does not show the account's internal id
    // (audit 2026-10-25). Authorship is set by the server, and checked in the database.
    expect(hist.data.every((x: any) => !("authorId" in x))).toBe(true);
    const authors = await client.query<{ number: number; author_id: string }>(
      "SELECT number, author_id FROM wiki_revisions WHERE page_id = 'p1' ORDER BY number DESC"
    );
    expect(authors.rows.map((x) => [x.number, x.author_id])).toEqual([
      [2, "u-editor"],
      [1, "u-editor"],
    ]);
  });

  it("an odd revision number is 404, not 500", async () => {
    expect((await request(wiki, "GET", "/wikis/elden/pages/weapons/diff/abc/1", null)).status).toBe(
      404
    );
    expect((await request(wiki, "POST", "/wikis/elden/pages/weapons/revert/-1", EDITOR)).status).toBe(
      404
    );
  });

  it("the diff of huge revisions does not build a quadratic table", () => {
    const a = Array.from({ length: 200_000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 200_000 }, (_, i) => `b${i}`).join("\n");
    const t0 = Date.now();
    const ops = diffLines(a, b);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(ops.filter((o) => o.op === "del").length).toBe(200_000);
    expect(ops.filter((o) => o.op === "add").length).toBe(200_000);
    expect(MAX_DIFF_CELLS).toBeLessThanOrEqual(4_000_000);
  });

  it("the normal diff is still fine-grained", () => {
    const ops = diffLines("uno\ndos\ntres\ncuatro", "uno\nDOS\ntres\ncuatro");
    expect(ops).toEqual([
      { op: "keep", line: "uno" },
      { op: "del", line: "dos" },
      { op: "add", line: "DOS" },
      { op: "keep", line: "tres" },
      { op: "keep", line: "cuatro" },
    ]);
  });
});

describe("maps", () => {
  it("grouping many markers into one cell is linear", () => {
    const markers: Marker[] = Array.from({ length: 60_000 }, (_, i) => ({
      id: String(i),
      layerId: "l",
      categoryId: "c",
      x: 0.5,
      y: 0.5,
      title: "m",
      body: null,
    }));
    const t0 = Date.now();
    const groups = clusterMarkers(markers, 1);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(groups).toHaveLength(1);
    expect(groups[0].markers).toHaveLength(60_000);
  });

  it("a normal account does not create maps; a bad definition is 400, not 500", async () => {
    const def = {
      name: "M",
      imageUrl: "/media/m.webp",
      aspectRatio: 1.5,
      layers: [{ id: "l", name: "L" }],
    };
    expect((await request(maps, "PUT", "/maps", ANA, { slug: "m", definition: def })).status).toBe(
      403
    );
    expect(
      (
        await request(maps, "PUT", "/maps", EDITOR, {
          slug: "m",
          definition: { ...def, layers: "x" },
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request(maps, "PUT", "/maps", EDITOR, {
          slug: "m",
          definition: { ...def, imageUrl: "javascript:alert(1)" },
        })
      ).status
    ).toBe(400);
    expect(
      (await request(maps, "PUT", "/maps", EDITOR, { slug: "../../x", definition: def })).status
    ).toBe(400);
    expect((await request(maps, "PUT", "/maps", EDITOR, { slug: "m", definition: def })).status).toBe(
      201
    );
  });
});

describe("formulas", () => {
  it("evaluate rejects an avalanche of inputs", async () => {
    const ok = await request(formulas, "PUT", "/systems", EDITOR, {
      slug: "damage",
      name: "Daño",
      stats: [{ name: "total", formula: "base * 2" }],
    });
    expect(ok.status).toBe(201);
    const inputs = Object.fromEntries(
      Array.from({ length: MAX_EVALUATION_INPUTS + 1 }, (_, i) => [`v${i}`, 1])
    );
    // `evaluate` asks for a session (the write middleware covers every POST), but
    // a session is free: the cap has to be there all the same.
    const r = await request(formulas, "POST", "/systems/damage/evaluate", ANA, {
      inputs: { ...inputs, base: 2 },
    });
    expect(r.status).toBe(422);
    const good = await request(formulas, "POST", "/systems/damage/evaluate", ANA, {
      inputs: { base: 2 },
    });
    expect(((await good.json()) as any).data.total).toBe(4);
  });

  it("a normal account does not write systems", async () => {
    const r = await request(formulas, "PUT", "/systems", ANA, {
      slug: "damage",
      name: "Roto",
      stats: [{ name: "total", formula: "0" }],
    });
    expect(r.status).toBe(403);
  });
});
