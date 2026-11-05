/**
 * kon-members — kon-payments subscriptions grant and revoke access
 * ============================================================================
 *
 * `syncSubscriptionAccess` existed, but nothing called it: a reader who paid got no access, and
 * one who cancelled was never `canceled`. Now the kon listens on the core event bus to
 * kon-payments' `payment:<type>` events (no import of that kon) and follows each subscription.
 *
 * Against PGlite with the kon's real migration chain, as the system (the connection kon events
 * are delivered on), and an in-memory event bus shaped like the core's.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { listenToPayments, planTiers } from "../../kons/kon-members/index";

import { migratedBase } from "./helpers/safe-kons-bench";

const chain = readdirSync(resolve(__dirname, "../../kons/kon-members/migrations"))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

let client: PGlite;
const handlers = new Map<string, ((data: unknown) => void)[]>();
const pending: Promise<unknown>[] = [];

/** Emits like kon-payments' webhook and waits for the listeners' background work. */
async function emit(type: string, payload: Record<string, unknown>) {
  for (const h of handlers.get(`payment:${type}`) ?? []) h(payload);
  await Promise.all(pending.splice(0));
}

const subscription = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  planId: "price_pro",
  currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  cancelAtPeriodEnd: false,
  ...over,
});

const state = async () => {
  const m = await client.query<{ status: string }>("SELECT status FROM members WHERE id = 'm-1'");
  const g = await client.query<{ tier_id: string; revoked: boolean; ends_at: string | null }>(
    "SELECT tier_id, revoked_at IS NOT NULL AS revoked, ends_at FROM member_access WHERE member_id = 'm-1' AND source = 'subscription'"
  );
  return { status: m.rows[0]?.status, grants: g.rows };
};

beforeAll(async () => {
  client = await migratedBase("kon-members", chain);
  const ctx = createTestKonContext({
    db: {
      instance: drizzle(client),
      background: <T>(fn: () => T): T => {
        const r = fn();
        pending.push(Promise.resolve(r));
        return r;
      },
    } as any,
    events: {
      emit: () => {},
      on: (name: string, h: (data: unknown) => void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), h]);
      },
      off: () => {},
    } as any,
  });
  listenToPayments(ctx);
  // Once per bus: a second call (a kon reactivated without a restart) adds no listener.
  listenToPayments(ctx);
});
afterAll(async () => client?.close());

beforeEach(async () => {
  process.env.MEMBERS_PLAN_TIERS = "price_pro:pro, price_basic:basic";
  await client.exec(`
    DELETE FROM member_access; DELETE FROM members; DELETE FROM member_tiers WHERE id <> 'tier_free';
    INSERT INTO member_tiers (id, slug, name, level) VALUES ('tier_pro', 'pro', 'Pro', 2), ('tier_basic', 'basic', 'Basic', 1);
    INSERT INTO members (id, email, auth_user_id) VALUES ('m-1', 'reader@example.com', 'u-ana');
    INSERT INTO members (id, email) VALUES ('m-2', 'other@example.com');
  `);
});
afterEach(() => {
  delete process.env.MEMBERS_PLAN_TIERS;
});

describe("wiring", () => {
  test("listens once per bus to every subscription event of kon-payments", () => {
    for (const t of [
      "subscription.created",
      "subscription.updated",
      "subscription.canceled",
      "subscription.payment_succeeded",
      "subscription.payment_failed",
      "payment.failed",
      "payment.refunded",
    ]) {
      expect(handlers.get(`payment:${t}`), t).toHaveLength(1);
    }
  });

  test("MEMBERS_PLAN_TIERS is parsed as planId:tierSlug pairs", () => {
    expect([...planTiers({ MEMBERS_PLAN_TIERS: "a:x, b:y,,bad" })]).toEqual([
      ["a", "x"],
      ["b", "y"],
    ]);
  });
});

describe("a paying account's member", () => {
  test("a new subscription grants the mapped tier and marks the member paid", async () => {
    await emit("subscription.created", { userId: "u-ana", subscription: subscription() });
    const s = await state();
    expect(s.status).toBe("paid");
    expect(s.grants).toHaveLength(1);
    expect(s.grants[0]).toMatchObject({ tier_id: "tier_pro", revoked: false });
  });

  test("a provider retry adds no second grant", async () => {
    await emit("subscription.created", { userId: "u-ana", subscription: subscription() });
    await emit("subscription.payment_succeeded", { userId: "u-ana", subscription: subscription() });
    expect((await state()).grants).toHaveLength(1);
  });

  test("a cancellation keeps access until the period ends and marks the member canceled", async () => {
    await emit("subscription.created", { userId: "u-ana", subscription: subscription() });
    await emit("subscription.canceled", {
      userId: "u-ana",
      subscription: subscription({ status: "canceled", planId: null }),
    });
    const s = await state();
    expect(s.status).toBe("canceled");
    expect(s.grants).toHaveLength(1);
    expect(s.grants[0]).toMatchObject({ tier_id: "tier_pro", revoked: false });
    expect(new Date(s.grants[0].ends_at!).getTime()).toBeGreaterThan(Date.now());
  });

  test("a refund ends access now; a gifted grant keeps the member comped", async () => {
    await client.exec(
      "INSERT INTO member_access (id, member_id, tier_id, source) VALUES ('gift', 'm-1', 'tier_basic', 'comp')"
    );
    await emit("subscription.created", { userId: "u-ana", subscription: subscription() });
    await emit("payment.refunded", {
      userId: "u-ana",
      subscription: subscription({ status: "canceled", currentPeriodEnd: new Date().toISOString() }),
    });
    const s = await state();
    // kon-payments ends the paid period at the refund: the grant ends now (kept as history).
    expect(new Date(s.grants[0].ends_at!).getTime()).toBeLessThanOrEqual(Date.now());
    expect(s.status).toBe("comped");
  });

  test("a lapsed payment revokes access and the member is free again", async () => {
    await emit("subscription.created", { userId: "u-ana", subscription: subscription() });
    await emit("subscription.payment_failed", {
      userId: "u-ana",
      subscription: subscription({ status: "past_due" }),
    });
    const s = await state();
    expect(s.grants[0].revoked).toBe(true);
    expect(s.status).toBe("free");
  });
});

describe("what grants nothing", () => {
  test("a plan outside MEMBERS_PLAN_TIERS (checkout metadata cannot pick a tier)", async () => {
    await emit("subscription.created", {
      userId: "u-ana",
      subscription: subscription({ planId: "price_unknown" }),
      event: { metadata: { tier: "pro" } },
    });
    const s = await state();
    expect(s.grants).toEqual([]);
    expect(s.status).toBe("free");
  });

  test("an account with no linked member, or an event without a subscription", async () => {
    await emit("subscription.created", { userId: "u-nobody", subscription: subscription() });
    await emit("payment.refunded", { userId: "u-ana", subscription: null });
    const all = await client.query("SELECT 1 FROM member_access");
    expect(all.rows).toHaveLength(0);
  });
});
