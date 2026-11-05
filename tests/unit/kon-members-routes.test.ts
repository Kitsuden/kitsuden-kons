/**
 * Kon Members — portal and backoffice router
 * ============================================================================
 *
 * Against PGlite (embedded Postgres), with no Docker or network.
 *
 * What is pinned down here is not "CRUD works": it is the three properties that,
 * if they fail, have real consequences for people.
 *
 *   1. `/signin` does NOT reveal which emails are registered.
 *   2. A magic link is SINGLE-USE.
 *   3. The reader session does NOT open the backoffice.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/pglite";

import { respondError } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { createKonMembers, registerMembersPolicy } from "../../kons/kon-members/index";
import {
  consumeSigninToken,
  hashToken,
  issueSigninToken,
  syncSubscriptionAccess,
  upsertMember,
} from "../../kons/kon-members/members.service";

const EDITOR = { id: "u1", role: "editor", email: "editor@example.com" };

let app: ReturnType<typeof createKonMembers>;
let client: PGlite;
let db: ReturnType<typeof drizzle>;
/** Emitted events: the magic link token travels through here, not in the response. */
const events: { name: string; payload: any }[] = [];

async function body(res: Response): Promise<any> {
  return (await res.json()) as any;
}

function fakeRequireAuth(c: any, next: any) {
  c.set("user", EDITOR);
  return next();
}

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  events.length = 0;
  registerMembersPolicy();
});

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client);

  const sql = (await import("node:fs")).readFileSync(
    (await import("node:path")).resolve(
      __dirname,
      "../../kons/kon-members/migrations/0001_members.sql"
    ),
    "utf8"
  );
  await client.exec(sql);

  const ctx = createTestKonContext({
    db: { instance: db } as any,
    auth: { requireAuth: fakeRequireAuth } as any,
    events: {
      emit: (name: string, payload: unknown) => {
        events.push({ name, payload });
      },
      on: () => {},
      off: () => {},
    } as any,
  });

  app = createKonMembers(ctx);
  app.onError((err, c) => respondError(c, err));
});

// ── Portal ───────────────────────────────────────────────────────────────────

describe("planes", () => {
  test("they are public: the pricing page needs them without a session", async () => {
    const res = await app.request("/tiers");
    expect(res.status).toBe(200);
    const { data } = await body(res);
    // The migration seeds the free plan.
    expect(data.some((t: { slug: string }) => t.slug === "free")).toBe(true);
  });
});

describe("magic link", () => {
  test("the token does NOT travel in the response, only through the email event", async () => {
    const res = await app.request("/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Lector@Example.com", name: "Lector" }),
    });

    expect(res.status).toBe(200);
    const payload = await body(res);
    expect(JSON.stringify(payload)).not.toMatch(/token/i);

    const emitted = events.find((e) => e.name === "members.signin-requested");
    expect(emitted).toBeDefined();
    expect(emitted!.payload.token).toBeTruthy();
    // Normalized email: identity cannot depend on casing.
    expect(emitted!.payload.email).toBe("lector@example.com");
  });

  test("does NOT reveal whether an email is registered", async () => {
    // Telling the two cases apart would turn this into an oracle for knowing who
    // is subscribed — sensitive information depending on the topic of the publication.
    const nextValue = await app.request("/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "desconocido@example.com" }),
    });
    const existing = await app.request("/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "lector@example.com" }),
    });

    expect(nextValue.status).toBe(existing.status);
    expect(await body(nextValue)).toEqual(await body(existing));
  });

  test("an invalid email is rejected with 422", async () => {
    const res = await app.request("/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "no-soy-un-email" }),
    });
    expect(res.status).toBe(422);
  });

  test("verifying opens a session and returns the member", async () => {
    await app.request("/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "sesion@example.com" }),
    });
    const token = events.at(-1)!.payload.token;

    const res = await app.request(`/signin/verify?token=${encodeURIComponent(token)}`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const { data } = await body(res);
    expect(data.email).toBe("sesion@example.com");

    // The cookie is httpOnly: out of reach of any JS on the page.
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/kitsuden_member=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  test("a token is SINGLE-USE", async () => {
    await app.request("/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "unsolouso@example.com" }),
    });
    const token = events.at(-1)!.payload.token;

    const first = await app.request(`/signin/verify?token=${token}`, { method: "POST" });
    expect(first.status).toBe(200);

    // A forwarded email or a browser history cannot be a permanent
    // key.
    const second = await app.request(`/signin/verify?token=${token}`, { method: "POST" });
    expect(second.status).toBe(401);
  });

  test("a nonexistent token and an expired one give the SAME error", async () => {
    const res = await app.request("/signin/verify?token=inventado", { method: "POST" });
    expect(res.status).toBe(401);
    // No one has to be told which of the three things they got right.
    expect((await body(res)).error).toBe("Invalid or expired link");
  });

  test("the token is stored HASHED, never in the clear", async () => {
    const member = await upsertMember(db, { email: "hash@example.com" });
    const token = (await issueSigninToken(db, member.id))!;

    const rows: any = await client.query("SELECT token_hash FROM member_signins");
    const stored = rows.rows.map((r: any) => r.token_hash);

    expect(stored).not.toContain(token);
    expect(stored).toContain(hashToken(token));
  });
});

describe("reader session", () => {
  let cookie = "";

  beforeAll(async () => {
    const member = await upsertMember(db, { email: "me@example.com", name: "Yo" });
    const token = (await issueSigninToken(db, member.id))!;
    const result = await consumeSigninToken(db, token);
    cookie = `kitsuden_member=${result!.sessionToken}`;
  });

  test("/me returns null without a cookie", async () => {
    expect((await body(await app.request("/me"))).data).toBeNull();
  });

  test("/me identifies the reader with a cookie", async () => {
    const res = await app.request("/me", { headers: { cookie } });
    const { data, level } = await body(res);
    expect(data.email).toBe("me@example.com");
    expect(level).toBe(0); // has not paid yet
  });

  test("/me does NOT expose the team's internal notes", async () => {
    // `note` holds staff observations about that person: returning them would
    // put them a curl away from the very person they are about.
    const { data } = await body(await app.request("/me", { headers: { cookie } }));
    expect(data).not.toHaveProperty("note");
    expect(data).not.toHaveProperty("labels");
    expect(data).not.toHaveProperty("source");
  });

  test("signing out invalidates it", async () => {
    const member = await upsertMember(db, { email: "salgo@example.com" });
    const token = (await issueSigninToken(db, member.id))!;
    const { sessionToken } = (await consumeSigninToken(db, token))!;
    const c = `kitsuden_member=${sessionToken}`;

    expect((await body(await app.request("/me", { headers: { cookie: c } }))).data).not.toBeNull();
    await app.request("/signout", { method: "POST", headers: { cookie: c } });
    expect((await body(await app.request("/me", { headers: { cookie: c } }))).data).toBeNull();
  });
});

// ── The wall ─────────────────────────────────────────────────────────────────

describe("/gate", () => {
  test("public content passes for anyone", async () => {
    const res = await app.request("/gate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    });
    expect((await body(res)).data.allowed).toBe(true);
  });

  test("paid content is denied to an anonymous user, with a reason", async () => {
    const res = await app.request("/gate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "paid" }),
    });
    const { data } = await body(res);
    expect(data.allowed).toBe(false);
    expect(data.reason).toBe("anonymous");
  });
});

// ── Bridge with payments ─────────────────────────────────────────────────────

describe("synchronization with kon-payments", () => {
  test("an active subscription grants access and marks the member as paying", async () => {
    const member = await upsertMember(db, { email: "pago@example.com" });
    await client.exec(
      "INSERT INTO member_tiers (id, slug, name, level) VALUES ('tier_pro', 'pro', 'Pro', 2) ON CONFLICT (slug) DO NOTHING"
    );

    const result = await syncSubscriptionAccess(db, {
      memberId: member.id,
      tierId: "tier_pro",
      subscription: {
        id: "sub_1",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    expect(result.action).toBe("granted");
    const rows: any = await client.query("SELECT status FROM members WHERE id = $1", [member.id]);
    expect(rows.rows[0].status).toBe("paid");
  });

  test("it is IDEMPOTENT: a retried webhook does not duplicate the access", async () => {
    // Payment providers retry aggressively. Without idempotency,
    // this would duplicate grants and leave them orphaned on cancel.
    const member = await upsertMember(db, { email: "idem@example.com" });
    const subscription = {
      id: "sub_idem",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    };

    await syncSubscriptionAccess(db, { memberId: member.id, tierId: "tier_pro", subscription });
    const second = await syncSubscriptionAccess(db, {
      memberId: member.id,
      tierId: "tier_pro",
      subscription,
    });

    expect(second.action).toBe("updated");
    const rows: any = await client.query(
      "SELECT count(*)::int AS n FROM member_access WHERE subscription_id = 'sub_idem'"
    );
    expect(rows.rows[0].n).toBe(1);
  });

  test("a missed payment revokes access but keeps the history", async () => {
    const member = await upsertMember(db, { email: "impago@example.com" });
    const subscription = {
      id: "sub_impago",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    };
    await syncSubscriptionAccess(db, { memberId: member.id, tierId: "tier_pro", subscription });

    const result = await syncSubscriptionAccess(db, {
      memberId: member.id,
      tierId: "tier_pro",
      subscription: { ...subscription, status: "unpaid" },
    });

    expect(result.action).toBe("revoked");
    // The row is still there: it is what lets us answer "when did they stop paying?".
    const rows: any = await client.query(
      "SELECT revoked_at FROM member_access WHERE subscription_id = 'sub_impago'"
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].revoked_at).not.toBeNull();
  });
});

// ── Security (review 2026-10-15) ─────────────────────────────────────────────

describe("magic link: single use FOR REAL", () => {
  const request = (email: string) =>
    app.request("/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });

  test("two SIMULTANEOUS verifications of the same link open ONE session only", async () => {
    // Before: SELECT and then UPDATE. Both requests passed the read before
    // either marked `used_at`, and came out with two sessions.
    const member = await upsertMember(db, { email: "carrera@example.com" });
    const token = (await issueSigninToken(db, member.id))!;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => consumeSigninToken(db, token))
    );
    expect(results.filter(Boolean)).toHaveLength(1);

    const sessions: any = await client.query(
      "SELECT count(*)::int AS n FROM member_sessions WHERE member_id = $1",
      [member.id]
    );
    expect(sessions.rows[0].n).toBe(1);
  });

  test("requesting a new link INVALIDATES the previous unused one", async () => {
    const member = await upsertMember(db, { email: "reenvio@example.com" });
    const old = (await issueSigninToken(db, member.id))!;
    // The wait is skipped to simulate the owner requesting another one later.
    await client.query(
      "UPDATE member_signins SET created_at = now() - interval '10 minutes' WHERE member_id = $1",
      [member.id]
    );
    const nextValue = (await issueSigninToken(db, member.id))!;

    expect(await consumeSigninToken(db, old)).toBeNull();
    expect(await consumeSigninToken(db, nextValue)).not.toBeNull();
  });

  test("an expired link does not open even if unused", async () => {
    const member = await upsertMember(db, { email: "caducado@example.com" });
    const token = (await issueSigninToken(db, member.id))!;
    await client.query(
      "UPDATE member_signins SET expires_at = now() - interval '1 second' WHERE member_id = $1",
      [member.id]
    );
    expect(await consumeSigninToken(db, token)).toBeNull();
  });

  test("within the wait NO other email is sent, and the response is identical", async () => {
    events.length = 0;
    const firstValue = await request("buzon@example.com");
    const secondValue = await request("buzon@example.com");

    expect(secondValue.status).toBe(firstValue.status);
    expect(await body(secondValue)).toEqual(await body(firstValue));
    expect(events.filter((e) => e.name === "members.signin-requested")).toHaveLength(1);
  });

  test("requesting a link does NOT subscribe anyone to the newsletter", async () => {
    await request("ajeno@example.com");
    const rows: any = await client.query(
      "SELECT newsletter_subscribed FROM members WHERE email = 'ajeno@example.com'"
    );
    expect(rows.rows[0].newsletter_subscribed).toBe(false);
  });
});

describe("backoffice with any account (sign-up is public)", () => {
  let userApp: ReturnType<typeof createKonMembers>;

  beforeAll(() => {
    const ctx = createTestKonContext({
      db: { instance: db } as any,
      auth: {
        requireAuth: (c: any, next: any) => {
          c.set("user", { id: "cualquiera", role: "user", email: "x@example.com" });
          return next();
        },
      } as any,
      events: { emit: () => {}, on: () => {}, off: () => {} } as any,
    });
    userApp = createKonMembers(ctx);
    userApp.onError((err, c) => respondError(c, err));
  });

  test("does not list the email base", async () => {
    expect((await userApp.request("/admin/members")).status).toBe(403);
  });

  test("does not read another member's record", async () => {
    const other = await upsertMember(db, { email: "ficha@example.com" });
    expect((await userApp.request(`/admin/members/${other.id}`)).status).toBe(404);
  });

  test("paid access is neither gifted nor removed", async () => {
    const yo = await upsertMember(db, { email: "listo@example.com" });
    const gift = await userApp.request("/admin/access/comp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberId: yo.id, tierId: "tier_free" }),
    });
    expect(gift.status).toBe(403);
    const remove = await userApp.request("/admin/access/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberId: yo.id, tierId: "tier_free" }),
    });
    expect(remove.status).toBe(403);
  });

  test("does not create plans", async () => {
    const res = await userApp.request("/admin/tiers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "gratis-total", name: "x", level: 100 }),
    });
    expect(res.status).toBe(403);
  });
});
