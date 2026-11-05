import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import type { Hono } from "hono";

import { registerMembersMails } from "./members.mails.js";
import { registerMembersPolicy } from "./members.policy.js";
import { createMembersRouter, membersOperations } from "./members.routes.js";
import { syncPaymentSubscription, type PaymentSubscriptionEvent } from "./members.service.js";
import { KON_ID } from "./operations.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./members.schema.js";
export * from "./members.access.js";
export * from "./members.service.js";
export * from "./members.mails.js";
export { registerMembersPolicy };

/**
 * Members — the paid memberships layer.
 *
 * What Ghost has and a blog CMS does not: tiers, members (distinct from CMS
 * users) and content access control.
 *
 * Deliberately GENERIC: it does not know what a "post" is. Content declares
 * what it requires (`visibility`) and `members.access.ts` decides. That way
 * the blog, an academy or a downloads kon use it equally.
 */
export function createKonMembers(ctx: KonContext): Hono {
  return createMembersRouter(ctx);
}

/** kon-payments events that can change a subscription's state. */
export const PAYMENT_SUBSCRIPTION_EVENTS = [
  "payment:subscription.created",
  "payment:subscription.updated",
  "payment:subscription.canceled",
  "payment:subscription.payment_succeeded",
  "payment:subscription.payment_failed",
  "payment:payment.failed",
  "payment:payment.refunded",
] as const;

/** Once per event bus: a kon reactivated without a restart runs `onStartup` again. */
const listening = new WeakSet<object>();

/**
 * Follows kon-payments (an optional kon) through the core event bus: each subscription event
 * becomes a grant, an update or a revocation in `member_access` (`syncPaymentSubscription`).
 * Nothing is imported from kon-payments; without it installed no event arrives.
 *
 * Outside any request, with the system connection: the webhook's transaction is already committed
 * when kon events are delivered. A failure is logged and never reaches the payment.
 */
export function listenToPayments(ctx: KonContext): void {
  if (listening.has(ctx.events)) return;
  listening.add(ctx.events);
  const handle = (data: unknown): void => {
    const payload = (data ?? {}) as PaymentSubscriptionEvent;
    if (!payload.subscription || !payload.userId) return;
    const run = async () => {
      try {
        const result = await syncPaymentSubscription(ctx.db.instance, payload);
        if ("skipped" in result && result.skipped !== "no-subscription") {
          ctx.logger.warn("[members] a subscription event did not change any access", {
            subscriptionId: payload.subscription?.id,
            reason: result.skipped,
          });
        }
      } catch (err) {
        ctx.logger.error("[members] could not sync a subscription", {
          subscriptionId: payload.subscription?.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    void (ctx.db.background ? ctx.db.background(run) : run());
  };
  for (const name of PAYMENT_SUBSCRIPTION_EVENTS) ctx.events.on(name, handle);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`membersOperations`), with its OpenAPI, its MCP tool and its fine-grained scope.
 */
export const kon = defineKonSdk({
  id: KON_ID,
  name: "Members",
  version: manifest.version,
  description: "Paid memberships: tiers, members and content access control",
  icon: "Users",
  mountPath: "/api/members",
  operations: (ctx: KonContext) => membersOperations(ctx),

  tables: konTables,

  admin: {
    category: "content",
    views: [
      { id: "grid", type: "grid", title: "Members", table: "members" },
      { id: "tiers", type: "grid", title: "Plans", table: "member_tiers" },
    ],
  },

  dependencies: {
    kons: [],
    core: ["auth"],
  },

  hooks: {
    onStartup: async (ctx) => {
      // The policy registry is a process singleton: re-registering here
      // avoids depending on the import effect surviving a resetAuthz().
      registerMembersPolicy();
      registerMembersMails();
      listenToPayments(ctx);
      ctx.logger.info("👥 Members kon initialized");
    },
  },
});

export default kon;
