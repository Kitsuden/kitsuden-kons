/**
 * Blog: publish or schedule WHEN EDITING (PATCH with `publishedAt`)
 * ============================================================================
 *
 * `PATCH /api/blog/:id` with `publishedAt` responded 500
 * "value.toISOString is not a function": the schema validated the date as
 * TEXT (`z.string().datetime()`) and that text reached Drizzle's timestamp
 * column as is. Publishing or scheduling a post while editing
 * failed; saving a draft (without a date) worked, so it went
 * unnoticed. Since the kon SDK the schema converts ISO 8601 → Date
 * (`dateSchema` from @kitsuden/shared).
 *
 * Real SQL with PGlite (same setup as sec-blog-routes.test.ts).
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


describe("PATCH with publishedAt", () => {
  it("an ISO date schedules the post: 200 and the date is saved", async () => {
    const id = await insertPost({ title: "Draft", slug: "borrador", author_id: EDITOR });
    const when = "2031-01-02T10:00:00.000Z";
    const r = await request("editor", "PATCH", `/api/blog/${id}`, {
      status: "scheduled",
      publishedAt: when,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(new Date(r.body.publishedAt).toISOString()).toBe(when);
    const row = await client.query<{ published_at: Date }>(
      "SELECT published_at FROM blog_posts WHERE id = $1",
      [id]
    );
    expect(new Date(row.rows[0]!.published_at).toISOString()).toBe(when);
  });

  it("publishing with a date (status published + publishedAt) is also 200", async () => {
    const id = await insertPost({ title: "Other", slug: "otro", author_id: EDITOR });
    const r = await request("editor", "PATCH", `/api/blog/${id}`, {
      status: "published",
      publishedAt: "2026-10-23T08:30:00+02:00",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe("published");
    expect(new Date(r.body.publishedAt).toISOString()).toBe("2026-10-23T06:30:00.000Z");
  });

  it("null unschedules: 200 and the column is left empty", async () => {
    const id = await insertPost({
      title: "Programado",
      slug: "scheduled",
      author_id: EDITOR,
      status: "scheduled",
      published_at: new Date("2031-01-01T00:00:00Z"),
    });
    const r = await request("editor", "PATCH", `/api/blog/${id}`, {
      status: "draft",
      publishedAt: null,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.publishedAt).toBeNull();
  });

  it("creating with publishedAt (scheduled) also works", async () => {
    const r = await request("editor", "POST", "/api/blog", {
      title: "Programada al crear",
      slug: "programada-al-crear",
      status: "scheduled",
      publishedAt: "2031-05-05T05:05:05.000Z",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(new Date(r.body.publishedAt).toISOString()).toBe("2031-05-05T05:05:05.000Z");
  });

  it("a value that is not a date is still the usual 400, not a 500", async () => {
    const id = await insertPost({ title: "Mal", slug: "bad", author_id: EDITOR });
    const r = await request("editor", "PATCH", `/api/blog/${id}`, { publishedAt: "mañana" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Validation failed");
  });
});
