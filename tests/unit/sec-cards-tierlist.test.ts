/**
 * Security of kon-tierlist — team templates vs personal lists
 * ============================================================================
 *
 * A template is a game's OFFICIAL tier list (the team's); a personal list
 * belongs to whoever forked it. What is tested here, against real SQL:
 *
 *   · Publishing a template = the policy's `publish` action (not a loose role
 *     `if` in the route): editing yes, an agent with its scope yes, a normal
 *     account no, and `content:edit` neither.
 *   · `diff/:otherId` and `decode/:code` accept any id: they cannot
 *     serve someone else's PERSONAL list.
 *   · `/sync` with `catalog` in the body went through unvalidated (including a
 *     `javascript:` image) into the public template.
 *   · `PUT /templates` does not turn a personal row into a template.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { respondError } from "@kitsuden/engine";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonTierlist } from "../../kons/kon-tierlist/index";
import { encodeTierList } from "../../kons/kon-tierlist/tierlist.engine";
import { registerTierlistPolicy } from "../../kons/kon-tierlist/tierlist.policy";

const ROOT = resolve(__dirname, "../..");

const ANA = { id: "u-ana", role: "user" };
const EVA = { id: "u-eva", role: "user" };
const EDITOR = { id: "u-ed", role: "editor" };
const TIER_AGENT = { id: "ag-1", role: "agent", scopes: ["tierlist:publish"] };
const CONTENT_AGENT = { id: "ag-2", role: "agent", scopes: ["content:edit"] };

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

const TEMPLATE = {
  slug: "seg-meta",
  title: "Meta de prueba",
  items: [
    { id: "a", label: "Alfa" },
    { id: "b", label: "Beta" },
  ],
};

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client);
  const dir = join(ROOT, "kons/kon-tierlist/migrations");
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  const ctx = createTestKonContext({
    db: { instance: db } as any,
    auth: {
      requireAuth: (c: any, next: any) => {
        const u = userFrom(c);
        if (!u) return c.json({ error: "Unauthorized" }, 401);
        c.set("user", u);
        return next();
      },
    } as any,
  });
  const kon = createKonTierlist(ctx);
  // The host's global middleware puts `user` on ALL requests (also
  // on public GETs); it is replicated here.
  app = new Hono();
  app.use("*", async (c, next) => {
    const u = userFrom(c);
    if (u) c.set("user" as never, u as never);
    await next();
  });
  app.route("/", kon);
  app.onError((err, c) => respondError(c, err));
  registerTierlistPolicy();

  const r = await call("PUT", "/templates", EDITOR, TEMPLATE);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => registerTierlistPolicy());

describe("publish the team template", () => {
  test("a normal account cannot", async () => {
    expect((await call("PUT", "/templates", EVA, { ...TEMPLATE, title: "Mía" })).status).toBe(403);
  });

  test("an agent with `tierlist:publish` can (before, the role was by hand and left it out)", async () => {
    const r = await call("PUT", "/templates", TIER_AGENT, {
      ...TEMPLATE,
      title: "Meta (agente)",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });

  test("`content:edit` does not publish tier lists", async () => {
    expect((await call("PUT", "/templates", CONTENT_AGENT, TEMPLATE)).status).toBe(403);
  });

  test("neither placing nor adding in the template with a normal account", async () => {
    const place = await call("POST", "/templates/seg-meta/place", EVA, {
      itemId: "a",
      tierId: "S",
    });
    expect(place.status).toBe(403);
    const add = await call("POST", "/templates/seg-meta/items", EVA, {
      items: [{ id: "z", label: "Zeta" }],
    });
    expect(add.status).toBe(403);
  });

  test("a PERSONAL row with a slug is not rewritten as a template", async () => {
    await client.exec(
      `INSERT INTO tier_lists (id, kind, slug, title, tiers, items, owner_id)
       VALUES ('p-slug', 'personal', 'seg-robada', 'De Ana', '[]', '[]', 'u-ana')`
    );
    const r = await call("PUT", "/templates", EDITOR, { slug: "seg-robada", title: "Pisada" });
    expect(r.status).toBe(409);
  });
});

/**
 * Phase D (e2e, 2026-10-25): an agent with only `mcp:connect` forked
 * templates (201): `create` was "any session". An agent does what
 * its scopes say (`tierlist:create`, `tierlist:*`, `admin`).
 */
describe("agents and personal lists", () => {
  test("without a tierlist scope it does not fork; with tierlist:create it does", async () => {
    const nullish = { id: "ag-nulo", role: "agent", scopes: ["mcp:connect"] };
    expect((await call("POST", "/templates/seg-meta/fork", nullish, {})).status).toBe(403);
    const withScope = { id: "ag-tl", role: "agent", scopes: ["tierlist:create"] };
    expect((await call("POST", "/templates/seg-meta/fork", withScope, {})).status).toBe(201);
  });
});

describe("someone else's personal list is not read through the back door", () => {
  let personal: string;
  let deal: Record<string, string>;

  beforeAll(async () => {
    const r = await call("POST", "/templates/seg-meta/fork", ANA, {
      title: "Lo que piensa Ana",
      placement: { a: "S", b: "D" },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    personal = r.json.data.id;
    deal = r.json.data.placement;
  });

  test("`diff/:otherId` with the id of Ana's list: 404 without a session and for another account", async () => {
    expect((await call("GET", `/templates/seg-meta/diff/${personal}`, null)).status).toBe(404);
    expect((await call("GET", `/templates/seg-meta/diff/${personal}`, EVA)).status).toBe(404);
  });

  test("…and its owner can compare it", async () => {
    expect((await call("GET", `/templates/seg-meta/diff/${personal}`, ANA)).status).toBe(200);
  });

  test("a code that points to Ana's list does not open it", async () => {
    const code = encodeTierList(personal, {
      tiers: [],
      items: [],
      placement: deal,
    });
    expect((await call("GET", `/decode/${code}`, null)).status).toBe(404);
    expect((await call("GET", `/decode/${code}`, EVA)).status).toBe(404);
  });

  test("template codes still open without a session", async () => {
    const tpl = await call("GET", "/templates/seg-meta", null);
    const code = encodeTierList(tpl.json.data.id, {
      tiers: [],
      items: [],
      placement: { a: "S" },
    });
    expect((await call("GET", `/decode/${code}`, null)).status).toBe(200);
  });

  test("another account does not place in Ana's list", async () => {
    const r = await call("POST", `/mine/${personal}/place`, EVA, { itemId: "a", tierId: "D" });
    expect(r.status).toBe(404);
  });
});

describe("/sync with catalog in the body", () => {
  test("a `javascript:` image does not get into the public template", async () => {
    const r = await call("POST", "/templates/seg-meta/sync", EDITOR, {
      confirm: true,
      catalog: [{ id: "x", label: "X", imageUrl: "javascript:alert(document.cookie)" }],
    });
    expect(r.status).toBe(422);
    const tpl = await call("GET", "/templates/seg-meta", null);
    expect(JSON.stringify(tpl.json)).not.toContain("javascript:");
  });

  test("nor a catalog of a hundred thousand elements", async () => {
    const catalog = Array.from({ length: 100_000 }, (_, i) => ({ id: `i${i}`, label: `I${i}` }));
    const r = await call("POST", "/templates/seg-meta/sync", EDITOR, { confirm: true, catalog });
    expect(r.status).toBe(422);
  });

  test("a good catalog syncs as always", async () => {
    const r = await call("POST", "/templates/seg-meta/sync", EDITOR, {
      confirm: true,
      catalog: [
        { id: "a", label: "Alfa", imageUrl: "https://example.com/a.png" },
        { id: "c", label: "Gamma" },
      ],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.inCatalog).toBe(2);
  });
});
