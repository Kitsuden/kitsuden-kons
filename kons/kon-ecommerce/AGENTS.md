# AGENTS.md — kon-ecommerce

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A small shop (kon id `kon-ecommerce`, mounted at `/api/shop`, MCP prefix `ecommerce__`): catalog
and variants, orders by e-mail without customer accounts, atomic stock, payment through
kon-payments, delivery of files and license keys, discount codes and order e-mails.

## Calling it

- Staff scopes for an agent key: `ecommerce:*`, `kon:ecommerce:*` or `admin` (staff in the app
  and in row security). Example: `["mcp:connect", "ecommerce:*"]`.
- Narrower: read orders with `shop-order:view`; change status and deliver with
  `shop-order:update` (or `shop-order:*`); catalog with `shop-product:create|update|delete`;
  codes with `shop-promotion:view|create|update`. Row security on orders, lines and entitlements
  admits these same scopes, so they work end to end. A fine scope alone
  (`kon:ecommerce:list-orders`) passes the route check, but row security on `shop_orders` does not
  know it: the list comes back empty. Without any of these, the backoffice answers 403.
- Deleting a product needs admin: `ecommerce:*`, `kon:ecommerce:*`, `admin` or
  `shop-product:delete`.
- Public tools: `ecommerce__list-products`, `ecommerce__get-product`, `ecommerce__create-order`.
  `create-order` places a real order: it reserves stock and e-mails the address given. Do not
  use it to test.
- Sensitive, may return `202 KITSUDEN_E_APPROVAL_REQUIRED` (report it, do not retry):
  `change-order-status`, `delete-product`, `detach-product-file`, `add-license-keys`,
  `create-promotion`, `update-promotion`.
- Each tool returns the same JSON as its route (see the README's [HTTP API](README.md#http-api));
  creations answer 201 with the new row; `deliver-order` returns what was granted, the keys still
  missing and the order's entitlements.
- 404: the row does not exist (or, for buyers, the token is wrong). 409: a slug, sku or code is
  taken, a transition is not allowed, or the order is not paid (`deliver-order`). 422: invalid
  body, with every problem at once.
- Idempotency: `change-order-status` and `deliver-order` are idempotent. For `create-order` send
  an `Idempotency-Key` (8-128 characters: letters, digits, `_ . : -`); a retry makes no second
  order, and through the core it answers `409 KITSUDEN_E_IDEMPOTENCY_NOT_REPLAYABLE` because a
  response carrying the order token is never stored.
- Refused or impossible on purpose: setting prices, `shippingCents`, `ownerId` or `status` on an
  order (ignored); deleting an order or a discount code (no route, policy `delete` is false);
  editing an order with a generic `PATCH` (only `TRANSITIONS`); changing a code's code, kind or
  value (create another); reading or paying a buyer's order as an agent (the buyer routes are not
  MCP tools and need the buyer's token); opening a payment for an amount.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | Kon definition, rate limits, re-exports, `listenToPayments()` (reacts to `payment:payment.succeeded` and `payment:payment.refunded`). |
| `operations.ts` | `KON_ID`, operation registry, `policy()`, `onTheRow()`, `require()`. |
| `shop.routes.ts` | All 25 operations, input schemas, buyer views, settings readers (`shippingFlatCents`, `pickupNote`, `reservationMinutes`). |
| `shop.policy.ts` | Policies `shop-product`, `shop-order`, `shop-promotion`. |
| `shop.access.ts` | Buyer tokens: generation, SHA-256 hashing, `tokenOpensOrder`, "my orders" links and their throttle. |
| `shop.orders.ts` | Pure order logic and stock: `validateCompliance`, `freezeLines`, `calculateTotals`, atomic stock, reservation expiry, `TRANSITIONS`, `statusAfterPayment`. |
| `shop.service.ts` | `createOrder` in one transaction, idempotency by `sha256(email + key)`. |
| `shop.payments.ts` | `applyStatus`, the payment gateway loaded from kon-payments at runtime, `onPaymentSucceeded`, `onPaymentRefunded`. |
| `shop.delivery.ts` | Entitlements: grant, revoke, list, `takeDownload`, `generateLicenseKey`. |
| `shop.promotions.ts` | `computeDiscount`, `promotionByCode`, atomic `claimPromotion`, `releasePromotion`. |
| `shop.mails.ts` | The four mailables, their texts, `shopMailsActive()`, page URLs. |
| `shop.notify.ts` | Sends e-mails and emits `shop:order.*` events on creation and status changes. |
| `shop.schema.ts` | Drizzle tables and enums. |
| `migrations/` | `0001`-`0009` and `history.json`. |
| `kon.json`, `package.json`, `tsconfig.json` | Manifest, package, compiler settings. |

## Rules that must hold

| Rule | Where | Guarded by |
| --- | --- | --- |
| Stock is taken with a conditional `UPDATE … RETURNING`, never read-then-write; `stock` null is unlimited; a `CHECK` forbids negatives. | `shop.orders.ts`, `0001_shop.sql` | `tests/unit/shop-orders.test.ts`, `tests/unit/security-shop.test.ts` ("six mugs and ten simultaneous purchases") |
| Lines freeze name and price; totals come from the catalog, never the client. | `freezeLines`, `createOrder` | `shop-orders.test.ts`, `security-shop.test.ts` |
| Status only moves through `TRANSITIONS`; `paid` goes on to `delivered` (digital) or `in_production`. | `shop.orders.ts`, `shop.payments.ts` | `shop-orders.test.ts`, `tests/unit/shop-routes.test.ts` |
| Cancelling returns stock and the code use; a refund revokes downloads and keys. | `shop.payments.ts`, `shop.promotions.ts`, `shop.delivery.ts` | `tests/unit/shop-checkout-delivery.test.ts` |
| A payment marks an order paid only if amount and currency equal its total; repeated webhooks change nothing. | `onPaymentSucceeded` | `shop-checkout-delivery.test.ts` |
| Buyer tokens are stored only as SHA-256; a wrong token is 404, like a missing order. | `shop.access.ts` | `shop-checkout-delivery.test.ts` |
| `POST /api/shop/my-orders/link` always answers 202 and says nothing about who bought. | `shop.routes.ts` | `shop-checkout-delivery.test.ts` |
| Downloads and code uses are counted with conditional `UPDATE`s. | `shop.delivery.ts`, `shop.promotions.ts` | `shop-checkout-delivery.test.ts` |
| Delivery never hands out a second copy of a file or key. | `grantEntitlements` | `shop-checkout-delivery.test.ts` |
| The order policy never looks at the buyer's e-mail; buyer routes check the token, then run as the system. | `shop.policy.ts`, `shop.routes.ts` | `shop-routes.test.ts` ("a regular user neither"), `shop-checkout-delivery.test.ts` |
| Row security on orders and the `0008` tables; agents need `shop-order:*` style scopes. | `0007_english_rls.sql`, `0009_rls_checkout_delivery.sql` | `tests/unit/shop-rls-delivery.test.ts`, `tests/unit/shop-agents.test.ts` |
| An `Idempotency-Key` is tied to the e-mail; the same key with another e-mail makes a new order. | `idempotencyFingerprint` | `security-shop.test.ts` |
| The public order routes are rate limited, fail closed. | `index.ts` `rateLimits` | `security-shop.test.ts` |
| Sending e-mails never waits for or breaks the change that caused it. | `shop.notify.ts` | review |

## Changing it

- New migration: the next number in `migrations/` (now `0010_…`). Never edit an applied one;
  `migrations/history.json` keeps accepted older checksums (`previousChecksums`) and old names
  of renamed files (`renamed`). Add a `renamed` entry only when you rename a file.
- A new table with orders or buyer data needs row security in the same migration; use
  `kitsuden_rls_team` as `0009` does.
- kon-payments is loaded at runtime (`loadPaymentGateway`), never imported statically: the shop
  must compile and run without it. Keep it that way.
- A new order status needs the enum, `TRANSITIONS`, the e-mail list (`STATUSES_WITH_MAIL`) and
  tests in `shop-orders.test.ts`.
- New file at the kon root: run `pnpm kon:sync` (updates `package.json` `files` and `kon.json`).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- Operation ids are part of the contract (MCP tool, fine scope, stored agent keys): do not rename.

## Tests

```bash
pnpm vitest run tests/unit/shop-orders.test.ts             # shop.orders.ts
pnpm vitest run tests/unit/shop-service.test.ts            # shop.service.ts
pnpm vitest run tests/unit/shop-routes.test.ts             # routes, policy
pnpm vitest run tests/unit/shop-checkout-delivery.test.ts  # payments, delivery, codes, e-mails, access
pnpm vitest run tests/unit/shop-rls-delivery.test.ts       # migrations, row security
pnpm vitest run tests/unit/shop-agents.test.ts             # agent scopes
pnpm vitest run tests/unit/security-shop.test.ts           # stock, idempotency, limits
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-ecommerce"
```
