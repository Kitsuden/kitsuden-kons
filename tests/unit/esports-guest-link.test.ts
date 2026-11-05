/**
 * kon-esports — the guest's personal link points at the public site
 * ============================================================================
 *
 * `register-guest` built `accessLink` from the request's origin, which is the API's host: the
 * guest got `https://api.example.com/t/<id>/me?token=…`, a page the API does not serve. The page
 * lives on the public site, so the link now uses the configured public site URL (the panel's
 * Site URL through `ctx.site.publicUrl()`, else `SITE_URL`, else `config.siteUrl`).
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { resetAuthz, respondError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { registerEsportsPolicy } from "../../kons/kon-esports/esports.policy";
import { publicSiteUrl } from "../../kons/kon-esports/guest-access";
import { createKonEsports } from "../../kons/kon-esports/index";

const ROOT = resolve(__dirname, "../..");
let client: PGlite;
let tournament: string;

const optional: MiddlewareHandler = async (_c, next) => next();
const mandatory: MiddlewareHandler = async (c) => c.json({ error: "Unauthorized" }, 401);

function mount(site?: { publicUrl(): Promise<string> }): Hono {
  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: { requireAuth: mandatory, optionalAuth: optional, requireRole: () => mandatory } as any,
  });
  if (site) (ctx as any).site = site;
  const app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.route("/", createKonEsports(ctx));
  return app;
}

async function registerGuest(app: Hono, alias: string) {
  const res = await app.request(`https://api.example.com/public/tournament/${tournament}/register-guest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alias, email: `${alias.toLowerCase()}@example.com` }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

beforeAll(async () => {
  client = new PGlite();
  const dir = join(ROOT, "kons/kon-esports/migrations");
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  const [row] = (
    await client.query<{ id: string }>(
      `INSERT INTO esports_tournaments
         (title, game_id, status, format, bracket_format, max_participants, registration_mode, allow_guest_registration)
       VALUES ('Open cup', $1, 'Open', '1v1', 'single_elimination', 16, 'open', true) RETURNING id`,
      [randomUUID()]
    )
  ).rows;
  tournament = row.id;
});

afterAll(async () => client?.close());

const savedSiteUrl = process.env.SITE_URL;
beforeEach(() => {
  resetAuthz();
  registerEsportsPolicy();
});
afterEach(() => {
  if (savedSiteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = savedSiteUrl;
});

describe("the guest link", () => {
  test("uses the panel's public site, not the API host that answered", async () => {
    const app = mount({ publicUrl: async () => "https://play.example.com" });
    const { status, json } = await registerGuest(app, "Guesty");
    expect(status).toBe(201);
    expect(json.accessLink).toBe(
      `https://play.example.com/t/${tournament}/me?token=${encodeURIComponent(json.accessToken)}`
    );
    expect(json.accessLink).not.toContain("api.example.com");
  });

  test("without a panel setting, SITE_URL", async () => {
    process.env.SITE_URL = "https://site.example.org";
    // A host whose panel has no Site URL to give (the test context's default site would answer).
    const { status, json } = await registerGuest(mount({ publicUrl: async () => "" }), "Second");
    expect(status).toBe(201);
    expect(json.accessLink.startsWith(`https://site.example.org/t/${tournament}/me?token=`)).toBe(true);
  });
});

describe("publicSiteUrl", () => {
  test("panel, then SITE_URL, then config.siteUrl, then the development default", async () => {
    delete process.env.SITE_URL;
    expect(await publicSiteUrl({ site: { publicUrl: async () => "https://a.test" } })).toBe("https://a.test");
    // A failing panel read falls back instead of breaking the registration.
    expect(
      await publicSiteUrl({
        site: { publicUrl: async () => Promise.reject(new Error("no db")) },
        config: { siteUrl: "https://c.test" },
      })
    ).toBe("https://c.test");
    process.env.SITE_URL = "https://b.test";
    expect(await publicSiteUrl({ config: { siteUrl: "https://c.test" } })).toBe("https://b.test");
    delete process.env.SITE_URL;
    expect(await publicSiteUrl({})).toBe("http://localhost:4321");
  });
});
