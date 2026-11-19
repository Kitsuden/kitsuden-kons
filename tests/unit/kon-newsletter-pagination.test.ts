/**
 * kon-newsletter: lists that grow with use take a page size
 * ============================================================================
 *
 * Suppressions and campaigns used to stop at 500 and 100 rows with no sign. They take `limit` (whose default
 * is still that cap) and `offset`, and answer `hasMore`. Members keep their own `limit` (default 100, max 500)
 * and take `offset` with `hasMore` too. Against PGlite (same setup as
 * kon-newsletter-security.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

let client: PGlite;
let app: any;
const ADMIN = { headers: { "x-test-user": JSON.stringify({ id: "admin-1", role: "admin" }) } };
const get = async (path: string): Promise<any> => {
  const res = await app.request(path, ADMIN);
  expect(res.status, path).toBe(200);
  return res.json();
};

beforeAll(async () => {
  client = new PGlite();
  await client.exec(readFileSync(resolve(__dirname, "../../kons/kon-newsletter/migrations/0000_initial.sql"), "utf8"));
  const [newsletter] = (await client.query<{ id: string }>("INSERT INTO nl_newsletters (name, slug, active) VALUES ('News', 'news', true) RETURNING id")).rows;
  await client.query(
    `INSERT INTO nl_campaigns (newsletter_id, subject, html, created_at) VALUES ($1, 'First', '<p>1</p>', now() - interval '2 minutes'), ($1, 'Second', '<p>2</p>', now() - interval '1 minute')`,
    [newsletter!.id]
  );
  await client.exec(
    "INSERT INTO nl_members (email, status, unsub_token, created_at) VALUES ('m1@example.com', 'subscribed', 'u1', now() - interval '3 minutes'), ('m2@example.com', 'subscribed', 'u2', now() - interval '2 minutes'), ('m3@example.com', 'pending', 'u3', now() - interval '1 minute')"
  );
  await client.exec(
    "INSERT INTO nl_suppressions (email, reason, created_at) VALUES ('a@example.com', 'bounce', now() - interval '2 minutes'), ('b@example.com', 'manual', now() - interval '1 minute')"
  );

  const { createNewsletterRouter } = await import("../../kons/kon-newsletter/newsletter.routes");
  const auth = {
    requireAuth: async (c: any, next: any) => {
      const raw = c.req.header("x-test-user");
      if (!raw) return c.json({ error: "Unauthorized" }, 401);
      c.set("user", JSON.parse(raw));
      await next();
    },
    optionalAuth: async (_c: any, next: any) => next(),
  };
  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    config: { siteUrl: "https://site.example", siteName: "Site", environment: "test" } as any,
    auth: auth as any,
    events: { emit: () => {}, on: () => {}, off: () => {} } as any,
  });
  app = createNewsletterRouter(ctx, { name: "nullable" } as any, new Map());
});

afterAll(async () => {
  await client?.close();
});

describe("kon-newsletter list pagination", () => {
  for (const [path, field] of [
    ["/suppressions", "suppressions"],
    ["/campaigns", "campaigns"],
  ] as const) {
    test(`${path}: limit=1 answers one row and hasMore; without limit every row`, async () => {
      const page = await get(`${path}?limit=1`);
      expect(page[field]).toHaveLength(1);
      expect(page.hasMore).toBe(true);

      const next = await get(`${path}?limit=1&offset=1`);
      expect(next[field]).toHaveLength(1);
      expect(next[field][0].id).not.toBe(page[field][0].id);
      expect(next.hasMore).toBe(false);

      const all = await get(path);
      expect(all[field]).toHaveLength(2);
      expect(all.hasMore).toBe(false);
    });
  }

  test("/members: no parameters answer what they did; limit=1&offset=1 is the second row; hasMore", async () => {
    const emails = (r: { members: Array<{ email: string }> }) => r.members.map((m) => m.email);
    const all = await get("/members");
    expect(emails(all)).toEqual(["m3@example.com", "m2@example.com", "m1@example.com"]);
    expect(all.hasMore).toBe(false);

    const first = await get("/members?limit=1");
    expect(emails(first)).toEqual(["m3@example.com"]);
    expect(first.hasMore).toBe(true);

    const second = await get("/members?limit=1&offset=1");
    expect(emails(second)).toEqual(["m2@example.com"]);
    expect(second.hasMore).toBe(true);

    const last = await get("/members?limit=2&offset=1");
    expect(emails(last)).toEqual(["m2@example.com", "m1@example.com"]);
    expect(last.hasMore).toBe(false);

    expect((await app.request("/members?offset=-1", ADMIN)).status).toBe(422);
  });

  test("newest first, as before", async () => {
    expect((await get("/campaigns")).campaigns.map((c: { subject: string }) => c.subject)).toEqual(["Second", "First"]);
    expect((await get("/suppressions")).suppressions.map((s: { email: string }) => s.email)).toEqual(["b@example.com", "a@example.com"]);
  });

  test("a page size beyond the cap is refused", async () => {
    expect((await app.request("/campaigns?limit=101", ADMIN)).status).toBe(422);
    expect((await app.request("/suppressions?limit=501", ADMIN)).status).toBe(422);
  });
});
