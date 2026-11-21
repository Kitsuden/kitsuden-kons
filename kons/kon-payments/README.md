# kon-payments

Payments and subscriptions through Stripe, Lemon Squeezy, Paddle and PayPal behind one interface.
For sites that sell plans to signed-in accounts, and for other kons (kon-ecommerce) that need to
charge a one-time amount. Every provider's webhooks are normalized into one event stream, which
can optionally write journal entries into kon-conta.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| experimental | business | 1.3.0 | `/api/payments` | — (optional: kon-conta) |

## Install

```bash
kitsuden kon add payments --enable
```

`kon.json` has `defaultEnabled: false`, so pass `--enable` (or switch it on in the admin panel,
**Kons**). Restart the API afterwards.

A provider is active only when its keys are set (see [Configuration](#configuration)). With none,
the kon starts, logs a warning and `GET /api/payments/providers` returns an empty list. In
production you must also set `PAYMENTS_ALLOWED_PLANS` and a return origin
(`PAYMENTS_RETURN_ORIGINS` or `ALLOWED_ORIGINS`), or no checkout can start.

At each provider, point the webhook to `https://<api host>/api/payments/webhook/<provider>`, where
`<provider>` is `stripe`, `lemonsqueezy`, `paddle` or `paypal`.

## What it adds

- **Providers** (`providers/`): one adapter per gateway. Each verifies webhook signatures over the
  raw body and maps the gateway's events to normalized types: `payment.succeeded`,
  `payment.failed`, `payment.refunded`, `subscription.created`, `subscription.updated`,
  `subscription.canceled`, `subscription.payment_succeeded`, `subscription.payment_failed`.
  Amounts are integers in cents.
- **Subscription status** is derived from the event (`statusAfterEvent`): refunds and
  cancellations give `canceled`, failed payments give `past_due`, an unknown status gives
  `incomplete`, never `active`. A refund also ends the paid period at once.
- **Paid access** (`hasActiveAccess`): an `active` or `trialing` subscription, or a `canceled` one
  whose paid period has not ended.
- **One-time payments for other kons**: `openOrderCheckout` and `orderProviderNames`
  (`payments.orders.ts`), loaded at runtime by kon-ecommerce. Only Stripe and Lemon Squeezy
  implement them.
- **Ledger bridge**: with `PAYMENTS_LEDGER=true` and both ledger accounts set, each event with an
  amount (except `payment.failed`) creates a journal entry in kon-conta; a refund reverses debit
  and credit. If kon-conta is missing or fails, the payment is still recorded.

Tables (from `kon.json`, created by `migrations/0000_initial.sql`):

| Table | What it holds |
| --- | --- |
| `pay_customers` | Link between an account (`user_id`) and its customer id at a provider. One per account and provider. |
| `pay_subscriptions` | Subscriptions per account: provider, external id, plan, status, period end, metadata. Unique by provider and external id. |
| `pay_events` | Log of every applied webhook event with its payload, amount and journal id. Unique by provider and external id: a retried webhook is not applied twice. |
| `pay_checkouts` | Each one-time payment opened through `POST /api/payments/orders/checkout`: a 15-character reference, provider, amount in cents, currency, metadata and return URLs. Providers that report only an order number (Tilopay, Yappy) are matched here. Written and read by the system only. |

## HTTP API

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/payments/providers` | Anyone | Configured providers, and whether each supports the customer portal and cancelling. Whole (declared `unpaginated`: four providers at most). |
| `POST /api/payments/checkout` | The paying account | Body `{ provider, planId, successUrl, cancelUrl?, quantity?, metadata? }`. Opens a checkout for a plan in `PAYMENTS_ALLOWED_PLANS` and returns `{ url, … }`. The server adds the caller's `userId` to the metadata; client metadata may not use `userId`, `user_id`, `uid`, `owner_id` or `ownerId`. |
| `POST /api/payments/webhook/:provider` | The provider (signed) | Verifies the signature (400 if invalid), applies the event once, emits `payment:<type>`. 404 for an unknown provider, 413 above 1 MB, 500 if applying fails so the provider retries, `{ ignored: true }` for events the kon does not handle. |
| `POST /api/payments/orders/checkout` | The shop's backend (a key that opens kon-payments) or the team | Body `{ provider, lines: [{ name, unitAmount (cents), quantity }], currency, successUrl, cancelUrl?, customerEmail?, customerPhone?, billing?, metadata?, expiresInMinutes? }`. Opens a one-time payment for an amount another system computed and keeps it in `pay_checkouts`. Answers `{ reference, provider, url, id }`, plus `button: { script, params }` for Yappy, whose payment happens in a component on the site's page. Tilopay needs `billing`. The metadata comes back on `payment:payment.succeeded`; the caller checks the amount again there. |
| `GET /api/payments/return/:provider` | The buyer's browser, or the provider | Tilopay sends the buyer back here (`TILOPAY_RETURN_URL`) and Yappy notifies here (`YAPPY_IPN_URL`). Tilopay's result is confirmed by asking Tilopay (`/consult`), never taken from the query; Yappy's is checked by its HMAC. Both are matched to `pay_checkouts` for the amount and metadata, applied once, and announced as `payment:<type>`. A browser is redirected to the order's return URL; a notification gets JSON. 400 when the result cannot be verified. |
| `GET /api/payments/subscription` | Any signed-in account | `{ hasAccess, subscriptions }` for the caller only. |
| `POST /api/payments/portal` | The account that pays | Body `{ provider, returnUrl? }`. Opens the provider's customer portal for the caller's own billing (Stripe, Lemon Squeezy). No customer id is accepted from the client. 404 if the caller has no billing there. |
| `POST /api/payments/cancel` | The account that pays | Body `{ provider, subscriptionId, immediately? }`. Cancels one of the caller's subscriptions with that provider, at period end unless `immediately`. 404 if it is not the caller's. |

Bodies of checkout, portal and cancel are strict: unknown fields give 422. Return URLs (`successUrl`,
`cancelUrl`, `returnUrl`) must be on an allowed origin (422 otherwise). A provider that does not
answer gives 502; calls to providers time out after 15 seconds.

## Who can do what

The policy file is `payments.policy.ts` (resource `payments`).

| Role | Can |
| --- | --- |
| Anonymous | List providers. The webhook route is public; its signature is the authentication. |
| Signed-in account | Read its own subscriptions; open its own checkout, portal and cancellation. |
| Editor, admin | The same as any account, for their own billing only. No role manages another person's billing here; that is done in the provider's dashboard. |
| Agent | `get-my-subscription` with `user:act`, `admin` or a payments scope. Checkout, portal and cancel need an explicit grant (`payments:checkout`, `payments:portal`, `payments:cancel`, `payments:*`, `kon:payments:<op>` or `admin`); a key with only `mcp:connect` is refused. |

Row security on `pay_customers`, `pay_subscriptions` and `pay_events` is applied by the host
(`rls-owned-tables.sql` in the core): each account sees only rows whose `user_id` is its own; the
system and admins see all. Another account's subscription or portal answers 404, not 403. An
agent acts under its own identity, so it has no subscriptions of its own and `portal` and `cancel`
answer 404 for it.

## Configuration

On a Kitsuden with connections (`ctx.connections`), an admin can store the API key of Stripe, Lemon Squeezy or Paddle there
instead of the environment (Kitsuden's connections API (`/api/connections/api-keys`), provider `stripe`, `lemonsqueezy` or
`paddle`, scope `organization`). The key is sealed by the host and never reaches this kon: requests go
through the connection's client, only to the provider's API host. A key in the environment wins. Webhook
signing secrets stay in the environment.

Providers (a provider is active when the first variable(s) listed are set):

| Provider | Variables |
| --- | --- |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Lemon Squeezy | `LEMONSQUEEZY_API_KEY` and `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_ORDER_VARIANT_ID` (the variant used to charge shop orders) |
| Paddle | `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENV` (`sandbox` for the sandbox API) |
| PayPal | `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV` (`live` for the live API; sandbox otherwise) |
| Tilopay (one-time payments only) | `TILOPAY_API_USER`, `TILOPAY_API_PASSWORD`, `TILOPAY_API_KEY` (from Tilopay's panel), `TILOPAY_RETURN_URL` (this API's public `/api/payments/return/tilopay`). Test or live is a setting of the Tilopay account, not of this kon. |
| Yappy (one-time payments only, button) | `YAPPY_MERCHANT_ID`, `YAPPY_SECRET_KEY` (from Yappy Comercial), `YAPPY_DOMAIN` (the site URL configured for the button), `YAPPY_IPN_URL` (this API's public `/api/payments/return/yappy`), `YAPPY_ENV` (`test` or production), `YAPPY_TEST_ALIAS` (test only: the phone in Yappy's test program). USD only. |

Without its webhook secret (PayPal: webhook id) a provider rejects every webhook.

Other variables:

| Variable | Effect |
| --- | --- |
| `PAYMENTS_ALLOWED_PLANS` | Comma-separated plan ids that may be bought. When empty, every plan is accepted outside production and none in production. |
| `PAYMENTS_RETURN_ORIGINS` | Comma-separated origins allowed for return URLs, together with `ALLOWED_ORIGINS`. With neither, no return URL is accepted. Read on each request. |
| `PAYMENTS_LEDGER` | `true` turns on the kon-conta bridge. A payment whose metadata carries `odooOrderId` (a kon-odoo order) or `booksKeptBy` is never posted: another system keeps its books, and posting it here too would count it twice. |
| `PAYMENTS_LEDGER_DEBIT_ACCOUNT`, `PAYMENTS_LEDGER_CREDIT_ACCOUNT` | kon-conta account ids for the bank/gateway and the income side. Both are needed, or the bridge logs a warning and writes nothing. |
| `NODE_ENV` | `production` makes an empty `PAYMENTS_ALLOWED_PLANS` refuse every plan. |

Event: after an event is applied, the kon emits `payment:<type>` (for example
`payment:payment.succeeded`) with `{ provider, userId, subscriptionId, subscription, event }`.
`userId` is taken from the checkout metadata or from an already linked customer, never from the
payer's e-mail; when neither exists it is `null` and the event is kept in `pay_events` for manual
reconciliation. `subscription` is the subscription's state after the event
(`{ id, status, planId, currentPeriodEnd, cancelAtPeriodEnd }`), or `null` when the event touched
no subscription with a known owner. kon-members follows it to grant and revoke paid access.

`cancelAtPeriodEnd` (column `cancel_at_period_end`) is set when the caller cancels at period end
through `POST /api/payments/cancel`, and from the provider's subscription webhooks (Stripe
`cancel_at_period_end`, Paddle's scheduled cancel, Lemon Squeezy `cancelled`). PayPal cancels at
once and does not send it.

## Agents and MCP

| Operation | Route | MCP tool | Writes |
| --- | --- | --- | --- |
| `list-providers` | `GET /api/payments/providers` | `payments__list-providers` | no |
| `create-checkout` | `POST /api/payments/checkout` | `payments__create-checkout` | yes (at the provider) |
| `open-order-checkout` | `POST /api/payments/orders/checkout` | `payments__open-order-checkout` | yes (at the provider) |
| `get-my-subscription` | `GET /api/payments/subscription` | `payments__get-my-subscription` | no |
| `open-portal` | `POST /api/payments/portal` | `payments__open-portal` | yes (at the provider) |
| `cancel-subscription` | `POST /api/payments/cancel` | `payments__cancel-subscription` | yes, sensitive |

`receive-webhook` is not an MCP tool. Fine scopes are `kon:payments:<op>`. `cancel-subscription`
is marked sensitive: with human approval on, an agent's call returns
`202 KITSUDEN_E_APPROVAL_REQUIRED`. Details for agents: [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/security-payments.test.ts` | Ownership of portal, checkout, cancel and subscription; return URLs; allowed plans; agents; negative webhook events; 1 MB limit. |
| `tests/unit/payments-do-not-grant-access.test.ts` | `statusAfterEvent`; Lemon Squeezy and Stripe events that must not grant access. |
| `tests/unit/payments-one-time.test.ts` | One-time charges (Stripe, Lemon Squeezy) and `openOrderCheckout`. |
| `tests/unit/payments-tilopay-yappy.test.ts` | Tilopay and Yappy against doubles of their APIs: `POST /orders/checkout`, a typed `code=1` refused until Tilopay confirms, Yappy's HMAC, forged and repeated notifications, button providers kept from callers that redirect. |
| `tests/bun/payments.test.ts` | Signature verification and normalization for the four providers; `buildProviders`. |
| `tests/unit/kon-payments-cancel-at-period-end.test.ts` | `cancel_at_period_end` from the cancel operation and from webhooks; the `subscription` state in the emitted event. |
| `tests/unit/shop-checkout-delivery.test.ts` | kon-ecommerce charging orders through this kon and listening to its events. |

The duplicate-event path of `applyPaymentEvent` and the kon-conta ledger bridge have no dedicated test.

```bash
pnpm vitest run tests/unit/security-payments.test.ts
pnpm vitest run tests/unit/payments-do-not-grant-access.test.ts
pnpm vitest run tests/unit/payments-one-time.test.ts
pnpm test:bun    # runs tests/bun, including payments.test.ts
```

## License

MIT
