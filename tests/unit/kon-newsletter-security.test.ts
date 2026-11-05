/**
 * kon-newsletter — sign-up, confirmation and unsubscribe against an attacker
 * ============================================================================
 *
 * Against PGlite and with `mail.fake()`. What is pinned down:
 *
 *   · sign-up is not an oracle (neither by text nor by TIME);
 *   · the double opt-in expires, and its link is burned in a single statement;
 *   · public sign-up cannot write segmentation attributes;
 *   · one person's unsubscribe does not unsubscribe another.
 *
 * Security review of 2026-10-15.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { mail } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

let client: PGlite;
let app: any;
let service: any;
const SITE = "https://sitio.example";

const high = (body: unknown) =>
  app.request("/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Sign-up runs AFTER responding: we wait for the row to appear. */
async function waitForRow(email: string, field = "confirm_token") {
  for (let i = 0; i < 100; i++) {
    const r: any = await client.query(`SELECT * FROM nl_members WHERE email = $1`, [email]);
    if (r.rows[0]?.[field]) return r.rows[0];
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error(`Did not appear ${email}`);
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(
    readFileSync(
      resolve(__dirname, "../../kons/kon-newsletter/migrations/0000_initial.sql"),
      "utf8"
    )
  );
  await client.exec(
    "INSERT INTO nl_newsletters (name, slug, active) VALUES ('Boletín', 'boletin', true)"
  );

  const mails = await import("../../kons/kon-newsletter/newsletter.mails");
  mail.registerAll(mails.newsletterMailables);
  for (const [locale, entries] of Object.entries(mails.newsletterTranslations)) {
    mail.addTranslations(locale, entries as Record<string, string>);
  }

  service = await import("../../kons/kon-newsletter/newsletter.service");
  const { createNewsletterRouter } =
    await import("../../kons/kon-newsletter/newsletter.routes");
  // The routes are SDK operations: the admin ones require a session
  // (`access: "session"`), so the context needs its `requireAuth`.
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
    config: { siteUrl: SITE, siteName: "Sitio", environment: "test" } as any,
    auth: auth as any,
  });
  app = createNewsletterRouter(ctx, { name: "nullable" } as any, new Map());
});

beforeEach(() => {
  mail.fake();
  mail.clearSent();
});

afterAll(async () => {
  mail.restore();
  await client?.close();
});

describe("sign-up is not an oracle", () => {
  test("same response for a new address and an already subscribed one", async () => {
    await client.exec(
      "INSERT INTO nl_members (email, status, unsub_token) VALUES ('ya@example.com', 'subscribed', 'tok-ya')"
    );
    const fresh = await high({ email: "nueva@example.com" });
    const already = await high({ email: "ya@example.com" });
    expect(fresh.status).toBe(already.status);
    expect(await fresh.json()).toEqual(await already.json());
  });

  test("and the same TIME: responding does not wait for the confirmation email", async () => {
    // An SMTP that never answers. Before, the request for a new address
    // hung here and the one for an already subscribed address did not: that is the oracle.
    mail.setDriver({ name: "colgado", send: () => new Promise(() => {}) } as any);
    const race = await Promise.race([
      high({ email: "lenta@example.com" }).then((r: Response) => r.status),
      new Promise((ok) => setTimeout(() => ok("colgada"), 2000)),
    ]);
    expect(race).toBe(200);
  });
});

describe("double opt-in", () => {
  test("public sign-up does NOT write segmentation attributes", async () => {
    await high({
      email: "atrib@example.com",
      attributes: { web: "principal", plan: "pro", vip: true },
    });
    const row = await waitForRow("atrib@example.com");
    expect(row.attributes).toEqual({ web: "principal" });
  });

  test("an expired confirmation link does not confirm", async () => {
    await high({ email: "tarde@example.com" });
    const row = await waitForRow("tarde@example.com");
    await client.query(
      "UPDATE nl_members SET confirm_sent_at = now() - interval '4 days' WHERE email = 'tarde@example.com'"
    );
    const res = await app.request(`/confirm?token=${row.confirm_token}`);
    expect(res.status).toBe(400);
    const after: any = await client.query(
      "SELECT status FROM nl_members WHERE email = 'tarde@example.com'"
    );
    expect(after.rows[0].status).toBe("pending");
  });

  test("confirming twice at once seals ONCE and sends ONE welcome", async () => {
    await high({ email: "doble@example.com" });
    const row = await waitForRow("doble@example.com");
    mail.clearSent();
    const rs = await Promise.all([
      service.confirm(drizzle(client), row.confirm_token, { appUrl: SITE }),
      service.confirm(drizzle(client), row.confirm_token, { appUrl: SITE }),
    ]);
    expect(rs.every((r: any) => r.ok)).toBe(true);
    // The welcome goes out in the background (outside the transaction).
    await Promise.all(rs.map((r: any) => r.welcome));
    expect(mail.sent("newsletter.welcome")).toHaveLength(1);
  });

  test("the welcome carries an ABSOLUTE unsubscribe link", async () => {
    await high({ email: "bienvenida@example.com" });
    const row = await waitForRow("bienvenida@example.com");
    mail.clearSent();
    const res = await app.request(`/confirm?token=${row.confirm_token}`);
    expect(res.status).toBe(200);
    // It goes out after responding (background): we wait for it to arrive.
    for (let i = 0; i < 100 && !mail.sent("newsletter.welcome").length; i++) {
      await new Promise((ok) => setTimeout(ok, 20));
    }
    const [m] = mail.sent("newsletter.welcome");
    expect(m.html).toContain(`${SITE}/api/newsletter/unsubscribe?token=`);
  });
});

describe("low", () => {
  test("one person's token does not unsubscribe another, and a made-up one responds the same", async () => {
    await client.exec(
      "INSERT INTO nl_members (email, status, unsub_token) VALUES " +
        "('ana@example.com', 'subscribed', 'tok-ana'), ('beto@example.com', 'subscribed', 'tok-beto')"
    );
    const madeUp = await app.request("/unsubscribe?token=no-existe");
    const real = await app.request("/unsubscribe?token=tok-ana");
    expect(madeUp.status).toBe(real.status);
    expect(await madeUp.json()).toEqual(await real.json());

    const r: any = await client.query(
      "SELECT email, status FROM nl_members WHERE email IN ('ana@example.com','beto@example.com') ORDER BY email"
    );
    expect(r.rows).toEqual([
      { email: "ana@example.com", status: "unsubscribed" },
      { email: "beto@example.com", status: "subscribed" },
    ]);
  });

  test("admin routes do not open without the admin role", async () => {
    // Without a session, 401 (SDK operation with `access: "session"`; before the SDK
    // the admin middleware answered 403 to anonymous users too).
    expect((await app.request("/members")).status).toBe(401);
    expect((await app.request("/campaigns")).status).toBe(401);
    // With a session but without the admin role, 403.
    const account = { headers: { "x-test-user": JSON.stringify({ id: "u-1", role: "editor" }) } };
    expect((await app.request("/members", account)).status).toBe(403);
    expect((await app.request("/campaigns", account)).status).toBe(403);
  });
});
