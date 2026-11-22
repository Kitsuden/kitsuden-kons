/**
 * Security (2026-11-21): two rules of kon-blog that only held on one route
 * ============================================================================
 *
 *   - THE SIGNER RULE (Phase F). An agent with a human signer writes as that
 *     human; another `authorId` only with `admin`. `create-post` applied it,
 *     but `PATCH /:id` and `promote-from-source` only checked that the author
 *     existed: the agent could move a post onto any account.
 *   - PUBLISHING NEEDS A HUMAN. `publish-post` is `sensitive` (an agent's call
 *     becomes a proposal a human approves), but `create-post` and `update-post`
 *     with `status: "published"` (or a new `publishedAt` on a published post),
 *     and `promote-from-source` with `autoPublish`, published without it.
 *     They now answer 403 to an agent and point to `publish-post`; people are
 *     not affected.
 *
 * Same stack as sec-blog-routes.test.ts: PGlite, the router without the
 * auth-guard gate, the user set by a header.
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
  // An agent whose human signer is the editor (Phase F): it writes as the editor.
  signedAgent: { id: "agent-6", role: "agent", scopes: ["blog:*"], sponsor: { userId: EDITOR, valid: true } },
  // The same with `admin`: it may name another account.
  signedAdminAgent: { id: "agent-7", role: "agent", scopes: ["admin"], sponsor: { userId: EDITOR, valid: true } },
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

const DRAFT = { title: "Agent draft", slug: "agent-draft" };

async function authorOf(id: string): Promise<string> {
  const r = await client.query<{ author_id: string }>("SELECT author_id FROM blog_posts WHERE id = $1", [id]);
  return r.rows[0]!.author_id;
}

async function statusOf(id: string): Promise<{ status: string; published_at: Date | null }> {
  const r = await client.query<{ status: string; published_at: Date | null }>(
    "SELECT status, published_at FROM blog_posts WHERE id = $1",
    [id]
  );
  return r.rows[0]!;
}

async function datasetEntry(): Promise<{ datasetId: string; entryId: string }> {
  const datasetId = "11111111-1111-4111-8111-111111111111";
  const e = await client.query<{ id: string }>(
    "INSERT INTO data_entries (title, data_set_id, data, owner_id) VALUES ('Fulmintis', $1, $2, 'x') RETURNING id",
    [datasetId, JSON.stringify({ name: "Fulmintis" })]
  );
  return { datasetId, entryId: e.rows[0]!.id };
}

async function postCount(): Promise<number> {
  return (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM blog_posts")).rows[0]!.n;
}

describe("the signer rule on every path that sets the author", () => {
  it("PATCH: a signed agent cannot move a post to another account; to its signer it can", async () => {
    const id = await insertPost({ title: "x", slug: "x", author_id: EDITOR, status: "draft" });
    const r = await request("signedAgent", "PATCH", `/api/blog/${id}`, { authorId: ADMIN });
    expect(r.status).toBe(403);
    expect(r.body.field).toBe("authorId");
    expect(await authorOf(id)).toBe(EDITOR);
    expect((await request("signedAgent", "PATCH", `/api/blog/${id}`, { authorId: EDITOR })).status).toBe(200);
  });

  it("PATCH: with `admin` the signed agent may name another existing account; a person still may", async () => {
    const id = await insertPost({ title: "x", slug: "x", author_id: EDITOR, status: "draft" });
    expect((await request("signedAdminAgent", "PATCH", `/api/blog/${id}`, { authorId: ADMIN })).status).toBe(200);
    expect(await authorOf(id)).toBe(ADMIN);
    expect((await request("editor", "PATCH", `/api/blog/${id}`, { authorId: EDITOR })).status).toBe(200);
    expect(await authorOf(id)).toBe(EDITOR);
  });

  it("promote-from-source: a signed agent writes as its signer, never as another account", async () => {
    const source = { sourceType: "dataset", ...(await datasetEntry()) };
    const refused = await request("signedAgent", "POST", "/api/blog/promote-from-source", { ...source, authorId: ADMIN });
    expect(refused.status).toBe(403);
    expect(refused.body.field).toBe("authorId");
    expect(await postCount()).toBe(0);

    const ok = await request("signedAgent", "POST", "/api/blog/promote-from-source", source);
    expect(ok.status).toBe(201);
    const [row] = (await client.query<{ author_id: string }>("SELECT author_id FROM blog_posts")).rows;
    expect(row!.author_id).toBe(EDITOR);
  });
});

describe("publishing goes through publish-post (sensitive) for agents", () => {
  it("create-post: an agent cannot create a post already published; a draft it can", async () => {
    for (const who of ["blogAgent", "adminAgent", "signedAgent"] as const) {
      const r = await request(who, "POST", "/api/blog", { ...DRAFT, authorId: EDITOR, status: "published" });
      expect(r.status, who).toBe(403);
      expect(r.body.message, who).toContain("publish-post");
    }
    expect(await postCount()).toBe(0);
    const draft = await request("signedAgent", "POST", "/api/blog", DRAFT);
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("draft");
  });

  it("update-post: an agent cannot set status published, nor move the date of a published post", async () => {
    const draft = await insertPost({ title: "d", slug: "d", author_id: EDITOR, status: "draft" });
    const r = await request("blogAgent", "PATCH", `/api/blog/${draft}`, { status: "published" });
    expect(r.status).toBe(403);
    expect(r.body.message).toContain("publish-post");
    expect((await statusOf(draft)).status).toBe("draft");

    const future = new Date(Date.now() + 86_400_000);
    const scheduled = await insertPost({ title: "s", slug: "s", author_id: EDITOR, status: "published", published_at: future });
    const early = await request("blogAgent", "PATCH", `/api/blog/${scheduled}`, { publishedAt: new Date().toISOString() });
    expect(early.status).toBe(403);
    expect(new Date((await statusOf(scheduled)).published_at!).getTime()).toBe(future.getTime());

    // Editing the text of a draft, or of a published post, is still an agent's job.
    expect((await request("blogAgent", "PATCH", `/api/blog/${draft}`, { title: "edited" })).status).toBe(200);
    expect((await request("blogAgent", "PATCH", `/api/blog/${scheduled}`, { title: "edited" })).status).toBe(200);
  });

  it("promote-from-source: an agent cannot autoPublish", async () => {
    const source = { sourceType: "dataset", ...(await datasetEntry()) };
    const r = await request("signedAgent", "POST", "/api/blog/promote-from-source", { ...source, autoPublish: true });
    expect(r.status).toBe(403);
    expect(r.body.message).toContain("publish-post");
    expect(await postCount()).toBe(0);
  });

  it("people are not affected: the editor creates published, publishes by PATCH and promotes with autoPublish", async () => {
    expect((await request("editor", "POST", "/api/blog", { ...DRAFT, status: "published" })).status).toBe(201);
    const draft = await insertPost({ title: "d", slug: "d", author_id: EDITOR, status: "draft" });
    expect((await request("editor", "PATCH", `/api/blog/${draft}`, { status: "published" })).status).toBe(200);
    const source = { sourceType: "dataset", ...(await datasetEntry()) };
    expect(
      (await request("editor", "POST", "/api/blog/promote-from-source", { ...source, autoPublish: true })).status
    ).toBe(201);
  });
});
