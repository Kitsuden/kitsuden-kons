/**
 * A 4xx written by a kon after a statement failed, INSIDE the host's request transaction
 * ============================================================================
 *
 * The host opens one transaction per request (`rlsTransaction`) and commits it unless the
 * handler threw or answered 5xx. A kon that catches a Postgres error (a duplicate, a reference to
 * a row that does not exist, an out-of-range value) and answers its own 409 or 400 from the
 * `catch` left that transaction ABORTED and then asked the host to commit it. Postgres turns that
 * COMMIT into a silent ROLLBACK; PGlite 0.5.16 answers it with an error, and the kon's 4xx became
 * a 500 (found in `kon-crm-security.test.ts`, which mounts kon-crm this way).
 *
 * The statement that may fail now runs in a SAVEPOINT (`withSavepoint`, rule 2 of the kon SDK),
 * so the request's transaction stays alive and the answer the kon wrote is the one that goes out,
 * with the same status and body as before. These kons had tests of those answers, but on a
 * router mounted bare, without the request transaction, where the problem cannot show.
 *
 * Each bench mounts the kon's real router behind the engine's `rlsTransaction` (`rlsHost`), on
 * PGlite with the kon's own schema.
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { resetAuthz } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import type { Hono, MiddlewareHandler } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { registerBlogPolicy } from "../../kons/kon-blog/src/blog.policy";
import { createBlogRouter } from "../../kons/kon-blog/src/routes";
import { registerEsportsPolicy } from "../../kons/kon-esports/esports.policy";
import { createKonEsports } from "../../kons/kon-esports/index";
import { registerStreamersPolicy } from "../../kons/kon-streamers/streamers.policy";
import { createStreamersRouter } from "../../kons/kon-streamers/streamers.routes";

const ROOT = resolve(__dirname, "../..");
const ADMIN = { id: "u-admin-0000000000000000000000", role: "admin" };

/** The role of the API's session middleware: everyone here is the site's admin. */
const asAdmin: MiddlewareHandler = async (c, next) => {
  c.set("user" as never, ADMIN as never);
  await next();
};
const auth = { requireAuth: asAdmin, optionalAuth: asAdmin, requireRole: () => asAdmin };

/** The kon's migrations, in order. */
function chain(kon: string): string[] {
  const dir = join(ROOT, "kons", kon, "migrations");
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

function sender(app: () => Hono) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await app().request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: the text itself is what the assertion shows.
    }
    return { status: res.status, body: json };
  };
}

// ── kon-streamers ────────────────────────────────────────────────────────────

describe("kon-streamers: a duplicate is its 409, not a 500", () => {
  let client: PGlite;
  let app: Hono;
  const send = sender(() => app);
  const DUPLICATE = {
    error: "A streamer with that slug, or with that platform and channel, already exists",
  };

  beforeAll(async () => {
    client = new PGlite();
    await client.exec("CREATE TABLE media (id uuid PRIMARY KEY DEFAULT gen_random_uuid());");
    for (const sql of chain("kon-streamers")) await client.exec(sql);
    const host = rlsHost(drizzle(client), auth);
    app = host.mount(createStreamersRouter({ db: host.db, auth } as any));
  }, 60_000);

  afterAll(async () => client?.close());
  beforeEach(() => registerStreamersPolicy());

  test("create", async () => {
    const first = await send("POST", "/", {
      displayName: "Alpha",
      platform: "twitch",
      channelId: "alpha",
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const again = await send("POST", "/", {
      displayName: "Alpha again",
      slug: "alpha-again",
      platform: "twitch",
      channelId: "alpha",
    });
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body).toEqual(DUPLICATE);

    const rows = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM streamers");
    expect(rows.rows[0]!.n).toBe(1);
  });

  test("update", async () => {
    const beta = await send("POST", "/", {
      displayName: "Beta",
      platform: "twitch",
      channelId: "beta",
    });
    expect(beta.status, JSON.stringify(beta.body)).toBe(201);

    const clash = await send("PATCH", `/${beta.body.id}`, { channelId: "alpha", bio: "moved" });
    expect(clash.status, JSON.stringify(clash.body)).toBe(409);
    expect(clash.body).toEqual(DUPLICATE);

    // Nothing of the refused update was written, and the next request works.
    const row = await client.query<{ channel_id: string; bio: string | null }>(
      "SELECT channel_id, bio FROM streamers WHERE id = $1",
      [beta.body.id]
    );
    expect(row.rows[0]).toEqual({ channel_id: "beta", bio: null });
    expect((await send("PATCH", `/${beta.body.id}`, { channelId: "beta-2" })).status).toBe(200);
  });
});

// ── kon-esports ──────────────────────────────────────────────────────────────

describe("kon-esports: a registration Postgres refuses is its 400, not a 500", () => {
  let client: PGlite;
  let app: Hono;
  let tournament: string;
  const send = sender(() => app);

  beforeAll(async () => {
    client = new PGlite();
    for (const sql of chain("kon-esports")) await client.exec(sql);
    const host = rlsHost(drizzle(client), auth);
    app = host.mount(createKonEsports(createTestKonContext({ db: host.db as any, auth: auth as any })));

    const created = await client.query<{ id: string }>(
      `INSERT INTO esports_tournaments (title, game_id, status, format, bracket_format, max_participants)
       VALUES ('Cup', $1, 'Open', '1v1', 'single_elimination', 8) RETURNING id`,
      [randomUUID()]
    );
    tournament = created.rows[0]!.id;
  }, 60_000);

  afterAll(async () => client?.close());
  beforeEach(() => {
    resetAuthz();
    registerEsportsPolicy();
  });

  test("a player that does not exist", async () => {
    const res = await send("POST", `/tournaments/${tournament}/register`, { playerId: randomUUID() });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toBe("Failed to register. You may already be registered.");

    const rows = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM esports_tournament_participants"
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  test("and a player that does exist still registers afterwards", async () => {
    const player = await client.query<{ id: string }>(
      "INSERT INTO esports_players (alias) VALUES ('Ana') RETURNING id"
    );
    const res = await send("POST", `/tournaments/${tournament}/register`, {
      playerId: player.rows[0]!.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("Approved");
  });
});

// ── kon-blog ─────────────────────────────────────────────────────────────────

describe("kon-blog: a value Postgres refuses is its 4xx, not a 500", () => {
  let client: PGlite;
  let app: Hono;
  const send = sender(() => app);
  const OUT_OF_RANGE = { error: "A value does not have the format or range that is allowed." };

  async function post(slug: string): Promise<string> {
    const r = await client.query<{ id: string }>(
      "INSERT INTO blog_posts (title, slug, author_id) VALUES ($1, $2, $3) RETURNING id",
      [`Post ${slug}`, slug, ADMIN.id]
    );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    client = new PGlite();
    // The same hand-written schema as blog-docs-review-fixes.test.ts: the kon's migrations need
    // tables of the core and of kon-games.
    await client.exec(`
      CREATE TYPE blog_status AS ENUM ('draft','published','scheduled','archived');
      CREATE TABLE blog_posts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title varchar(500) NOT NULL,
        slug varchar(500) NOT NULL UNIQUE,
        content jsonb, excerpt text, bluf_text text, faq_data jsonb, dataset_url text,
        meta_title varchar(70), meta_description varchar(170), og_image_id uuid,
        featured_image_focal_point jsonb,
        status blog_status NOT NULL DEFAULT 'draft',
        published_at timestamptz,
        author_id text NOT NULL,
        featured_image_id uuid, reading_time integer, seo_overrides jsonb, blocks jsonb,
        layout varchar(20) NOT NULL DEFAULT 'article',
        source jsonb,
        comments_enabled boolean NOT NULL DEFAULT true,
        locale varchar(5) NOT NULL DEFAULT 'es',
        translation_group_id uuid,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE blog_posts_to_tags (post_id uuid NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE, tag_id uuid NOT NULL, PRIMARY KEY (post_id, tag_id));
      CREATE TABLE blog_posts_to_games (post_id uuid NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE, game_id uuid NOT NULL, PRIMARY KEY (post_id, game_id));
      CREATE TABLE blog_categories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, slug varchar(200) NOT NULL UNIQUE,
        description text, parent_id uuid REFERENCES blog_categories(id) ON DELETE SET NULL,
        display_order integer NOT NULL DEFAULT 0, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE blog_posts_to_categories (post_id uuid NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE, category_id uuid NOT NULL REFERENCES blog_categories(id) ON DELETE CASCADE, PRIMARY KEY (post_id, category_id));
      CREATE TABLE comments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject_type text, subject_id text, status text);
      CREATE TABLE data_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title varchar(500) NOT NULL, data_set_id uuid NOT NULL, data jsonb NOT NULL, owner_id text);
      CREATE TABLE auth_users (id text PRIMARY KEY, email text, name text);
    `);
    const host = rlsHost(drizzle(client), auth);
    const ctx = createTestKonContext({
      db: host.db as any,
      auth: { ...auth, usersById: async () => new Map() } as any,
      cache: {
        get: async () => null,
        set: async () => {},
        del: async () => {},
        invalidate: async () => {},
      } as any,
      events: { emit: () => {} } as any,
      realtime: { broadcast: () => {} } as any,
    });
    app = host.mount(createBlogRouter(ctx) as unknown as Hono);
  }, 60_000);

  afterAll(async () => client?.close());
  beforeEach(async () => {
    resetAuthz();
    registerBlogPolicy();
    await client.exec("DELETE FROM blog_posts; DELETE FROM blog_categories;");
  });

  test("create-category: an order that does not fit the column", async () => {
    const res = await send("POST", "/categories", {
      name: "Guides",
      slug: "guides",
      displayOrder: 99_999_999_999,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual(OUT_OF_RANGE);

    const ok = await send("POST", "/categories", { name: "Guides", slug: "guides" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  test("update-category: an order that does not fit the column", async () => {
    const created = await send("POST", "/categories", { name: "News", slug: "news" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const res = await send("PATCH", `/categories/${created.body.id}`, {
      name: "Renamed",
      displayOrder: 99_999_999_999,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual(OUT_OF_RANGE);

    const row = await client.query<{ name: string }>(
      "SELECT name FROM blog_categories WHERE id = $1",
      [created.body.id]
    );
    expect(row.rows[0]!.name).toBe("News");
  });

  test("update-post: another post's slug is a 409 and nothing of the update is kept", async () => {
    await post("taken");
    const mine = await post("mine");

    const res = await send("PATCH", `/${mine}`, { title: "New title", slug: "taken" });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toEqual({ error: "A record with that unique value already exists." });

    const row = await client.query<{ title: string; slug: string }>(
      "SELECT title, slug FROM blog_posts WHERE id = $1",
      [mine]
    );
    expect(row.rows[0]).toEqual({ title: "Post mine", slug: "mine" });
  });

  test("update-post: a category that does not exist undoes the update of the post too", async () => {
    const mine = await post("with-relations");

    const res = await send("PATCH", `/${mine}`, {
      title: "New title",
      categoryIds: [randomUUID()],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toEqual({ error: "It refers to a nonexistent record." });

    const row = await client.query<{ title: string }>("SELECT title FROM blog_posts WHERE id = $1", [
      mine,
    ]);
    expect(row.rows[0]!.title).toBe("Post with-relations");

    const ok = await send("PATCH", `/${mine}`, { title: "New title" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.title).toBe("New title");
  });
});
