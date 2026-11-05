/**
 * Kon Members — the magic link ARRIVES by email
 * ============================================================================
 *
 * Phase D (2026-10-25), against the real API: `POST /api/members/signin` created
 * the member and the token, emitted `members.signin-requested`… and nothing else. Nobody
 * listened to that event (neither the core nor another kon), so the email never
 * went out and a reader had no way in. Here it is pinned down that the kon itself sends
 * the email with the shared Mailer, that the link in the email opens a
 * session, and that the token still does not appear in the response.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/pglite";

import { mail, respondError } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { createKonMembers, registerMembersPolicy } from "../../kons/kon-members/index";
import { accessUrl } from "../../kons/kon-members/members.mails";

let app: ReturnType<typeof createKonMembers>;
let client: PGlite;

const request = (email: string) =>
  app.request("/signin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name: "Lectora" }),
  });

/** Sending happens in the background: we wait for the outbox to have it. */
async function mailsToA(email: string, n = 1) {
  for (let i = 0; i < 50; i++) {
    const sentItems = mail.sent("members.signin").filter((m) => m.to.includes(email));
    if (sentItems.length >= n) return sentItems;
    await new Promise((r) => setTimeout(r, 10));
  }
  return mail.sent("members.signin").filter((m) => m.to.includes(email));
}

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client);
  const fs = await import("node:fs");
  const path = await import("node:path");
  await client.exec(
    fs.readFileSync(
      path.resolve(__dirname, "../../kons/kon-members/migrations/0001_members.sql"),
      "utf8"
    )
  );
  const ctx = createTestKonContext({
    db: { instance: db } as any,
    auth: { requireAuth: (_c: any, next: any) => next() } as any,
    config: { siteUrl: "https://sitio.example" } as any,
  });
  app = createKonMembers(ctx);
  app.onError((err, c) => respondError(c, err));
});

afterAll(async () => {
  mail.restore();
  await client?.close();
});

beforeEach(() => {
  mail.fake();
  mail.clearSent();
  registerMembersPolicy();
  delete process.env.MEMBERS_SIGNIN_MAIL;
  delete process.env.MEMBERS_SIGNIN_URL;
});

describe("magic link email", () => {
  test("POST /signin sends the email with a link that opens a session", async () => {
    const res = await request("Lectora@Example.com");
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toMatch(/token/i);

    const [emailValue] = await mailsToA("lectora@example.com");
    expect(emailValue, "no access email was sent").toBeDefined();

    const link = emailValue.html.match(/https:\/\/sitio\.example\/members\/verify\?token=([^"&<\s]+)/);
    expect(link, "the email does not carry the link to the access page").not.toBeNull();

    const verify = await app.request("/signin/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: decodeURIComponent(link![1]) }),
    });
    expect(verify.status).toBe(200);
    expect((await verify.json()).data.email).toBe("lectora@example.com");
    expect(verify.headers.get("set-cookie")).toMatch(/kitsuden_member=/);
  });

  test("throttled (second request in a row): no other email is sent", async () => {
    await request("frenada@example.com");
    await mailsToA("frenada@example.com");
    await request("frenada@example.com");
    await new Promise((r) => setTimeout(r, 100));
    expect(mail.sent("members.signin").filter((m) => m.to.includes("frenada@example.com"))).toHaveLength(1);
  });

  test("MEMBERS_SIGNIN_MAIL=off turns it off (another delivery via the event)", async () => {
    process.env.MEMBERS_SIGNIN_MAIL = "off";
    await request("apagado@example.com");
    await new Promise((r) => setTimeout(r, 100));
    expect(mail.sent("members.signin")).toHaveLength(0);
  });

  test("MEMBERS_SIGNIN_URL sets the site's page", () => {
    expect(accessUrl("https://a.example/", "t k", { MEMBERS_SIGNIN_URL: "https://b.example/entrar" })).toBe(
      "https://b.example/entrar?token=t+k"
    );
    expect(accessUrl("https://a.example/", "abc", {})).toBe("https://a.example/members/verify?token=abc");
  });
});
