/**
 * kon-character-builder — builds, votes and "My builds" with DIFFERENT users
 * ============================================================================
 *
 * Against PGlite. Alicia and Bruno are normal accounts (sign-up is public);
 * each test tries to have one touch the other's things.
 *
 * Security review of 2026-10-15.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { respondError } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

const USERS: Record<string, { id: string; role: string; name: string; scopes?: string[] }> = {
  alicia: { id: "u-alicia", role: "user", name: "Alicia" },
  bruno: { id: "u-bruno", role: "user", name: "Bruno" },
  admin: { id: "u-admin", role: "admin", name: "Admin" },
};
// Agents (Bearer kitsuden_agent_*): they arrive with role "agent" and their scopes.
const AGENTS: Record<string, { id: string; role: string; name: string; scopes: string[] }> = {
  "ag-admin": { id: "ag-1", role: "agent", name: "A", scopes: ["admin"] },
  "ag-builder": { id: "ag-2", role: "agent", name: "B", scopes: ["builder:*"] },
  "ag-nulo": { id: "ag-3", role: "agent", name: "N", scopes: ["mcp:connect"] },
};
Object.assign(USERS, AGENTS);

let client: PGlite;
let app: any;
let mod: any;
let registerPolicy: () => void;

const who = (c: any) => USERS[c.req.header("x-test-user") ?? ""];
const PLAN = "link:grim-dawn:/grim-dawn/calculadora";

async function request(user: string | null, method: string, route: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user;
  const res = await app.request(route, {
    method: method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status as number, json: (await res.json().catch(() => null)) as any };
}

const save = (
  user: string,
  link: string,
  extra: Record<string, unknown> = {},
  builderId = PLAN
) =>
  request(user, "POST", "/builds", {
    builderId,
    name: "My build",
    build: { selections: {}, link },
    ...extra,
  });

beforeAll(async () => {
  client = new PGlite();
  for (const f of ["0001_builder.sql", "0002_public_builds.sql", "0004_english_names.sql"]) {
    await client.exec(
      readFileSync(
        resolve(__dirname, "../../kons/kon-character-builder/migrations", f),
        "utf8"
      )
    );
  }

  mod = await import("../../kons/kon-character-builder/index");
  registerPolicy = (
    await import("../../kons/kon-character-builder/character-builder.policy")
  ).registerBuilderPolicy;

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
});

afterAll(async () => {
  await client?.close();
});

describe("IDOR on other people's builds", () => {
  test("Bruno does not see Alicia's PRIVATE build (404, as if it did not exist)", async () => {
    const { json } = await save("alicia", "#privada");
    expect(json.data.visibility).toBe("private");
    expect((await request("bruno", "GET", `/builds/${json.data.id}`)).status).toBe(404);
    expect((await request(null, "GET", `/builds/${json.data.id}`)).status).toBe(404);
    expect((await request("alicia", "GET", `/builds/${json.data.id}`)).status).toBe(200);
  });

  test("Bruno does not edit, publish or delete Alicia's build", async () => {
    const { json } = await save("alicia", "#suya");
    const id = json.data.id;
    expect((await request("bruno", "PATCH", `/builds/${id}`, { name: "robada" })).status).toBe(403);
    expect((await request("bruno", "PATCH", `/builds/${id}`, { visibility: "public" })).status).toBe(
      403
    );
    expect((await request("bruno", "DELETE", `/builds/${id}`)).status).toBe(403);
    const row: any = await client.query(
      "SELECT name, visibility FROM builder_builds WHERE id = $1",
      [id]
    );
    expect(row.rows[0]).toEqual({ name: "My build", visibility: "private" });
  });

  test("Bruno's \"My builds\" contains none of Alicia's", async () => {
    await save("alicia", "#a1");
    await save("alicia", "#a2", { visibility: "public" });
    await save("bruno", "#b1");
    const { json } = await request(
      "bruno",
      "GET",
      `/builds/mine?builder=${encodeURIComponent(PLAN)}`
    );
    expect(json.docs.map((d: any) => d.ownerId)).toEqual(["u-bruno"]);
    expect(
      (await request(null, "GET", `/builds/mine?builder=${encodeURIComponent(PLAN)}`)).status
    ).toBe(401);
  });

  test("the gallery only shows public ones and without their owner's id", async () => {
    await save("alicia", "#priv");
    await save("alicia", "#oculta", { visibility: "unlisted" });
    await save("alicia", "#pub", { visibility: "public" });
    const { json } = await request("bruno", "GET", `/builds?builder=${encodeURIComponent(PLAN)}`);
    expect(json.docs).toHaveLength(1);
    expect(json.docs[0].visibility).toBe("public");
    expect(json.docs[0]).not.toHaveProperty("ownerId");
  });

  test("owner, votes and date are not set on save", async () => {
    const r = await save("bruno", "#xx", { ownerId: "u-alicia", votes: 500 });
    // The schema is strict: extra fields are rejected.
    expect(r.status).toBe(422);
    const n: any = await client.query("SELECT count(*)::int AS n FROM builder_builds");
    expect(n.rows[0].n).toBe(0);
  });

  test("a link with javascript: or quotes is not saved (it goes inside an href)", async () => {
    expect((await save("alicia", "javascript:alert(1)")).status).toBe(422);
    expect((await save("alicia", '#"><script>alert(1)</script>')).status).toBe(422);
  });
});

describe("votes", () => {
  test("one vote per person, also with simultaneous clicks (no 500)", async () => {
    const { json } = await save("alicia", "#votable", { visibility: "public" });
    const id = json.data.id;
    const rs = await Promise.all(
      Array.from({ length: 4 }, () => request("bruno", "POST", `/builds/${id}/vote`))
    );
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const v: any = await client.query(
      "SELECT count(*)::int AS n FROM builder_build_votes WHERE build_id = $1",
      [id]
    );
    expect(v.rows[0].n).toBeLessThanOrEqual(1);
    const b: any = await client.query("SELECT votes FROM builder_builds WHERE id = $1", [id]);
    expect(b.rows[0].votes).toBe(v.rows[0].n);
  });

  test("you cannot vote without a session, nor on someone else's private build", async () => {
    const pub = (await save("alicia", "#pp", { visibility: "public" })).json.data.id;
    const priv = (await save("alicia", "#qq")).json.data.id;
    expect((await request(null, "POST", `/builds/${pub}/vote`)).status).toBe(401);
    expect((await request("bruno", "POST", `/builds/${priv}/vote`)).status).toBe(404);
  });
});

describe("draft definitions", () => {
  test("a build is not saved against an unpublished builder", async () => {
    await client.query(
      "INSERT INTO builder_definitions (id, slug, name, definition, published) VALUES ('def-borrador', 'secreto', 'Secreto', '{}', 'draft')"
    );
    const r = await request("bruno", "POST", "/builds", {
      builderId: "def-borrador",
      build: { selections: {} },
    });
    expect(r.status).toBe(404);
  });
});

describe("abuse: public sign-up", () => {
  test("inventing planner routes does not skip the cap: there is a maximum rate per account", async () => {
    const before = mod.MAX_BUILDS.perWindow;
    mod.MAX_BUILDS.perWindow = 3;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push(
          (await save("bruno", `#bb${i}`, {}, `link:grim-dawn:/inventada-${i}`)).status
        );
      }
      expect(statuses).toEqual([201, 201, 201, 429, 429]);
      // It is Bruno's: Alicia can keep saving.
      expect((await save("alicia", "#aa", {}, "link:grim-dawn:/otra")).status).toBe(201);
    } finally {
      mod.MAX_BUILDS.perWindow = before;
    }
  });

  test("and a total cap per account", async () => {
    const before = mod.MAX_BUILDS.total;
    mod.MAX_BUILDS.total = 2;
    try {
      expect((await save("bruno", "#n1", {}, "link:grim-dawn:/r1")).status).toBe(201);
      expect((await save("bruno", "#n2", {}, "link:grim-dawn:/r2")).status).toBe(201);
      expect((await save("bruno", "#n3", {}, "link:grim-dawn:/r3")).status).toBe(409);
    } finally {
      mod.MAX_BUILDS.total = before;
    }
  });
});

describe("publish a definition (the official builder)", () => {
  const definition = {
    id: "heroe",
    name: "Héroe",
    baseStats: { atk: 1 },
    slots: [{ id: "p", name: "P", capacity: 1, options: [{ id: "a", name: "A", modifiers: [] }] }],
    budgets: [],
    derived: [{ name: "total", formula: "atk * 2" }],
  };
  test("an agent with admin or builder:* publishes; one without scope and a normal account do not", async () => {
    for (const [who, expected] of [
      ["ag-admin", 201],
      ["ag-builder", 200],
      ["admin", 200],
      ["ag-nulo", 403],
      ["alicia", 403],
    ] as const) {
      const r = await request(who, "PUT", "/definitions", { slug: "heroe", definition });
      expect(r.status, who).toBe(expected);
    }
  });
});
