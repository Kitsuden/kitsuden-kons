/**
 * Kitsuden Payments — Routes
 * ============================================================================
 *
 *   POST /api/payments/checkout          → creates payment session (auth)
 *   POST /api/payments/webhook/:provider → receives events (public, SIGNED)
 *   GET  /api/payments/subscription      → user status (auth)
 *   POST /api/payments/portal            → customer portal (auth, ONLY their own)
 *   POST /api/payments/cancel            → cancel subscription (auth, ONLY their own)
 *   GET  /api/payments/providers         → configured providers
 *
 * CRITICAL DETAIL: webhooks need the RAW BODY, unparsed. Signatures
 * are computed over the exact bytes the provider sent; if Hono
 * parses the JSON and it is re-serialized, the key order or spacing
 * changes and the signature NEVER validates. That is why `c.req.text()` is used, and why the
 * webhook operation does NOT declare `body`: the SDK neither reads nor validates it, and
 * the bytes reach verification intact.
 *
 * ── AUTHORIZATION (an earlier audit) ────────────────────────────────────────
 * Before, `POST /portal` opened the billing portal of whatever `customerId` the
 * client sent: any account could see invoices, change the card or
 * cancel someone else's subscription just by knowing (or enumerating) their id. Now
 * the customer id at the provider ALWAYS comes from the session user's `pay_customers`,
 * and the return URLs can only go to own
 * origins (otherwise, checkout is an open redirector bearing the payment
 * provider's brand). Everything goes through `can()` with the "payments" policy.
 */

import { operationsRouter, type AuthzUser, type AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { ANY_ACCOUNT, KON_ID, registry, onTheirOwn } from "./operations";

import "./payments.policy";
import {
  applyPaymentEvent,
  customerOfUser,
  hasActiveAccess,
  listSubscriptions,
} from "./payments.service";
import { paySubscriptions } from "./payments.schema";
import type { PaymentEvent, PaymentProvider } from "./payments.types";

/** A real webhook weighs a few KB. More than 1 MB is something else. */
const MAX_WEBHOOK_BYTES = 1_000_000;

/** Metadata keys the client CANNOT set: the server sets them. */
const RESERVED_METADATA = new Set(["userid", "user_id", "uid", "owner_id", "ownerid"]);

const CheckoutSchema = z
  .object({
    provider: z.string().min(1).max(32),
    planId: z.string().min(1).max(128),
    successUrl: z.string().url().max(2000),
    cancelUrl: z.string().url().max(2000).optional(),
    quantity: z.number().int().positive().max(100).optional(),
    metadata: z
      .record(z.string().regex(/^[A-Za-z0-9_]{1,40}$/), z.string().max(200))
      .refine((m) => Object.keys(m).length <= 10, "At most 10 keys")
      .refine(
        (m) => Object.keys(m).every((k) => !RESERVED_METADATA.has(k.toLowerCase())),
        "That metadata key is set by the server"
      )
      .optional(),
  })
  .strict();

const PortalSchema = z
  .object({
    provider: z.string().min(1).max(32),
    returnUrl: z.string().url().max(2000).optional(),
  })
  .strict();

const CancelSchema = z
  .object({
    provider: z.string().min(1).max(32),
    subscriptionId: z.string().min(1).max(128),
    immediately: z.boolean().optional(),
  })
  .strict();

/**
 * Origins that can be returned to after paying. They are read per request
 * (hot Secrets): `PAYMENTS_RETURN_ORIGINS`, and otherwise `ALLOWED_ORIGINS`
 * (the API's same CORS). With none configured no URL is accepted:
 * better a checkout that does not start than an open redirector.
 */
export function returnOrigins(env = process.env): Set<string> {
  const rawValue = [env.PAYMENTS_RETURN_ORIGINS, env.ALLOWED_ORIGINS].filter(Boolean).join(",");
  const out = new Set<string>();
  for (const part of rawValue.split(",")) {
    try {
      const u = new URL(part.trim());
      if (u.protocol === "https:" || u.protocol === "http:") out.add(u.origin);
    } catch {
      /* malformed input: ignored */
    }
  }
  return out;
}

export function allowedReturnUrl(url: string, env = process.env): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    return returnOrigins(env).has(u.origin);
  } catch {
    return false;
  }
}

function invalid(c: { json: (b: unknown, s: 422) => Response }, error: z.ZodError) {
  return c.json(
    {
      error: {
        code: "VALIDATION",
        message: "Invalid data",
        details: error.issues.map((i) => ({ field: i.path.join("."), problem: i.message })),
      },
    },
    422
  );
}

// ── Outputs (OpenAPI and MCP) ────────────────────────────────────────────────

/** What a provider returns when opening a checkout or a portal: the URL, and the rest as is. */
const ProviderSession = z.object({ url: z.string() }).passthrough();
const ProviderParam = z.object({
  provider: z.string().describe("Provider name: stripe | lemonsqueezy | paddle | paypal"),
});

/** The bridge to the ledger (kon-conta), optional: the usual one. */
type Ledger = (event: PaymentEvent, userId: string | null) => Promise<string | undefined>;

export function createPaymentsRouter(
  ctx: KonContext,
  providers: Map<string, PaymentProvider>,
  onLedger?: Ledger
): Hono {
  return operationsRouter(KON_ID, paymentsOperations(ctx, providers, onLedger), ctx);
}

export function paymentsOperations(
  ctx: KonContext,
  providers: Map<string, PaymentProvider>,
  onLedger?: Ledger
): AnyOperation[] {
  const app = registry();
  // `db` is the request's RLS transaction: inside a route with a session,
  // the database already returns only the `pay_*` rows of whoever asks (isolated by
  // user_id in rls-owned-tables.sql), without depending on the WHERE. That is what
  // `asUser()` used to do by hand, and now the host does it.
  const db = ctx.db.instance;
  const asSystem = ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());

  const userOf = (c: unknown): AuthzUser | null =>
    ((c as { get(k: string): unknown }).get("user") ?? null) as AuthzUser | null;

  const ENV_VARS = "NODE_ENV";

  /**
   * List of plans that can be purchased (`PAYMENTS_ALLOWED_PLANS`, ids
   * separated by commas). In production, with no list nothing is sold: before,
   * any price in the merchant account (one of €0, another
   * product's) gave the same access (an earlier audit).
   */
  const allowedPlan = (planId: string): boolean => {
    const list = (process.env.PAYMENTS_ALLOWED_PLANS ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    // Key in a variable: `bun build` freezes `process.env.NODE_ENV` literally at
    // compile time (see apps/api/src/lib/entorno.ts).
    if (list.length === 0) return process.env[ENV_VARS] !== "production";
    return list.includes(planId);
  };

  // ── Available providers ───────────────────────────────────────────────────
  app.get(
    "/providers",
    {
      id: "list-providers",
      summary: "List the configured payment providers",
      description:
        "The payment providers configured on this site (stripe, lemonsqueezy, paddle, paypal) and whether each supports the customer portal and cancelling. Public.",
      access: "public",
      output: {
        schema: z.object({
          providers: z.array(
            z.object({ name: z.string(), supportsPortal: z.boolean(), supportsCancel: z.boolean() })
          ),
        }),
      },
    },
    (c) =>
      c.json({
        providers: Array.from(providers.values())
          .filter((p) => p.isConfigured())
          .map((p) => ({
            name: p.name,
            supportsPortal: typeof p.createPortalSession === "function",
            supportsCancel: typeof p.cancelSubscription === "function",
          })),
      })
  );

  // ── Checkout ──────────────────────────────────────────────────────────────
  app.post(
    "/checkout",
    {
      id: "create-checkout",
      summary: "Open a payment checkout",
      description:
        "Creates a checkout session with the provider for a plan of PAYMENTS_ALLOWED_PLANS and returns its URL. The account is the caller's (its userId goes in the metadata, set by the server); return URLs must be on the site's own origins. Only the person paying; an agent needs payments:checkout. Calls the payment provider (502 if it does not answer).",
      access: "session",
      permission: onTheirOwn("checkout"),
      // The body is validated by the handler: its 422 (`error.code: VALIDATION`) is the
      // usual one, and comes AFTER the policy.
      input: { body: CheckoutSchema, validatesHandler: true },
      output: { schema: ProviderSession },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_GATEWAY"],
    },
    async (c, _input, h) => {
      const user = userOf(c);
      if (!user?.id)
        return c.json({ error: { code: "UNAUTHENTICATED", message: "No session" } }, 401);
      if (!(await h.can({ userId: user.id }))) {
        return c.json({ error: { code: "FORBIDDEN", message: "Not authorized" } }, 403);
      }

      const parsed = CheckoutSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return invalid(c, parsed.error);
      const data = parsed.data;

      const provider = providers.get(data.provider);
      if (!provider || !provider.isConfigured()) {
        return c.json(
          { error: { code: "NOT_FOUND", message: `Provider "${data.provider}" not configured` } },
          404
        );
      }
      if (!allowedPlan(data.planId)) {
        return c.json({ error: { code: "VALIDATION", message: "Plan not available" } }, 422);
      }
      for (const url of [data.successUrl, data.cancelUrl].filter(Boolean) as string[]) {
        if (!allowedReturnUrl(url)) {
          return c.json(
            { error: { code: "VALIDATION", message: "Return URL not allowed" } },
            422
          );
        }
      }

      try {
        // If the user is already a customer of that provider, THEIR id is reused: the
        // one in the body does not exist (`.strict()` rejects it).
        const ownValue = await customerOfUser(db, user.id, provider.name);
        const session = await provider.createCheckout({
          planId: data.planId,
          successUrl: data.successUrl,
          cancelUrl: data.cancelUrl,
          quantity: data.quantity,
          ...(ownValue ? { customerId: ownValue } : {}),
          // The userId ALWAYS travels in the metadata and is set by the server: it is
          // how the payment is matched with the account without depending on the email.
          metadata: { ...(data.metadata ?? {}), userId: user.id },
        });
        return c.json(session);
      } catch (err) {
        ctx.logger.error("Failed to create checkout", {
          provider: provider.name,
          message: err instanceof Error ? err.message : String(err),
        });
        return c.json(
          { error: { code: "PROVIDER_ERROR", message: "The payment provider did not respond" } },
          502
        );
      }
    }
  );

  // ── Webhook ───────────────────────────────────────────────────────────────
  // Public on purpose: the provider cannot authenticate. The SIGNATURE is the
  // authentication, and that is why verifying it is not optional.
  app.post(
    "/webhook/:provider",
    {
      id: "receive-webhook",
      summary: "Receive a payment provider webhook",
      description:
        "Endpoint for the payment provider: verifies the signature over the raw body (400 if invalid), normalizes the event and applies it idempotently (subscriptions, ledger). 404 for an unknown provider, 413 above 1 MB, 500 on purpose when applying fails (the provider retries). Public: the signature is the authentication.",
      access: "public",
      // WITHOUT `body`: the signature is computed over the exact bytes the
      // provider sent, and the SDK must not read or re-serialize them beforehand.
      input: { params: ProviderParam },
      output: {
        schema: z.union([
          z.object({ received: z.literal(true), applied: z.boolean() }),
          z.object({ ignored: z.literal(true) }),
        ]),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_PAYLOAD_TOO_LARGE"],
      mcp: { exclude: "Called by the payment provider with a signed raw body, never by an agent" },
    },
    async (c) => {
      const provider = providers.get(c.req.param("provider"));
      if (!provider) return c.json({ error: "Unknown provider" }, 404);

      const declaredOne = Number(c.req.header("content-length") ?? "0");
      if (declaredOne > MAX_WEBHOOK_BYTES) return c.json({ error: "Payload too large" }, 413);

      // RAW body — see header note.
      const rawBody = await c.req.text();
      if (rawBody.length > MAX_WEBHOOK_BYTES) {
        return c.json({ error: "Payload too large" }, 413);
      }
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => (headers[k] = v));

      let event: PaymentEvent | null | undefined;
      try {
        event = await provider.parseWebhook(rawBody, headers);
      } catch (err) {
        ctx.logger.error("Could not parse the webhook", {
          provider: provider.name,
          message: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: "Invalid payload" }, 400);
      }

      // null = invalid signature. It is logged: a spike here is a fraud attempt.
      if (event === null) {
        ctx.logger.warn("Webhook with invalid signature REJECTED", { provider: provider.name });
        return c.json({ error: "Invalid signature" }, 400);
      }

      // undefined = valid signature but an event we are not interested in. 200 so that
      // the provider does not retry forever.
      if (event === undefined) return c.json({ ignored: true });

      try {
        // As the system: the webhook carries no account (it is authenticated by the SIGNATURE, already
        // verified above) and writes rows of the person who paid.
        const result = await asSystem(() => applyPaymentEvent(db, event, onLedger));

        if (result.applied) {
          // Internal event: any kon can react to a payment. `subscription` is the state
          // after the event (status, plan, paid period, cancel at period end), so a kon that
          // follows subscriptions (kon-members) need not read `pay_*` or repeat the rules.
          ctx.events.emit(`payment:${event.type}`, {
            provider: event.provider,
            userId: result.userId ?? null,
            subscriptionId: result.subscriptionId,
            subscription: result.subscription ?? null,
            event,
          });
        }

        return c.json({ received: true, applied: result.applied });
      } catch (err) {
        ctx.logger.error("Failed to apply payment event", {
          provider: provider.name,
          message: err instanceof Error ? err.message : String(err),
        });
        // 500 on purpose: the provider will retry, and idempotence makes
        // retrying safe. The detail (SQL, tables) stays in the log.
        return c.json({ error: "Could not process the event" }, 500);
      }
    }
  );

  // ── User status ───────────────────────────────────────────────────────────
  app.get(
    "/subscription",
    {
      id: "get-my-subscription",
      summary: "Read my subscription status",
      description:
        "Whether the caller has active paid access, and their subscriptions (provider, external id, plan, status, period end, cancel at period end). Only the caller's own rows. Any signed-in account; an agent needs user:act or a payments scope.",
      access: "session",
      permission: ANY_ACCOUNT,
      output: {
        schema: z.object({
          hasAccess: z.boolean(),
          subscriptions: z.array(z.object({ id: z.unknown() }).passthrough()),
        }),
      },
    },
    async (c) => {
      const user = userOf(c);
      if (!user?.id) return c.json({ error: "Not authenticated" }, 401);
      const userId = user.id;

      // In the request's RLS transaction: even if a query got the
      // filter wrong, the database (pay_subscriptions isolated by user_id) returns only
      // what is theirs. In series: it is a single connection.
      const active = await hasActiveAccess(db, userId);
      const subscriptions = await listSubscriptions(db, userId);

      return c.json({
        hasAccess: active,
        subscriptions: subscriptions.map((s: Record<string, unknown>) => ({
          id: s.id,
          provider: s.provider,
          externalId: s.externalId,
          planId: s.planId,
          status: s.status,
          currentPeriodEnd: s.currentPeriodEnd,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        })),
      });
    }
  );

  // ── Customer portal ───────────────────────────────────────────────────────
  app.post(
    "/portal",
    {
      id: "open-portal",
      summary: "Open my billing portal",
      description:
        "Opens the provider's customer portal (invoices, card, cancel) for the CALLER's own billing with that provider, read from the database (no customer id is accepted). 404 if the caller has no billing there; the return URL must be on the site's own origins. Calls the payment provider (502 if it does not answer).",
      access: "session",
      permission: onTheirOwn("portal"),
      // The body is validated by the handler: its 422 is the usual one.
      input: { body: PortalSchema, validatesHandler: true },
      output: { schema: ProviderSession },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_GATEWAY"],
    },
    async (c, _input, h) => {
      const user = userOf(c);
      if (!user?.id) return c.json({ error: "Not authenticated" }, 401);
      const userId = user.id;

      const parsed = PortalSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return invalid(c, parsed.error);

      const provider = providers.get(parsed.data.provider);
      if (!provider?.createPortalSession) {
        return c.json({ error: { code: "UNSUPPORTED", message: "Portal not supported" } }, 400);
      }
      const returnUrl = parsed.data.returnUrl;
      if (returnUrl && !allowedReturnUrl(returnUrl)) {
        return c.json(
          { error: { code: "VALIDATION", message: "Return URL not allowed" } },
          422
        );
      }

      // The id sent to the provider is THE USER'S, read from the database.
      // Lemon Squeezy opens the portal from a subscription, not from the customer.
      const target = await (async () => {
        if (provider.name === "lemonsqueezy") {
          const subs = await listSubscriptions(db, userId);
          const ofThat = subs.filter((s: { provider: string }) => s.provider === provider.name);
          return (
            (ofThat[ofThat.length - 1] as { externalId?: string } | undefined)?.externalId ?? null
          );
        }
        return customerOfUser(db, userId, provider.name);
      })();

      if (!target || !(await h.can({ userId }))) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "You have no billing with that provider" } },
          404
        );
      }

      try {
        const session = await provider.createPortalSession(
          target,
          returnUrl ?? [...returnOrigins()][0] ?? "/"
        );
        return c.json(session);
      } catch (err) {
        ctx.logger.error("Failed to open the portal", {
          provider: provider.name,
          message: err instanceof Error ? err.message : String(err),
        });
        return c.json(
          { error: { code: "PROVIDER_ERROR", message: "The payment provider did not respond" } },
          502
        );
      }
    }
  );

  // ── Cancel ────────────────────────────────────────────────────────────────
  app.post(
    "/cancel",
    {
      id: "cancel-subscription",
      summary: "Cancel my subscription",
      description:
        "Cancels one of the CALLER's own subscriptions with that provider, at period end or `immediately`. 404 if the subscription is not the caller's or is from another provider. Calls the payment provider (502 if it does not answer).",
      access: "session",
      permission: onTheirOwn("cancel"),
      // Cancelling a person's charge: have a human confirm it.
      sensitive: true,
      idempotent: true,
      // The body is validated by the handler: its 422 is the usual one.
      input: { body: CancelSchema, validatesHandler: true },
      output: { schema: z.object({ canceled: z.literal(true) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_GATEWAY"],
    },
    async (c, _input, h) => {
      const user = userOf(c);
      if (!user?.id) return c.json({ error: "Not authenticated" }, 401);
      const userId = user.id;

      const parsed = CancelSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return invalid(c, parsed.error);
      const body = parsed.data;

      const provider = providers.get(body.provider);
      if (!provider?.cancelSubscription) {
        return c.json({ error: { code: "UNSUPPORTED", message: "Cancellation not supported" } }, 400);
      }

      const subs = await listSubscriptions(db, userId);
      // Only your own is cancelled, and from the SAME provider.
      const theirs = subs.find(
        (s: { id: string; externalId: string; provider: string; userId: string }) =>
          s.externalId === body.subscriptionId && s.provider === provider.name
      );
      if (!theirs || !(await h.can(theirs))) {
        return c.json({ error: { code: "NOT_FOUND", message: "Subscription not found" } }, 404);
      }

      try {
        await provider.cancelSubscription(theirs.externalId, body.immediately === true);
        // At period end the subscription stays active until what was paid runs out: record that
        // it will not renew. An immediate cancellation is recorded by the provider's webhook.
        if (body.immediately !== true) {
          await db
            .update(paySubscriptions)
            .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
            .where(eq(paySubscriptions.id, theirs.id));
        }
        return c.json({ canceled: true });
      } catch (err) {
        ctx.logger.error("Failed to cancel", {
          provider: provider.name,
          message: err instanceof Error ? err.message : String(err),
        });
        return c.json(
          { error: { code: "PROVIDER_ERROR", message: "The payment provider did not respond" } },
          502
        );
      }
    }
  );

  return app.ops;
}
