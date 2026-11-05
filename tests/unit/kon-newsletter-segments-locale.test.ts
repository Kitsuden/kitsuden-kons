/**
 * kon-newsletter: fixes from the 2026-11 docs review
 * ============================================================================
 *
 * - A segment's `newsletters` filter (slugs) restricts the recipients: before, it
 *   was accepted and ignored, so the segment went to every subscriber.
 * - The portal page, the widget and a sign-up without `locale` use
 *   `NEWSLETTER_DEFAULT_LOCALE`, else English — not a fixed Spanish.
 *
 * Against PGlite (same setup as kon-newsletter-security.test.ts).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

let client: PGlite;
let db: any;
let app: any;
let service: any;
let types: any;
const ids: Record<string, string> = {};

beforeAll(async () => {
  client = new PGlite();
  await client.exec(
    readFileSync(resolve(__dirname, "../../kons/kon-newsletter/migrations/0000_initial.sql"), "utf8")
  );
  for (const slug of ["weekly", "deals"]) {
    const r = await client.query<{ id: string }>(
      "INSERT INTO nl_newsletters (name, slug, active) VALUES ($1, $1, true) RETURNING id",
      [slug]
    );
    ids[slug] = r.rows[0]!.id;
  }
  const member = async (email: string, lists: string[]) => {
    const r = await client.query<{ id: string }>(
      "INSERT INTO nl_members (email, status, unsub_token) VALUES ($1, 'subscribed', $2) RETURNING id",
      [email, `tok-${email}`]
    );
    for (const l of lists) {
      await client.query("INSERT INTO nl_subscriptions (member_id, newsletter_id) VALUES ($1, $2)", [
        r.rows[0]!.id,
        ids[l],
      ]);
    }
  };
  await member("weekly@example.com", ["weekly"]);
  await member("deals@example.com", ["deals"]);
  await member("both@example.com", ["weekly", "deals"]);
  await member("none@example.com", []);

  db = drizzle(client);
  service = await import("../../kons/kon-newsletter/newsletter.service");
  types = await import("../../kons/kon-newsletter/newsletter.types");
  const { createNewsletterRouter } = await import("../../kons/kon-newsletter/newsletter.routes");
  const ctx = createTestKonContext({
    db: { instance: db } as any,
    config: { siteUrl: "https://site.example", siteName: "Site", environment: "test" } as any,
    auth: {
      requireAuth: async (c: any) => c.json({ error: "Unauthorized" }, 401),
      optionalAuth: async (_c: any, next: any) => next(),
    } as any,
  });
  app = createNewsletterRouter(ctx, { name: "nullable" } as any, new Map());
});

afterEach(() => {
  delete process.env.NEWSLETTER_DEFAULT_LOCALE;
});

afterAll(async () => {
  await client?.close();
});

const emails = (rows: { email: string }[]) => rows.map((r) => r.email).sort();

describe("segment filter `newsletters`", () => {
  test("restricts to members subscribed to one of the listed newsletters", async () => {
    expect(emails(await service.resolveSegment(db, { newsletters: ["weekly"] }))).toEqual([
      "both@example.com",
      "weekly@example.com",
    ]);
    expect(emails(await service.resolveSegment(db, { newsletters: ["weekly", "deals"] }))).toEqual([
      "both@example.com",
      "deals@example.com",
      "weekly@example.com",
    ]);
  });

  test("an unknown slug matches nobody; no filter matches every subscriber", async () => {
    expect(await service.resolveSegment(db, { newsletters: ["nope"] })).toEqual([]);
    expect(await service.resolveSegment(db, {})).toHaveLength(4);
  });

  test("combines with the campaign's newsletter", async () => {
    expect(emails(await service.resolveSegment(db, { newsletters: ["deals"] }, ids.weekly))).toEqual([
      "both@example.com",
    ]);
  });
});

describe("default language", () => {
  test("English unless NEWSLETTER_DEFAULT_LOCALE says otherwise", () => {
    expect(types.defaultLocale({})).toBe("en");
    expect(types.defaultLocale({ NEWSLETTER_DEFAULT_LOCALE: "pt-BR" })).toBe("pt-BR");
    expect(types.defaultLocale({ NEWSLETTER_DEFAULT_LOCALE: "<script>" })).toBe("en");
  });

  test("the portal page and widget follow it", async () => {
    let page = await (await app.request("/portal")).text();
    expect(page).toContain('<html lang="en">');
    let script = await (await app.request("/portal.js")).text();
    expect(script).toContain('getAttribute("data-locale") || "en"');

    process.env.NEWSLETTER_DEFAULT_LOCALE = "es";
    page = await (await app.request("/portal")).text();
    expect(page).toContain('<html lang="es">');
    script = await (await app.request("/portal.js")).text();
    expect(script).toContain('getAttribute("data-locale") || "es"');
  });

  test("ships English and Spanish mail translations with the same keys", async () => {
    const { newsletterTranslations } = await import("../../kons/kon-newsletter/newsletter.mails");
    expect(Object.keys(newsletterTranslations.es).sort()).toEqual(
      Object.keys(newsletterTranslations.en).sort()
    );
    expect(newsletterTranslations.en["newsletter.confirm.subject"]).toMatch(/^Confirm your subscription/);
  });
});
