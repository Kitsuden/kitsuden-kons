/**
 * kon-cardsim: a person's card image sources
 * ============================================================================
 *
 * The kon stores WHERE someone's images come from (the order of their sources and the links they
 * typed), never an image. Three things must hold:
 *
 *   1. What is stored is only settings: https links to public hosts, names for local sources, and
 *      nothing bigger than the caps. A path, a credential or a LAN address is refused.
 *   2. Nobody reads anybody else's: through the routes, and in the database itself with a
 *      NON-superuser role (with a superuser the policy filters nothing and the test would be
 *      decorative).
 *   3. The rules the board and the server share (`cardsim.images.ts`) say the same thing.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { respondError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonCardsim } from "../../kons/kon-cardsim/index";
import { registerCardsimPolicy } from "../../kons/kon-cardsim/cardsim.policy";
import {
  CommunityPackSchema,
  expandTemplate,
  ImagePrefsSchema,
  isImageKey,
  looksLikeImageUrl,
  stripCardImages,
  urlProblem,
} from "../../kons/kon-cardsim/cardsim.images";

const ROOT = resolve(__dirname, "../..");
const MIGRATIONS = join(ROOT, "kons/kon-cardsim/migrations");

const ANA = { id: "u-ana", role: "user" };
const BEA = { id: "u-bea", role: "user" };
const AGENT_NO_SCOPE = { id: "ag-0", role: "agent", scopes: ["mcp:connect"] };

const migrationFiles = () =>
  readdirSync(MIGRATIONS)
    .filter((x) => x.endsWith(".sql"))
    .sort();

// ── Through the routes ──────────────────────────────────────────────────────

let client: PGlite;
let app: ReturnType<typeof createKonCardsim>;

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
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* 204 */
  }
  return { status: res.status, json };
}

const GOOD = {
  sources: [
    { kind: "folder", label: "My scans" },
    { kind: "template", label: "Mirror", url: "https://images.example.org/op/{id}.webp" },
    {
      kind: "cardUrls",
      label: "Fixes",
      urls: { "OP01-001": "https://images.example.org/fix/OP01-001.png" },
    },
    { kind: "pack", label: "Friend's pack", url: "https://friend.example.net/pack.json" },
    { kind: "zip", label: "set-1.zip", enabled: false },
  ],
};

beforeAll(async () => {
  client = new PGlite();
  for (const f of migrationFiles()) await client.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: fakeAuth as any,
    realtime: { broadcast: () => {}, sendToUser: () => {} } as any,
  });
  app = createKonCardsim(ctx);
  app.onError((err, c) => respondError(c, err));
  registerCardsimPolicy();
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerCardsimPolicy();
});

describe("image prefs through the routes", () => {
  test("without a session there is nothing to read or write", async () => {
    expect((await call("GET", "/image-prefs/one-piece", null)).status).toBe(401);
    expect((await call("PUT", "/image-prefs/one-piece", null, GOOD)).status).toBe(401);
  });

  test("no prefs yet is an empty list, not a 404", async () => {
    const r = await call("GET", "/image-prefs/one-piece", ANA);
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ gameKey: "one-piece", sources: [], updatedAt: null });
  });

  test("saved in order, read back the same, and enabled defaults to true", async () => {
    const put = await call("PUT", "/image-prefs/one-piece", ANA, GOOD);
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    const got = await call("GET", "/image-prefs/one-piece", ANA);
    expect(got.json.data.sources.map((s: any) => s.kind)).toEqual([
      "folder",
      "template",
      "cardUrls",
      "pack",
      "zip",
    ]);
    expect(got.json.data.sources[0].enabled).toBe(true);
    expect(got.json.data.sources[4].enabled).toBe(false);
  });

  test("a second PUT replaces, it does not append (idempotent)", async () => {
    const one = { sources: [{ kind: "folder", label: "Only this" }] };
    await call("PUT", "/image-prefs/one-piece", ANA, one);
    await call("PUT", "/image-prefs/one-piece", ANA, one);
    const got = await call("GET", "/image-prefs/one-piece", ANA);
    expect(got.json.data.sources).toEqual([{ kind: "folder", label: "Only this", enabled: true }]);
  });

  test("each person and each game has their own", async () => {
    await call("PUT", "/image-prefs/one-piece", ANA, GOOD);
    expect((await call("GET", "/image-prefs/one-piece", BEA)).json.data.sources).toEqual([]);
    expect((await call("GET", "/image-prefs/lorcana", ANA)).json.data.sources).toEqual([]);
  });

  test("an agent with only mcp:connect cannot act as a user here", async () => {
    expect((await call("PUT", "/image-prefs/one-piece", AGENT_NO_SCOPE, GOOD)).status).toBe(403);
  });

  test("delete forgets them, and only the caller's", async () => {
    await call("PUT", "/image-prefs/one-piece", BEA, GOOD);
    expect((await call("DELETE", "/image-prefs/one-piece", ANA)).status).toBe(204);
    expect((await call("GET", "/image-prefs/one-piece", ANA)).json.data.sources).toEqual([]);
    expect((await call("GET", "/image-prefs/one-piece", BEA)).json.data.sources).toHaveLength(5);
  });

  const refused: [string, unknown][] = [
    ["an http link", { sources: [{ kind: "pack", label: "p", url: "http://example.org/p.json" }] }],
    ["localhost", { sources: [{ kind: "pack", label: "p", url: "https://localhost/p.json" }] }],
    ["a LAN address", { sources: [{ kind: "pack", label: "p", url: "https://192.168.1.10/p" }] }],
    ["a .local host", { sources: [{ kind: "pack", label: "p", url: "https://nas.local/p" }] }],
    ["credentials", { sources: [{ kind: "pack", label: "p", url: "https://a:b@example.org/p" }] }],
    ["a template with no card", { sources: [{ kind: "template", label: "t", url: "https://example.org/x.png" }] }],
    ["a folder with a path", { sources: [{ kind: "folder", label: "f", path: "C:\\Users\\ana\\scans" }] }],
    ["an unknown kind", { sources: [{ kind: "ftp", label: "f" }] }],
    ["21 sources", { sources: Array.from({ length: 21 }, (_, i) => ({ kind: "folder", label: `f${i}` })) }],
    ["an image inline", { sources: [], image: "data:image/png;base64,AAAA" }],
  ];
  test.each(refused)("refuses %s", async (_why, body) => {
    const r = await call("PUT", "/image-prefs/one-piece", ANA, body);
    expect(r.status, JSON.stringify(r.json)).toBe(422);
  });

  test("a game key that is not a slug is refused", async () => {
    const r = await call("GET", `/image-prefs/${encodeURIComponent("../decks")}`, ANA);
    expect([404, 422]).toContain(r.status);
    expect((await call("GET", "/image-prefs/Bad_Key", ANA)).status).toBe(422);
  });
});

// ── In the database, with a role that RLS applies to ─────────────────────────

describe("cardsim_image_prefs RLS (non-superuser role)", () => {
  let pg: PGlite;

  async function asRole<T>(ctx: { id: string; role: string } | null, fn: () => Promise<T>) {
    await pg.exec("BEGIN; SET LOCAL ROLE app_prueba;");
    try {
      if (ctx) {
        await pg.query("SELECT set_config('app.current_user_id', $1, true)", [ctx.id]);
        await pg.query("SELECT set_config('app.current_user_role', $1, true)", [ctx.role]);
      }
      return await fn();
    } finally {
      await pg.exec("ROLLBACK;");
    }
  }
  const count = (ctx: { id: string; role: string } | null) =>
    asRole(ctx, async () => {
      const r: any = await pg.query("SELECT count(*)::int AS n FROM cardsim_image_prefs");
      return r.rows[0].n as number;
    });
  const insertFor = (ctx: { id: string; role: string }, owner: string) =>
    asRole(ctx, async () => {
      try {
        await pg.query(
          "INSERT INTO cardsim_image_prefs (id, owner_id, game_key) VALUES ($1, $2, 'x-game')",
          [`p-${owner}-${Math.random()}`, owner]
        );
        return true;
      } catch {
        return false;
      }
    });

  beforeAll(async () => {
    pg = new PGlite();
    // The whole chain, and 0013 twice: it has to be idempotent.
    for (const f of migrationFiles()) await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    await pg.exec(readFileSync(join(MIGRATIONS, "0013_byod_images.sql"), "utf8"));
    await pg.exec(`
      INSERT INTO cardsim_image_prefs (id, owner_id, game_key) VALUES
        ('p1', 'u-ana', 'one-piece'), ('p2', 'u-bea', 'one-piece');
      CREATE ROLE app_prueba NOLOGIN;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_prueba;
    `);
  });

  afterAll(async () => {
    await pg?.close();
  });

  test("the system (no context) sees both", async () => {
    expect(await count(null)).toBe(2);
  });

  test("a person sees only their own; an anonymous with context sees none", async () => {
    expect(await count(ANA)).toBe(1);
    expect(await count({ id: "", role: "anonymous" })).toBe(0);
    expect(await count({ id: "u-eva", role: "user" })).toBe(0);
  });

  test("an admin sees both", async () => {
    expect(await count({ id: "u-adm", role: "admin" })).toBe(2);
  });

  test("nobody writes a row for someone else", async () => {
    expect(await insertFor(ANA, "u-ana")).toBe(true);
    expect(await insertFor(ANA, "u-bea")).toBe(false);
  });

  test("the database refuses more than 20 sources and a key that is not a slug", async () => {
    const tooMany = JSON.stringify(Array.from({ length: 21 }, () => ({ kind: "folder" })));
    await expect(
      pg.query(
        "INSERT INTO cardsim_image_prefs (id, owner_id, game_key, sources) VALUES ('p9', 'u', 'g', $1::jsonb)",
        [tooMany]
      )
    ).rejects.toThrow();
    await expect(
      pg.query("INSERT INTO cardsim_image_prefs (id, owner_id, game_key) VALUES ('p8', 'u', 'Bad Key')")
    ).rejects.toThrow();
  });
});

// ── The shared rules ─────────────────────────────────────────────────────────

describe("cardsim.images rules", () => {
  test("image keys are picture words, not substrings", () => {
    for (const k of ["imageUrl", "image_url", "imageKey", "art", "artCrop", "thumbnail", "icon", "img"]) {
      expect(isImageKey(k), k).toBe(true);
    }
    for (const k of ["artist", "description", "partner", "cost", "imagination", "card_id"]) {
      expect(isImageKey(k), k).toBe(false);
    }
  });

  test("image links are told from text and other links", () => {
    expect(looksLikeImageUrl("https://cdn.example.org/a.webp")).toBe(true);
    expect(looksLikeImageUrl("//cdn.example.org/a.JPG?x=1")).toBe(true);
    expect(looksLikeImageUrl("/media/cartas/abc")).toBe(true);
    expect(looksLikeImageUrl("data:image/png;base64,AAA")).toBe(true);
    expect(looksLikeImageUrl("Draw 2 cards.")).toBe(false);
    expect(looksLikeImageUrl("https://shop.example.org/product/42")).toBe(false);
    expect(looksLikeImageUrl("1/2")).toBe(false);
  });

  test("stripping removes pictures at any depth and keeps the rest; hosted is untouched", () => {
    const card = {
      cardId: "a",
      name: "A",
      imageUrl: "https://x.example.org/a.png",
      data: { cost: 2, art: { full: "x" }, tags: ["red", "https://x.example.org/b.jpg"], nested: { thumb: "y", note: "ok" } },
    };
    expect(stripCardImages(card, "byod")).toEqual({
      cardId: "a",
      name: "A",
      data: { cost: 2, tags: ["red"], nested: { note: "ok" } },
    });
    expect(stripCardImages(card, "hosted")).toBe(card);
    // Anything that is not exactly "byod" counts as hosted: it never hides less than intended.
    expect(stripCardImages(card, undefined)).toBe(card);
  });

  test("templates encode the card, so a name cannot leave the path", () => {
    expect(expandTemplate("https://e.org/c/{id}.png", { id: "OP01-001" })).toBe(
      "https://e.org/c/OP01-001.png"
    );
    expect(expandTemplate("https://e.org/c/{name}.png", { id: "x", name: "../../admin?a=1" })).toBe(
      "https://e.org/c/..%2F..%2Fadmin%3Fa%3D1.png"
    );
  });

  test("urlProblem refuses IPv6 loopback and unique-local hosts", () => {
    expect(urlProblem("https://[::1]/a")).not.toBeNull();
    expect(urlProblem("https://[fd00::1]/a")).not.toBeNull();
    expect(urlProblem("https://example.org/a")).toBeNull();
  });

  test("the prefs schema and the pack schema accept the documented shapes", () => {
    expect(ImagePrefsSchema.safeParse(GOOD).success).toBe(true);
    const pack = CommunityPackSchema.safeParse({
      format: "kitsuden-cardsim-pack",
      version: 1,
      game: "one-piece-card-game",
      name: "Scans",
      template: "https://example.org/op/{id}.webp",
      cards: { "OP01-001": "https://example.org/op/alt.webp" },
    });
    expect(pack.success, JSON.stringify(pack.error?.issues)).toBe(true);
    expect(
      CommunityPackSchema.safeParse({
        format: "kitsuden-cardsim-pack",
        version: 1,
        game: "g",
        name: "Empty",
      }).success
    ).toBe(false);
    expect(
      CommunityPackSchema.safeParse({
        format: "kitsuden-cardsim-pack",
        version: 1,
        game: "g",
        name: "LAN",
        cards: { a: "https://10.0.0.2/a.png" },
      }).success
    ).toBe(false);
  });
});
