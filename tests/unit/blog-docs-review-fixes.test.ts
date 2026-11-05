/**
 * kon-blog: fixes from the 2026-11 docs review
 * ============================================================================
 *
 * - A post CREATED as published emits `blog:post:published` (once), so the
 *   newsletter's auto-send fires for it too; a draft does not.
 * - Creating a category keeps its `description`.
 * - The SEO route derives og:locale from the post's language, not a fixed es_ES.
 *
 * Real SQL with PGlite (same setup as blog-publish-on-edit.test.ts).
 */

import { PGlite } from "@electric-sql/pglite";
import { resetAuthz } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";


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
};

let client: PGlite;
const emitted: { name: string; payload: unknown }[] = [];
let app: Hono;

async function request(
  who: keyof typeof USERS,
  method: string,
  path: string,
  body?: unknown
) {
  const res = await app.request(path, {
    method: method,
    headers: { "content-type": "application/json", "x-test-user": who },
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
            .map((id) => [id, { id, name: id === ADMIN ? "Admin" : "Editor", image: null }])
        ),
    } as any,
    cache: {
      get: async () => null,
      set: async () => {},
      del: async () => {},
      invalidate: async () => {},
    } as any,
    events: { emit: (name: string, payload: unknown) => emitted.push({ name, payload }) } as any,
    realtime: { broadcast: () => {} } as any,
  });

  app = new Hono();
  // The role of the API's global middleware: sets the user (person or agent).
  app.use("*", async (c, next) => {
    const u = USERS[c.req.header("x-test-user") ?? "anonymous"];
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
  emitted.length = 0;
  // Global registry: it is emptied and filled again, as another file would do.
  resetAuthz();
  registerBlogPolicy();
  await client.exec(
    "DELETE FROM blog_posts; DELETE FROM blog_categories; DELETE FROM data_entries; DELETE FROM auth_users;"
  );
});



const published = () => emitted.filter((e) => e.name === "blog:post:published");

describe("blog:post:published on create", () => {
  it("a post created as published emits it exactly once, with the post", async () => {
    const r = await request("editor", "POST", "/api/blog", {
      title: "Born published",
      slug: "born-published",
      status: "published",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(published()).toHaveLength(1);
    const payload = published()[0]!.payload as { postId: string; post: { id: string; title: string } };
    expect(payload.postId).toBe(r.body.id);
    expect(payload.post.title).toBe("Born published");
  });

  it("a draft does not emit it", async () => {
    const r = await request("editor", "POST", "/api/blog", { title: "Draft", slug: "a-draft" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(published()).toHaveLength(0);
  });
});

describe("create-category", () => {
  it("persists the description", async () => {
    const r = await request("editor", "POST", "/api/blog/categories", {
      name: "Guides",
      slug: "guides",
      description: "Long-form how-tos",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.description).toBe("Long-form how-tos");
    const row = await client.query<{ description: string | null }>(
      "SELECT description FROM blog_categories WHERE slug = 'guides'"
    );
    expect(row.rows[0]!.description).toBe("Long-form how-tos");
    const list = await request("anonymous", "GET", "/api/blog/categories");
    expect(list.body.docs[0].description).toBe("Long-form how-tos");
  });
});

describe("SEO og:locale", () => {
  const seo = async (slug: string, query = "") =>
    (await request("anonymous", "GET", `/api/blog/seo/${slug}${query}`)).body.seo.openGraph.locale;

  it("comes from the post's language", async () => {
    await insertPost({ title: "Post en", slug: "post-en", author_id: EDITOR, status: "published", published_at: new Date("2026-01-01"), locale: "en" });
    await insertPost({ title: "Post pt", slug: "post-pt", author_id: EDITOR, status: "published", published_at: new Date("2026-01-01"), locale: "pt" });
    await insertPost({ title: "Post es", slug: "post-es", author_id: EDITOR, status: "published", published_at: new Date("2026-01-01"), locale: "es" });
    expect(await seo("post-en")).toBe("en_US");
    expect(await seo("post-pt")).toBe("pt_BR");
    expect(await seo("post-es")).toBe("es_ES");
  });

  it("falls back to the site language, then en_US", async () => {
    await insertPost({ title: "No lang", slug: "no-lang", author_id: EDITOR, status: "published", published_at: new Date("2026-01-01"), locale: "" });
    expect(await seo("no-lang", "?language=fr")).toBe("fr_FR");
    expect(await seo("no-lang")).toBe("en_US");
  });
});
