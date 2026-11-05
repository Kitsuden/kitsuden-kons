/**
 * Analytics counts views, not people
 * ============================================================================
 *
 * The analytics kon exists for one specific question —"which game is looked at
 * most?"— and the answer can be given without storing anything about who looks. This
 * test pins exactly that, because it is what erodes on its own: first the IP is added
 * "to filter bots", then a cookie "for uniques", and in the end there is a
 * record of browsing paths that nobody decided to have.
 *
 * ── THE THREE LINES ────────────────────────────────────────────────────────
 *
 * **One row per subject and day, with a counter.** There is no row per visit: without
 * loose events there is no path to reconstruct.
 *
 * **No IP, no cookie, no agent in the table.** The agent is looked at to discard
 * bots and forgotten; there is no column to store it.
 *
 * **Views, never "uniques".** A unique cannot be known without identifying
 * who looks, so that figure is not published.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isBot, MEASURABLE_SUBJECTS } from "../../kons/kon-analytics";

const ROOT = join(__dirname, "..", "..");
const lee = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf-8");
const KON = ["kons", "kon-analytics"];

const SCHEMA = lee(...KON, "analytics.schema.ts");
const ROUTES = lee(...KON, "analytics.routes.ts");
const SQL = lee(...KON, "migrations", "0000_analytics.sql");

describe("what the table stores", () => {
  it("one row per subject and day, not one per visit", () => {
    expect(SCHEMA).toContain('uniqueIndex("analytics_views_subject_day_idx")');
    expect(SCHEMA).toContain("subjectType, t.subjectId, t.day");
    expect(SQL.replace(/\s+/g, " ")).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS analytics_views_sujeto_dia_idx"
    );
  });

  it("there is no column for anything that identifies who looks", () => {
    const forbiddenItems = [
      "ip",
      "ip_address",
      "user_agent",
      "session",
      "cookie",
      "visitor",
      "fingerprint",
      "referer",
    ];
    for (const column of forbiddenItems) {
      expect(SQL.toLowerCase(), column).not.toMatch(new RegExp(`^\\s+${column}\\b`, "m"));
    }
    expect(SCHEMA).not.toMatch(/userAgent|ipAddress|sessionId|visitorId/);
  });

  it("the counter goes up with UPSERT: two simultaneous views do not overwrite each other", () => {
    const block = ROUTES.slice(
      ROUTES.indexOf('route: "/hit"'),
      ROUTES.indexOf('route: "/top"')
    );
    expect(block).toContain("onConflictDoUpdate");
    expect(block).toContain("${analyticsViews.views} + 1");
  });
});

describe("what is accepted and what is discarded", () => {
  it("bots that announce themselves do not count", () => {
    for (const agent of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "ClaudeBot/1.0",
      "facebookexternalhit/1.1",
      "curl/8.4.0",
      "python-requests/2.31.0",
      "Mozilla/5.0 HeadlessChrome/120",
    ]) {
      expect(isBot(agent), agent).toBe(true);
    }
  });

  it("a person with a normal browser does count", () => {
    for (const agent of [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
    ]) {
      expect(isBot(agent), agent).toBe(false);
    }
    // Without an agent it is not discarded: an odd browser is not a bot
    expect(isBot(null)).toBe(false);
  });

  it("a request adds ONE view: the number does not come from the client", () => {
    const block = ROUTES.slice(
      ROUTES.indexOf('route: "/hit"'),
      ROUTES.indexOf('route: "/top"')
    );
    // The body only carries type and id; no `views` or `count`
    expect(block).toContain("{ type?: string; id?: string }");
    expect(block).not.toMatch(/body\?\.(views|count|amount)/);
    expect(block).toContain("views: 1");
  });

  it("the subject has to be of a known type and a uuid", () => {
    expect(MEASURABLE_SUBJECTS).toContain("game");
    expect(MEASURABLE_SUBJECTS).toContain("blog_post");
    expect(MEASURABLE_SUBJECTS).toContain("tournament");
    const block = ROUTES.slice(
      ROUTES.indexOf('route: "/hit"'),
      ROUTES.indexOf('route: "/top"')
    );
    expect(block).toContain("isSubject(type)");
    expect(block).toContain("UUID.test(id)");
  });
});

describe("queries cannot be used to take the database down", () => {
  it("`days` and `limit` are bounded", () => {
    expect(ROUTES).toContain("Math.min(Math.max(Number(v) || defaultValue, 1), 365)");
    expect(ROUTES).toContain('Math.min(Math.max(Number(c.req.query("limit")) || 5, 1), 50)');
  });

  it("\"most viewed\" goes through the type-and-day index", () => {
    expect(SCHEMA).toContain('index("analytics_views_type_day_idx")');
    const top = ROUTES.slice(ROUTES.indexOf('route: "/top"'));
    expect(top).toContain("eq(analyticsViews.subjectType, type)");
    expect(top).toContain("gte(analyticsViews.day,");
  });
});
