/**
 * Security (2026-10-15): the blog authorizes ON ITS OWN
 * ============================================================================
 *
 * The kon's router is mounted WITHOUT the `auth-guard.ts` gate: what is denied
 * here is denied even if tomorrow the `/api/blog` prefix is removed from
 * `ADMIN_ONLY_ROUTES`. Real SQL with PGlite (it lives in vitest because of
 * `mock.module`, see the test-suite notes).
 *
 * Covers: writes by any account (sign-up is open), mass assignment
 * (author, slug), publication with a future date served ahead of time,
 * the origin row of `promote-from-source` (any table) served in the
 * public listing, and the body with stored and served XSS.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetAuthz } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { registerBlogPolicy } from "../../kons/kon-blog/src/blog.policy";
import { createBlogRouter } from "../../kons/kon-blog/src/routes";

const ADMIN = "u-admin-0000000000000000000000";
const EDITOR = "u-editor-000000000000000000000";
const USER = "u-user-00000000000000000000000";

const USERS: Record<string, Record<string, unknown> | null> = {
  anonymous: null,
  user: { id: USER, role: "user" },
  editor: { id: EDITOR, role: "editor" },
  admin: { id: ADMIN, role: "admin" },
  agent: { id: "agent-1", role: "agent", scopes: ["content:edit"] },
  adminAgent: { id: "agent-2", role: "agent", scopes: ["admin"] },
  editorAgent: { id: "agent-3", role: "agent", scopes: ["kon:blog:update-post"] },
  blogAgent: { id: "agent-4", role: "agent", scopes: ["blog:*"] },
  createAgent: { id: "agent-5", role: "agent", scopes: ["kon:blog:create-post"] },
};

let client: PGlite;
let app: Hono;

async function request(
  who: keyof typeof USERS,
  method: string,
  path: string,
  body?: unknown
) {
  const res = await app.request(path, {
    method: method,
    headers: { "content-type": "application/json", "x-quien": who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function insertPost(fields: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(fields);
  const r = await client.query<{ id: string }>(
    `INSERT INTO blog_posts (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    cols.map((c) => {
      const v = fields[c];
      return v && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v;
    })
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  client = new PGlite();
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
  const db = drizzle(client);

  const ctx = createTestKonContext({
    db: { instance: db } as any,
    auth: {
      requireAuth: async (c: any, next: any) =>
        c.get("user") ? next() : c.json({ error: "Unauthorized" }, 401),
      optionalAuth: async (_c: any, next: any) => next(),
      usersById: async (ids: string[]) =>
        new Map(
          ids
            .filter((id) => id === ADMIN || id === EDITOR)
            .map((id) => [id, { id, name: id === ADMIN ? "Admin" : "Editora", image: null }])
        ),
    } as any,
    cache: {
      get: async () => null,
      set: async () => {},
      del: async () => {},
      invalidate: async () => {},
    } as any,
    events: { emit: () => {} } as any,
    realtime: { broadcast: () => {} } as any,
  });

  app = new Hono();
  // The role of the API's global middleware: sets the user (person or agent).
  app.use("*", async (c, next) => {
    const u = USERS[c.req.header("x-quien") ?? "anonymous"];
    if (u) c.set("user" as never, u as never);
    await next();
  });
  // Note: WITHOUT `adminGate(ADMIN_ONLY_ROUTES)`. That is the point of the test.
  app.route("/api/blog", createBlogRouter(ctx) as unknown as Hono);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  // Global registry: it is emptied and filled again, as another file would do.
  resetAuthz();
  registerBlogPolicy();
  await client.exec(
    "DELETE FROM blog_posts; DELETE FROM blog_categories; DELETE FROM data_entries; DELETE FROM auth_users;"
  );
});

const NEW = { title: "Guía nueva", slug: "guia-nueva", status: "published" };

describe("writes: a normal account is NOT team (without the auth-guard gate)", () => {
  it("any account neither creates, edits, publishes nor deletes; an anonymous user, 401", async () => {
    const id = await insertPost({ title: "x", slug: "x", author_id: EDITOR, status: "draft" });

    for (const who of ["user", "agent"] as const) {
      expect((await request(who, "POST", "/api/blog", NEW)).status).toBe(403);
      expect((await request(who, "PATCH", `/api/blog/${id}`, { title: "pwned" })).status).toBe(403);
      expect((await request(who, "POST", `/api/blog/${id}/publish`)).status).toBe(403);
      expect((await request(who, "DELETE", `/api/blog/${id}`)).status).toBe(403);
      expect(
        (await request(who, "POST", "/api/blog/categories", { name: "c", slug: "c" })).status
      ).toBe(403);
      expect((await request(who, "GET", `/api/blog/source/${id}`)).status).toBe(403);
      expect((await request(who, "POST", "/api/blog/validate-seo", { title: "x" })).status).toBe(
        403
      );
    }
    expect((await request("anonymous", "POST", "/api/blog", NEW)).status).toBe(401);

    const r = await client.query<{ title: string; status: string }>(
      "SELECT title, status FROM blog_posts"
    );
    expect(r.rows).toEqual([{ title: "x", status: "draft" }]);
  });

  it("the team does", async () => {
    const createdItem = await request("editor", "POST", "/api/blog", NEW);
    expect(createdItem.status).toBe(201);
    expect(createdItem.body.authorId).toBe(EDITOR);
    expect(
      (await request("admin", "PATCH", `/api/blog/${createdItem.body.id}`, { title: "Editada" })).status
    ).toBe(200);
    expect((await request("admin", "DELETE", `/api/blog/${createdItem.body.id}`)).status).toBe(200);
  });
});

/**
 * Phase D (2026-10-25, e2e): an agent with `admin` edited and published a
 * draft, but could not READ it (404 on GET /:id, outside `?status=draft`):
 * `canViewUnpublished` only looked at the human role. Whoever can edit or
 * publish an entry has to be able to see it before publishing it.
 */
describe("drafts and agents: whoever can edit, can see", () => {
  it("admin, update-post and blog:* see the draft; content:edit and create-post do not", async () => {
    const id = await insertPost({ title: "Draft", slug: "borrador", author_id: EDITOR, status: "draft" });
    for (const who of ["adminAgent", "editorAgent", "blogAgent"] as const) {
      expect((await request(who, "GET", `/api/blog/${id}`)).status, who).toBe(200);
      const list = await request(who, "GET", "/api/blog?status=draft");
      expect(list.body.docs.map((p: any) => p.id), who).toContain(id);
    }
    for (const who of ["agent", "createAgent", "user", "anonymous"] as const) {
      expect((await request(who, "GET", `/api/blog/${id}`)).status, who).toBe(404);
      const list = await request(who, "GET", "/api/blog?status=draft");
      expect(list.body.docs.map((p: any) => p.id), who).not.toContain(id);
    }
  });
});

describe("mass assignment", () => {
  it("slug: only lowercase-digits-hyphens, not reserved, not empty", async () => {
    for (const slug of ["../admin", "a/b", "Mayus", "con espacio", "categories", "x?y=1"]) {
      const r = await request("editor", "POST", "/api/blog", { ...NEW, slug });
      expect(r.status, slug).toBe(400);
    }
    expect((await request("editor", "POST", "/api/blog", { title: "日本語のガイド" })).status).toBe(
      400
    );
    const id = await insertPost({ title: "x", slug: "x", author_id: EDITOR });
    expect((await request("editor", "PATCH", `/api/blog/${id}`, { slug: "../x" })).status).toBe(400);
  });

  it("authorId: an account that exists (another team member is fine), not any string", async () => {
    expect(
      (await request("editor", "POST", "/api/blog", { ...NEW, authorId: "invented" })).status
    ).toBe(400);
    const ok = await request("editor", "POST", "/api/blog", { ...NEW, authorId: ADMIN });
    expect(ok.status).toBe(201);
    expect(ok.body.authorId).toBe(ADMIN);
    expect(
      (await request("editor", "PATCH", `/api/blog/${ok.body.id}`, { authorId: "otro-inventado" }))
        .status
    ).toBe(400);
  });
});

describe("public reads", () => {
  it("a published post with a future date does not appear ahead of time (except to the team)", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await insertPost({
      title: "Ya",
      slug: "ya",
      author_id: EDITOR,
      status: "published",
      published_at: new Date(Date.now() - 1000).toISOString(),
    });
    const idF = await insertPost({
      title: "Mañana",
      slug: "manana",
      author_id: EDITOR,
      status: "published",
      published_at: future,
    });

    const list = await request("anonymous", "GET", "/api/blog");
    expect(list.body.docs.map((p: any) => p.slug)).toEqual(["ya"]);
    expect(
      (await request("anonymous", "GET", "/api/blog?locale=es")).body.docs.map((p: any) => p.slug)
    ).toEqual(["ya"]);
    expect((await request("user", "GET", "/api/blog/slug/manana")).status).toBe(404);
    expect((await request("anonymous", "GET", `/api/blog/${idF}`)).status).toBe(404);
    expect((await request("anonymous", "GET", "/api/blog/seo/manana")).status).toBe(404);
    expect((await request("anonymous", "GET", "/api/blog/geo/manana")).status).toBe(404);

    expect((await request("editor", "GET", "/api/blog/slug/manana")).status).toBe(200);
    expect((await request("editor", "GET", "/api/blog")).body.docs).toHaveLength(2);
  });

  it("a draft: 404 on /seo too (before 403, which confirmed the slug)", async () => {
    await insertPost({ title: "B", slug: "borrador", author_id: EDITOR, status: "draft" });
    expect((await request("anonymous", "GET", "/api/blog/seo/borrador?preview=true")).status).toBe(404);
  });

  it("the origin row (source.snapshot) does not travel to the public; the rest of source does", async () => {
    await insertPost({
      title: "Promovida",
      slug: "promovida",
      author_id: EDITOR,
      status: "published",
      source: {
        type: "kon",
        table: "auth_users",
        imageUrl: "/a.webp",
        snapshot: { rawData: { email: "admin@x.y", password: "hash" } },
      },
    });
    const list = await request("anonymous", "GET", "/api/blog");
    expect(JSON.stringify(list.body)).not.toContain("admin@x.y");
    expect(list.body.docs[0].source.imageUrl).toBe("/a.webp");
    const loose = await request("anonymous", "GET", "/api/blog/slug/promovida");
    expect(JSON.stringify(loose.body)).not.toContain("admin@x.y");
    // The team still has it (the panel uses it).
    expect(JSON.stringify((await request("editor", "GET", "/api/blog")).body)).toContain(
      "admin@x.y"
    );
  });

  it("stored XSS: sanitized on save and, what was already in the database, on serve", async () => {
    const createdItem = await request("editor", "POST", "/api/blog", {
      ...NEW,
      content: '<p>hola</p><script>alert(1)</script><img src=x onerror="alert(1)">',
      blocks: [
        { type: "richtext", data: { content: "[x](javascript:alert(1)) <svg onload=alert(1)>" } },
      ],
    });
    expect(createdItem.status).toBe(201);
    const row = await client.query<{ content: string; blocks: any[] }>(
      "SELECT content, blocks FROM blog_posts WHERE id = $1",
      [createdItem.body.id]
    );
    expect(row.rows[0]!.content).toBe('<p>hola</p><img src="x">');
    expect(JSON.stringify(row.rows[0]!.blocks)).not.toMatch(/javascript|svg|onload/i);

    // Written by a loader directly into the database, without going through the API.
    await insertPost({
      title: "Vieja",
      slug: "vieja",
      author_id: EDITOR,
      status: "published",
      content: JSON.stringify("<p>a</p><script>robar()</script>"),
      blocks: [{ type: "richtext", data: { format: "html", content: "<b onmouseover=x>b</b>" } }],
    });
    const served = await request("anonymous", "GET", "/api/blog/slug/vieja");
    expect(served.body.content).toBe("<p>a</p>");
    expect(served.body.blocks[0].data.content).toBe("<b>b</b>");
    expect(JSON.stringify((await request("anonymous", "GET", "/api/blog")).body)).not.toMatch(
      /robar|onmouseover/
    );
  });
});

describe("promote-from-source (it used to read any table)", () => {
  beforeEach(async () => {
    await client.query(
      "INSERT INTO auth_users (id, email, name) VALUES ($1, 'admin@x.y', 'Admin')",
      [ADMIN]
    );
  });

  it("from a table: the editor cannot; neither can the admin if it is accounts/secrets", async () => {
    const asks = {
      sourceType: "kon",
      konId: "x",
      table: "auth_users",
      recordId: ADMIN,
      autoPublish: true,
    };
    expect((await request("editor", "POST", "/api/blog/promote-from-source", asks)).status).toBe(403);
    expect((await request("admin", "POST", "/api/blog/promote-from-source", asks)).status).toBe(403);
    const r = await client.query("SELECT count(*)::int AS n FROM blog_posts");
    expect(r.rows[0]).toEqual({ n: 0 });
  });

  it("from a dataset: reads data_entries by id and dataset (the panel sends uuids)", async () => {
    const ds = "11111111-1111-4111-8111-111111111111";
    const e = await client.query<{ id: string }>(
      "INSERT INTO data_entries (title, data_set_id, data, owner_id) VALUES ('Fulmintis', $1, $2, 'dueño-secreto') RETURNING id",
      [ds, JSON.stringify({ name: "Fulmintis", role: "dps" })]
    );
    const r = await request("editor", "POST", "/api/blog/promote-from-source", {
      sourceType: "dataset",
      datasetId: ds,
      entryId: e.rows[0]!.id,
      slugPrefix: "meta/my-game",
    });
    expect(r.status).toBe(201);
    expect(r.body.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const row = await client.query<{ source: any; status: string }>(
      "SELECT source, status FROM blog_posts"
    );
    expect(row.rows[0]!.status).toBe("draft");
    expect(JSON.stringify(row.rows[0]!.source)).not.toContain("dueño-secreto");
    // With another dataset it does not find it.
    expect(
      (
        await request("editor", "POST", "/api/blog/promote-from-source", {
          sourceType: "dataset",
          datasetId: "22222222-2222-4222-8222-222222222222",
          entryId: e.rows[0]!.id,
        })
      ).status
    ).toBe(404);
  });
});
