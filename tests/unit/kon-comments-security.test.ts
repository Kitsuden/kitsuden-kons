/**
 * kon-comments — authorization and abuse, with DIFFERENT users
 * ============================================================================
 *
 * Against PGlite (real embedded Postgres). Account sign-up is public, so
 * here "with a session" is anyone: each test pits two normal accounts
 * (Alicia and Bruno) against the moderator.
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

process.env.KITSUDEN_COMMENT_BLOCKLIST = "casino";

const USERS: Record<string, { id: string; role: string; name?: string; email: string }> = {
  alicia: { id: "u-alicia", role: "user", name: "Alicia", email: "alicia@example.com" },
  bruno: { id: "u-bruno", role: "user", name: "Bruno", email: "bruno@example.com" },
  // Registered without a name: all there is is their email.
  sinnombre: { id: "u-sinnombre", role: "user", name: "", email: "privado@example.com" },
  mod: { id: "u-mod", role: "editor", name: "Moderadora", email: "mod@example.com" },
  // Agents (phase D): they arrive with `role: "agent"` and their scopes.
  agentWithoutScope: { id: "ag-nulo", role: "agent", name: "bot", email: "", scopes: ["mcp:connect"] } as any,
  commentingAgent: { id: "ag-com", role: "agent", name: "bot2", email: "", scopes: ["comments:*"] } as any,
};

let client: PGlite;
let app: any;
let registerPolicy: () => void;
const POST_ID = "11111111-1111-4111-8111-111111111111";

const who = (c: any) => USERS[c.req.header("x-test-user") ?? ""];

async function request(
  user: string | null,
  method: string,
  route: string,
  bodyValue?: unknown
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user;
  const res = await app.request(route, {
    method: method,
    headers,
    ...(bodyValue !== undefined ? { body: JSON.stringify(bodyValue) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const comment = (user: string | null, body: string, extra: Record<string, unknown> = {}) =>
  request(user, "POST", "/", { subjectType: "blog_post", subjectId: POST_ID, body, ...extra });

beforeAll(async () => {
  client = new PGlite();
  await client.exec(
    readFileSync(
      resolve(__dirname, "../../kons/kon-comments/migrations/0001_comments.sql"),
      "utf8"
    )
  );
  await client.exec(
    "CREATE TABLE blog_posts (id uuid PRIMARY KEY, title text, slug text, status text);" +
      `INSERT INTO blog_posts VALUES ('${POST_ID}', 'Guía', 'guia', 'published');`
  );

  const mod = await import("../../kons/kon-comments/index");
  const pol = await import("../../kons/kon-comments/comments.policy");
  registerPolicy = pol.registerCommentsPolicy;

  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: {
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
    } as any,
  });
  app = mod.createKonComments(ctx);
  app.onError((err: unknown, c: any) => respondError(c, err));
});

beforeEach(async () => {
  registerPolicy();
  await client.exec("DELETE FROM comment_votes; DELETE FROM comments;");
});

afterAll(async () => {
  await client?.close();
});

describe("IDOR: someone else's comment", () => {
  test("Bruno cannot edit Alicia's comment", async () => {
    const { json } = await comment("alicia", "mi comentario");
    const id = json.data.id;
    const r = await request("bruno", "PATCH", `/${id}`, { body: "Alicia dice tonterías" });
    expect(r.status).toBe(403);
    const row: any = await client.query("SELECT body FROM comments WHERE id = $1", [id]);
    expect(row.rows[0].body).toBe("mi comentario");
  });

  test("Bruno cannot delete or moderate Alicia's comment", async () => {
    const { json } = await comment("alicia", "mío");
    const id = json.data.id;
    expect((await request("bruno", "DELETE", `/${id}`)).status).toBe(403);
    expect((await request("bruno", "POST", `/${id}/moderate`, { status: "hidden" })).status).toBe(
      403
    );
    expect(
      (await request("bruno", "POST", "/moderation/bulk", { ids: [id], status: "hidden" })).status
    ).toBe(403);
    expect((await request("bruno", "GET", "/moderation/queue")).status).toBe(403);
    const row: any = await client.query("SELECT status FROM comments WHERE id = $1", [id]);
    expect(row.rows[0].status).toBe("published");
  });

  test("author, status and score cannot be set on create", async () => {
    const { status, json } = await comment("bruno", "hola", {
      authorId: "u-alicia",
      authorName: "Alicia",
      status: "published",
      score: 9999,
    });
    // The schema is strict: extra fields are REJECTED, not ignored.
    expect(status).toBe(422);
    expect(json).not.toHaveProperty("data");
    const n: any = await client.query("SELECT count(*)::int AS n FROM comments");
    expect(n.rows[0].n).toBe(0);

    // And what does get in carries the SESSION's author.
    const ok = await comment("bruno", "hola");
    expect(ok.json.data.authorId).toBe("u-bruno");
    expect(ok.json.data.authorName).toBe("Bruno");
    expect(ok.json.data.score).toBe(0);
  });

  test("anonymous cannot comment, vote or edit", async () => {
    const { json } = await comment("alicia", "x");
    expect((await comment(null, "x")).status).toBe(401);
    expect((await request(null, "POST", `/${json.data.id}/vote`, { value: 1 })).status).toBe(401);
    expect((await request(null, "PATCH", `/${json.data.id}`, { body: "y" })).status).toBe(401);
  });
});

/**
 * Phase D (e2e, 2026-10-25): an agent with ONLY `mcp:connect` published
 * comments on the site (201) and voted: the policy was `create: user != null`
 * and the vote asked no one. An agent does what its scopes say.
 */
describe("agents: only with scope", () => {
  test("without the comments scope it neither comments nor votes", async () => {
    const { json } = await comment("alicia", "hola");
    expect((await comment("agentWithoutScope", "spam de bot")).status).toBe(403);
    expect((await request("agentWithoutScope", "POST", `/${json.data.id}/vote`, { value: 1 })).status).toBe(403);
    const n: any = await client.query("SELECT count(*)::int AS n FROM comments");
    expect(n.rows[0].n).toBe(1);
    const s: any = await client.query("SELECT score FROM comments WHERE id = $1", [json.data.id]);
    expect(s.rows[0].score).toBe(0);
  });

  test("with comments:* it does", async () => {
    const r = await comment("commentingAgent", "resumen del bot");
    expect(r.status).toBe(201);
    expect((await request("commentingAgent", "POST", `/${r.json.data.id}/vote`, { value: 1 })).status).toBe(200);
  });
});

describe("votes", () => {
  test("voting several times at once counts ONE and gives no 500", async () => {
    const { json } = await comment("alicia", "votadme");
    const id = json.data.id;
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => request("bruno", "POST", `/${id}/vote`, { value: 1 }))
    );
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const row: any = await client.query("SELECT score FROM comments WHERE id = $1", [id]);
    expect(row.rows[0].score).toBe(1);
  });

  test("you cannot vote on a comment in the review queue", async () => {
    const { json } = await comment("alicia", "visita mi casino");
    expect(json.data.status).toBe("pending");
    expect((await request("bruno", "POST", `/${json.data.id}/vote`, { value: 1 })).status).toBe(404);
  });
});

describe("filter and abuse", () => {
  test("editing does not skip the filter: something published that now says something banned goes back to review", async () => {
    const { json } = await comment("alicia", "texto inocente");
    expect(json.data.status).toBe("published");
    const r = await request("alicia", "PATCH", `/${json.data.id}`, { body: "entra al casino" });
    expect(r.status).toBe(200);
    expect(r.json.data.status).toBe("pending");
  });

  test("a normal account has a cap on consecutive comments; the moderator does not", async () => {
    for (let i = 0; i < 10; i++) expect((await comment("bruno", `spam ${i}`)).status).toBe(201);
    expect((await comment("bruno", "spam 10")).status).toBe(429);
    // The cap is Bruno's, not the thread's: Alicia can still comment.
    expect((await comment("alicia", "yo sí")).status).toBe(201);
    for (let i = 0; i < 12; i++) expect((await comment("mod", `aviso ${i}`)).status).toBe(201);
  });

  test("a huge body is rejected", async () => {
    expect((await comment("alicia", "x".repeat(10_001))).status).toBe(422);
  });
});

describe("personal data in the public read", () => {
  test("someone without a name does NOT publish their email", async () => {
    const { json } = await comment("sinnombre", "hola");
    expect(json.data.authorName).toBeNull();

    const thread = await request(null, "GET", `/blog_post/${POST_ID}`);
    expect(JSON.stringify(thread.json)).not.toContain("privado@example.com");
  });

  test("the public thread does not hand out account ids; each one sees which is theirs", async () => {
    await comment("alicia", "uno");
    const anonymous = await request(null, "GET", `/blog_post/${POST_ID}`);
    expect(anonymous.json.data[0].comment).not.toHaveProperty("authorId");
    expect(anonymous.json.data[0].comment.mine).toBe(false);

    const its = await request("alicia", "GET", `/blog_post/${POST_ID}`);
    expect(its.json.data[0].comment.mine).toBe(true);
    const foreign = await request("bruno", "GET", `/blog_post/${POST_ID}`);
    expect(foreign.json.data[0].comment.mine).toBe(false);
  });

  test("what is under review cannot be read from outside, but the moderator does see it", async () => {
    await comment("alicia", "mi casino favorito");
    const outside = await request("bruno", "GET", `/blog_post/${POST_ID}`);
    expect(JSON.stringify(outside.json)).not.toContain("casino");
    const mod = await request("mod", "GET", `/blog_post/${POST_ID}`);
    expect(JSON.stringify(mod.json)).toContain("casino");
  });
});
