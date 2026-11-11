# kon-ecommerce

A small shop for **digital products** and **objects the seller makes**: catalog, orders without
customer accounts, finite stock, shipping or local pickup, online payment through kon-payments,
delivery of files and license keys, discount codes and order e-mails.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | business | 1.1.2 | `/api/shop` | kon-media (core `auth`) |

It is not a large-catalog shop: there is no persistent cart, no carrier rates, no warehouse
management and no per-jurisdiction taxes. For that, run a dedicated commerce engine next to
Kitsuden instead of growing this kon into one.

## Install

```bash
kitsuden kon add ecommerce --enable
```

`kon.json` has `defaultEnabled: false`, so pass `--enable` (or switch it on in the admin panel,
**Kons**). Restart the API afterwards. `kon.json` requires `kon-media`: files a product delivers
are files of the media library.

To take payments online, also install kon-payments (`kitsuden kon add payments --enable`) and
configure Stripe or Lemon Squeezy there; the shop loads it at runtime. Without it the shop still
sells, and the team marks orders paid by hand. See [Configuration](#configuration) for the shop's
own settings.

## What it adds

**The difference between selling a file and selling a mug is in the fulfillment, not the order.**
There is one order type with one field:

| `fulfillmentType` | Address | Stock | After payment |
| --- | --- | --- | --- |
| `digital` | no | usually unlimited (`stock` null) | `delivered` |
| `shipping` | required | finite | `in_production` |
| `pickup` | no; the shop's pickup place and hours are required | finite | `in_production` |

Order statuses: `pending`, `paid`, `in_production`, `ready`, `shipped`, `delivered`,
`cancelled`, `refunded`. Allowed moves are fixed in `TRANSITIONS` (`shop.orders.ts`).

Tables (from `kon.json`):

| Table | What it holds |
| --- | --- |
| `shop_products` | Catalog products: slug, name, description, kind (`digital`, `physical`), media, `active`. |
| `shop_variants` | Variants: sku, price in cents, currency, `stock` (null = unlimited; a `CHECK` forbids negatives), attributes, license mode (`none`, `generate`, `pool`), optional download limit and days. |
| `shop_orders` | Orders: number, buyer e-mail and name, fulfillment, address or pickup note, totals, discount, status, payment reference, tracking, hash of the order token. |
| `shop_order_items` | Order lines with the product name and unit price frozen at purchase; `variant_id` is a nullable hint without cascade. |
| `shop_product_files` | Media files a product delivers, for every variant or one. |
| `shop_license_keys` | Keys uploaded to a variant's pool, each handed out once. |
| `shop_entitlements` | What a paid order received: file downloads (with counts and expiry) and license keys. |
| `shop_promotions` | Discount codes. |
| `shop_order_links` | "My orders" link tokens (hashes) sent to a buyer's e-mail. |

Three decisions to understand before changing anything:

1. **Prices are frozen on the line.** A line stores the name and unit price at purchase, so an
   old order always shows what was charged, even after a price change or a deleted product.
2. **`stock` null means unlimited.** "0 left" and "not applicable" are never confused.
3. **Stock is taken atomically.** The condition travels inside the `UPDATE`
   (`WHERE stock IS NULL OR stock >= qty … RETURNING`), so two buyers cannot take the last unit;
   `createOrder` runs in a transaction, so a later failure gives the units back.

### From order to paid

1. `POST /api/shop/orders` answers with the order and an `accessToken`: the buyer's key to that
   order. It is shown once and sent in the confirmation e-mail; only its SHA-256 is stored.
2. `POST /api/shop/orders/:id/checkout` (with the token) opens a one-time payment at the provider
   for the order's total. The caller sends a provider and return URLs, never an amount.
3. kon-payments receives the provider's signed webhook and emits `payment:payment.succeeded`.
   The shop checks that amount and currency equal the order's total and marks it paid: digital
   orders go on to `delivered` (with their files and keys), physical ones to `in_production`. A
   repeated webhook changes nothing.

| Case | Result |
| --- | --- |
| The payment does not match the total | The order stays `pending`; `shop:order.payment-mismatch` is emitted. |
| The checkout completes before the money arrives (bank debit) | Nothing until the provider says the money is in. |
| Paid after the reservation expired, units still there | They are reserved again and the order is paid. |
| Paid after the reservation expired, units sold meanwhile | The order stays `cancelled`; `shop:order.paid-but-unavailable` asks a person to refund. |
| Full refund at the provider | `refunded`; downloads and keys revoked. |
| Full refund of an order that cannot become `refunded` | Nothing changes; `shop:order.refunded-at-provider` is emitted. |
| Partial refund | Nothing changes; `shop:order.partially-refunded` is emitted. |
| The total is 0 (free product, 100% code) | Paid and delivered at once. |

Providers that can charge an order are those kon-payments implements one-time charges for:
Stripe, and Lemon Squeezy once `LEMONSQUEEZY_ORDER_VARIANT_ID` names a "pay what is asked"
variant. `GET /api/shop/orders/:id` lists them per order (`paymentProviders`). Unpaid orders hold
their stock for `reservationMinutes`, then are cancelled and the units return.

### Delivery of digital purchases

When an order is paid, each digital line gets one entitlement per file the product delivers and
one license key per unit when the variant's license mode is `generate` (a random key without
look-alike characters) or `pool` (keys uploaded by the team). The buyer downloads with
`GET /api/shop/orders/:id/downloads/:item`, which counts the download (optional `downloadLimit`
and `downloadDays` on the variant) with a conditional `UPDATE` and redirects to a storage URL
signed for five minutes. Delivery fills in what is missing and never hands out a second copy:
`POST /api/shop/admin/orders/:id/deliver` completes an order after the team adds a file or keys.

### Discount codes

A code has an application (`percentage` 1-100, or `fixed` in cents with its currency; on the
`order` or on `shipping`) and optional rules (dates, minimum subtotal, products, usage limit).
The buyer sends `couponCode`; the server computes the discount from the frozen lines, rounding
down. A use is claimed inside the order's transaction with a conditional `UPDATE`; cancelling
gives it back, a refund does not. Codes are never deleted, only switched off.

### E-mails and "my orders"

The buyer has no account, so the shop writes through the host's mailer:

| E-mail | When |
| --- | --- |
| `shop.order-received` | Right after buying, with the order page link (it carries the order token). |
| `shop.order-paid` | When the payment arrives: downloads and keys, or "we are making it". |
| `shop.order-status` | `ready`, `shipped` (with tracking), `delivered`, `cancelled`, `refunded`. |
| `shop.my-orders` | When the buyer asks for a link with their e-mail. |

Later e-mails cannot carry the order token (only its hash is stored), so they carry a "my orders"
link valid for 7 days. `POST /api/shop/my-orders/link` always answers 202 and sends a 30-minute
link only to an e-mail that has orders, at most one per 2 minutes. Links point to site pages,
never to an API `GET`, because mail clients preview links.

Events: `shop:order.created`, `shop:order.paid`, `shop:order.status-changed`,
`shop:order.payment-mismatch`, `shop:order.paid-but-unavailable`,
`shop:order.partially-refunded`, `shop:order.refunded-at-provider`. They fire even with e-mails
off.

## HTTP API

Public (buyers; the order routes need the order token in `X-Order-Token` or `?token=`, or a
"my orders" token of the same e-mail):

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/shop/products` | Anyone | Active products with their active variants; `limit` up to 100, `offset`. |
| `GET /api/shop/products/:slug` | Anyone | One active product; a draft is 404. |
| `POST /api/shop/orders` | Anyone | Places an order: lines, e-mail, name, fulfillment, address or pickup, notes, `couponCode`. Returns the order and its `accessToken` (201). Rate limited: 10 per minute. |
| `GET /api/shop/orders/:id` | Buyer with a token | The order, and once paid its downloads and keys. Wrong or missing token: 404. |
| `POST /api/shop/orders/:id/checkout` | Buyer with the order token | Opens the payment page for the order's total. 10 per minute. |
| `GET /api/shop/orders/:id/downloads/:item` | Buyer with the order token | Counts a download and redirects (302); 410 when revoked, expired or used up. |
| `POST /api/shop/my-orders/link` | Anyone | E-mails a "my orders" link; always 202. 5 per minute. |
| `GET /api/shop/my-orders` | Buyer with a link token | The orders of that e-mail. |

Backoffice (session):

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/shop/admin/products` | Staff | All products, drafts included, with variants. |
| `POST /api/shop/admin/products` | Staff | Creates a product (201); 409 if the slug is taken. |
| `PATCH /api/shop/admin/products/:id` | Staff | Partial update. |
| `DELETE /api/shop/admin/products/:id` | Admin | Deletes a product and its variants; past orders keep their lines. |
| `POST /api/shop/admin/products/:id/variants` | Staff | Adds a variant (201); 409 if the sku is taken. |
| `PATCH /api/shop/admin/variants/:id` | Staff | Partial update of a variant; uses the product's permission. |
| `GET /api/shop/admin/products/:id/files` | Staff | Files the product delivers. |
| `POST /api/shop/admin/products/:id/files` | Staff | Attaches a media file, for every variant or one (201). |
| `DELETE /api/shop/admin/files/:id` | Staff | Stops delivering a file; existing downloads stop working; the media file stays. |
| `POST /api/shop/admin/variants/:id/license-keys` | Staff | Adds keys to a variant's pool; repeated keys are skipped. |
| `GET /api/shop/admin/orders` | Staff | Orders, newest first; `status`, `limit` up to 200. |
| `GET /api/shop/admin/orders/:id` | Staff | One order with its lines. |
| `POST /api/shop/admin/orders/:id/status` | Staff | Moves an order along `TRANSITIONS` (with `paymentRef`, tracking); e-mails the buyer. |
| `POST /api/shop/admin/orders/:id/deliver` | Staff | Delivers what a paid order is missing; 409 if not paid. |
| `GET /api/shop/admin/promotions` | Staff | Discount codes with usage. |
| `POST /api/shop/admin/promotions` | Staff | Creates a code (201); 409 if it exists. |
| `PATCH /api/shop/admin/promotions/:id` | Staff | Changes rules or switches it off; code, kind and value cannot change. |

`POST /api/shop/orders` ignores prices, `shippingCents`, `ownerId` and `status` from the body:
prices come from the catalog and shipping from the shop's settings. There is no generic order
`PATCH` and no order deletion, not even for admins: an order is an accounting document.

## Who can do what

The policy file is `shop.policy.ts` (resources `shop-product`, `shop-order`, `shop-promotion`).
It governs the backoffice only. A buyer's access to their order never goes through it: it is the
token (`shop.access.ts`), and a missing or wrong token answers 404 like an order that does not
exist.

| Role | Can |
| --- | --- |
| Anonymous / any account | The public routes. A signed-in account without a team role gets 403 in the backoffice. |
| Editor (staff) | Everything in the backoffice except deleting products. |
| Admin | Everything, including deleting products. Nobody deletes orders or codes. |
| Agent | As staff with `ecommerce:*`, `kon:ecommerce:*` or `admin` (as admin for deleting products). Narrower: `shop-order:view` (read orders), `shop-order:update` (change and deliver), `shop-product:create/update/delete`, `shop-promotion:view/create/update`, or the fine scope of the operation. |

Row security:

- `shop_orders` and `shop_order_items` (`migrations/0007_english_rls.sql`): the system, human
  admins and editors, and agents with `shop-order:view` (read) or `shop-order:update` (read and
  write) in the kon.
- `shop_product_files`, `shop_license_keys` (write: `shop-product:update`), `shop_entitlements`
  (`shop-order:view` / `shop-order:update`), `shop_promotions` (`shop-promotion:view` /
  `shop-promotion:update`) and `shop_order_links` (team and system only), declared with
  `kitsuden_rls_team` in `migrations/0009_rls_checkout_delivery.sql`.
- Products and variants have no row security: the backoffice routes check the policy.

Buyer routes check the token in the application and then act as the system.

## Configuration

Shop settings, read from the host's per-kon configuration (`konConfig`, key `kon-ecommerce`):

| Setting | Type | Effect |
| --- | --- | --- |
| `shippingFlatCents` | number | Flat shipping rate in cents. Default 0; a negative or non-integer value counts as 0. |
| `pickupNote` | text | Pickup place and hours. Without it, `pickup` orders are refused. |
| `reservationMinutes` | number | How long an unpaid order holds stock: 5 to 1440, default 30. |

Environment variables:

| Variable | Effect |
| --- | --- |
| `SHOP_MAILS` | `off` stops the e-mails; events still fire. |
| `SHOP_ORDER_URL` | Site page for an order link. Default `<site>/shop/order`. |
| `SHOP_MY_ORDERS_URL` | Site page for a "my orders" link. Default `<site>/shop/orders`. |
| `SHOP_MAX_UNITS_PER_VARIANT` | Units of one variant per order. Default 20; an order holds at most five times that. |
| `SITE_URL` | Fallback for `<site>` when the host has no site URL configured. |

For online payment, kon-payments' own variables apply: `LEMONSQUEEZY_ORDER_VARIANT_ID` for Lemon
Squeezy orders, and return URLs must be on `PAYMENTS_RETURN_ORIGINS` or `ALLOWED_ORIGINS`.

## Agents and MCP

Each operation is an MCP tool `ecommerce__<op>` with the fine scope `kon:ecommerce:<op>`.

| Operation | Route | Writes |
| --- | --- | --- |
| `list-products` | `GET /api/shop/products` | no |
| `get-product` | `GET /api/shop/products/:slug` | no |
| `create-order` | `POST /api/shop/orders` | yes (reserves stock, e-mails the buyer) |
| `list-panel-products` | `GET /api/shop/admin/products` | no |
| `create-product` | `POST /api/shop/admin/products` | yes |
| `update-product` | `PATCH /api/shop/admin/products/:id` | yes |
| `delete-product` | `DELETE /api/shop/admin/products/:id` | yes, sensitive |
| `create-variant` | `POST /api/shop/admin/products/:id/variants` | yes |
| `update-variant` | `PATCH /api/shop/admin/variants/:id` | yes |
| `list-orders` | `GET /api/shop/admin/orders` | no |
| `get-order` | `GET /api/shop/admin/orders/:id` | no |
| `change-order-status` | `POST /api/shop/admin/orders/:id/status` | yes, sensitive |
| `list-product-files` | `GET /api/shop/admin/products/:id/files` | no |
| `attach-product-file` | `POST /api/shop/admin/products/:id/files` | yes |
| `detach-product-file` | `DELETE /api/shop/admin/files/:id` | yes, sensitive |
| `add-license-keys` | `POST /api/shop/admin/variants/:id/license-keys` | yes, sensitive |
| `deliver-order` | `POST /api/shop/admin/orders/:id/deliver` | yes |
| `list-promotions` | `GET /api/shop/admin/promotions` | no |
| `create-promotion` | `POST /api/shop/admin/promotions` | yes, sensitive |
| `update-promotion` | `PATCH /api/shop/admin/promotions/:id` | yes, sensitive |

The buyer's routes (`get-my-order`, `pay-my-order`, `download-my-file`, `request-my-orders-link`,
`list-my-orders`) are not MCP tools. Sensitive operations may come back
`202 KITSUDEN_E_APPROVAL_REQUIRED` when human approval is on. Details for agents:
[AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/shop-orders.test.ts` | Frozen prices, fulfillment validation, atomic stock, the state machine. |
| `tests/unit/shop-service.test.ts` | `createOrder` against the real schema. |
| `tests/unit/shop-routes.test.ts` | Ignored body fields, backoffice access, transitions. |
| `tests/unit/shop-checkout-delivery.test.ts` | Order token, paying, delivering, downloads, refunds, codes, late payments, "my orders", e-mails. |
| `tests/unit/shop-rls-delivery.test.ts` | Row security of the `0008` tables with a non-superuser role. |
| `tests/unit/shop-agents.test.ts` | Agents with `admin`, `shop-order:*`, `shop-order:view`. |
| `tests/unit/security-shop.test.ts` | Idempotency, reservation expiry, overselling, address allowlist, rate limit. |
| `tests/unit/payments-one-time.test.ts` | What Stripe and Lemon Squeezy are asked to charge (kon-payments). |

```bash
pnpm vitest run tests/unit/shop-orders.test.ts
pnpm vitest run tests/unit/shop-checkout-delivery.test.ts
pnpm vitest run tests/unit/security-shop.test.ts
```

These live in the vitest suite, not bun's: bun's `mock.module` leaks between files.

## License

MIT
