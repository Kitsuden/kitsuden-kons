# AGENTS.md — kon-payments

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

The billing layer: checkouts, customer portal and cancellation with Stripe, Lemon Squeezy, Paddle
and PayPal, plus signed webhooks normalized into `pay_*` tables and `payment:<type>` events.
Mounted at `/api/payments`. Experimental.

## Calling it

- Read: `payments__list-providers` needs nothing. `payments__get-my-subscription` needs `user:act`,
  `admin`, or any payments scope (`payments:*`, `kon:payments:get-my-subscription`, …).
- Write: `payments__create-checkout`, `payments__open-portal` and `payments__cancel-subscription`
  need an explicit grant: `payments:checkout` / `payments:portal` / `payments:cancel`,
  `payments:*`, `kon:payments:*`, the fine scope `kon:payments:<op>`, or `admin`. A key with only
  `mcp:connect` gets 403.
- Billing belongs to the account that pays. An agent acts under its own identity, which owns no
  customer or subscription, so:
  - `get-my-subscription` returns `{ hasAccess: false, subscriptions: [] }`;
  - `open-portal` and `cancel-subscription` answer 404 (no billing / subscription not found);
  - `create-checkout` opens a checkout whose metadata carries the agent's id, not a person's.
    Do not use it to buy on someone's behalf.
- `cancel-subscription` is sensitive: it may come back `202 KITSUDEN_E_APPROVAL_REQUIRED`. Report
  the proposal to the human and do not retry.
- `cancel-subscription` is idempotent. `create-checkout` and `open-portal` are not; they only create
  a session at the provider, so a retry opens another session.
- 404 means one of: unknown or unconfigured provider, no billing of the caller with that provider,
  or a subscription that is not the caller's (row security hides other accounts' rows).
- 422 means the body has an unknown field, the plan is not in `PAYMENTS_ALLOWED_PLANS`, or a return
  URL is off the allowed origins. 502 means the provider failed or took longer than 15 s.
- Refused on purpose: passing a `customerId` (the server reads it from `pay_customers`); setting
  `userId` and similar keys in `metadata`; amounts in the checkout body (prices live at the
  provider); opening another person's portal or cancelling their subscription, even as admin.
- `receive-webhook` is not a tool: only a provider with the signing secret can call it.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | Kon definition, `buildProviders()` (only configured ones), the kon-conta ledger bridge, `createPaymentsKon`, re-exports. |
| `operations.ts` | `KON_ID`, operation registry, `ANY_ACCOUNT` and `onTheirOwn()` permission helpers. |
| `payments.routes.ts` | The six operations, `returnOrigins()` and `allowedReturnUrl()`, reserved metadata keys, 1 MB webhook limit. |
| `payments.policy.ts` | Policy `payments`: `checkout`, `portal`, `cancel` for the owner only (never role `agent`), `actAsUser`. |
| `payments.service.ts` | `applyPaymentEvent` (idempotent), `statusAfterEvent`, `hasActiveAccess`, `listSubscriptions`, `customerOfUser`. |
| `payments.orders.ts` | `openOrderCheckout` and `orderProviderNames`: one-time charges for other kons. |
| `payments.types.ts` | Provider contract and normalized event types. |
| `payments.schema.ts` | Drizzle tables `pay_customers`, `pay_subscriptions`, `pay_events`. |
| `providers/stripe.ts` | Stripe: checkout, one-time checkout, portal, cancel, webhook verification and mapping. |
| `providers/lemonsqueezy.ts` | Lemon Squeezy: the same, one-time charges through `LEMONSQUEEZY_ORDER_VARIANT_ID`. |
| `providers/paddle.ts` | Paddle: checkout, cancel, webhook. |
| `providers/paypal.ts` | PayPal: checkout, cancel, webhook verification through PayPal's API. |
| `providers/wait.ts` | 15 s timeout signal for provider calls. |
| `migrations/` | `0000_initial.sql`, `0001_english_names.sql`, `history.json`. |
| `kon.json`, `package.json`, `tsconfig.json` | Manifest, package, compiler settings. |

## Rules that must hold

| Rule | Where | Guarded by |
| --- | --- | --- |
| Webhooks are verified over the raw body; the webhook operation declares no `body`. A missing secret rejects everything. | `payments.routes.ts`, `providers/*` | `tests/bun/payments.test.ts` |
| An event is applied once: `pay_events` is unique on (provider, external id), the insert runs in a savepoint and a duplicate returns `applied: false` with 200. | `payments.service.ts` | no dedicated test |
| Negative events never grant access: refunds and cancellations give `canceled`, failures `past_due`, unknown statuses `incomplete`. A refund ends the period now. | `statusAfterEvent` | `tests/unit/payments-do-not-grant-access.test.ts`, `security-payments.test.ts` |
| An event is attributed by metadata `userId` or a linked customer, never by e-mail. | `resolveUserId` | `security-payments.test.ts` |
| The customer id sent to a provider always comes from the caller's `pay_customers` row. | `payments.routes.ts` | `security-payments.test.ts` ("portal: only your own") |
| The server sets `metadata.userId`; reserved keys from the client are refused. | `CheckoutSchema` | `security-payments.test.ts` |
| Return URLs must be on `PAYMENTS_RETURN_ORIGINS`/`ALLOWED_ORIGINS`; with none, none is accepted. | `allowedReturnUrl` | `security-payments.test.ts`, `payments-one-time.test.ts` |
| In production an empty `PAYMENTS_ALLOWED_PLANS` sells nothing. | `allowedPlan` | `security-payments.test.ts` |
| An agent is never the owner of billing (`u.role !== "agent"`). | `payments.policy.ts` | `security-payments.test.ts` ("agents") |
| `cancel_at_period_end` is written only when the event or the cancel operation says it; an event without the flag keeps the stored value. The emitted `payment:<type>` carries the `subscription` state kon-members follows. | `applyPaymentEvent`, `payments.routes.ts` | `tests/unit/kon-payments-cancel-at-period-end.test.ts` |
| A ledger failure never loses a payment; the bridge needs both accounts. | `index.ts`, `applyPaymentEvent` | no dedicated test |
| The webhook answers 500 without internal details when applying fails, so the provider retries. | `payments.routes.ts` | `security-payments.test.ts` |
| kon-conta is imported at runtime through a variable, so this kon compiles without it. | `index.ts` | no dedicated test |

## Changing it

- New migration: the next number in `migrations/` (now `0002_…`). Never edit an applied one;
  `migrations/history.json` keeps accepted older checksums (`previousChecksums`) and would map
  renamed files under `renamed`.
- Row security for the `pay_*` tables lives in the core (`rls-owned-tables.sql`), not here. A new
  table holding a person's rows must be classified there too.
- New file at the kon root or in `providers/`: run `pnpm kon:sync` (updates `package.json` `files`
  and `kon.json`).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- A new provider implements `PaymentProvider` (`payments.types.ts`), returns `null` for a bad
  signature and `undefined` for an event it ignores, uses `providerWait()`, and is added to
  `buildProviders()`.
- kon-ecommerce depends on `openOrderCheckout`, `orderProviderNames` and the
  `payment:payment.succeeded` event; kon-members depends on the `subscription` field of the
  `payment:subscription.*` and `payment:payment.refunded` events. Keep their shapes.
- Operation ids are part of the contract (MCP tool, fine scope, stored agent keys): do not rename.

## Tests

```bash
pnpm vitest run tests/unit/security-payments.test.ts          # routes, policy, service
pnpm vitest run tests/unit/payments-do-not-grant-access.test.ts   # statusAfterEvent, providers
pnpm vitest run tests/unit/payments-one-time.test.ts          # payments.orders.ts, one-time checkouts
pnpm vitest run tests/unit/kon-payments-cancel-at-period-end.test.ts   # cancel_at_period_end, emitted state
pnpm vitest run tests/unit/shop-checkout-delivery.test.ts     # after changing what kon-ecommerce uses
pnpm test:bun                                                 # providers/* signature tests
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-payments"
```
