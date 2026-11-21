# kon-odoo

Odoo as the ERP behind a shop. Kitsuden keeps a mirror of Odoo's catalog, stock and prices, kept
in step by signed change notices, so the public reads Kitsuden and never reaches the ERP. Orders
are made in Odoo, which stays the place where they live. What happens in Odoo is announced as
events, so other kons (the ledger in kon-conta, a CRM) can act on it without importing this one.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| experimental | business | 0.1.0 | `/api/odoo` | Odoo 19 or later (JSON-2 API) |

Built with the kon SDK (Kitsuden's docs/kons/README.md): each route is an operation declared once
in `odoo.routes.ts`, which also gives it its OpenAPI 3.1 entry and its MCP tool.

Tested against Odoo 19.0 Community (build 20261112) with the bridge module: catalog with
variants, a sale paid partly with store credit, its invoice and payment, and a stock change. Not
yet tried in production, nor with Odoo 20.

## Install

Inside a Kitsuden project: `kitsuden kon add odoo`, then restart the API. Then:

1. Set `ODOO_URL` (and `ODOO_DATABASE` if the server hosts several) in the API's environment. An
   Odoo on a private address must also be listed in the host's `CONNECTIONS_PRIVATE_HOSTS`.
2. In Odoo, create a user for this integration with the least access it needs (read products,
   stock, categories, customers, sales orders and payments; create customers and sales orders)
   and an API key for it. Keys made by hand last three months at most.
3. In Kitsuden, an admin stores that key as an organization connection for the provider `odoo`
   (the host's connections API, docs/connections.md). The first full read of the catalog starts
   by itself.
4. Store a webhook secret (`PATCH /api/odoo/settings`) and have Odoo send signed change notices
   to `POST /api/odoo/webhook`. Without notices the mirror is only as fresh as the nightly walk.
5. Optional: set where the site's cache is told what changed (`purgeUrl`, `purgeSecret`), and the
   day the key expires (`keyExpiresOn`), to be warned two weeks before.

## What it adds

| Table | What it holds |
| --- | --- |
| `odoo_products` | A copy of each product template: name, price range, free quantity, whether it is published |
| `odoo_variants` | A copy of each variant, followed by its internal reference when Odoo recreates it |
| `odoo_categories` | The product category tree |
| `odoo_partners` | The Odoo customers this kon has met, and the Kitsuden account each belongs to, when known |
| `odoo_orders` | Orders taken here, with what Odoo answered for each, what is due, and the payment |
| `odoo_holds` | Units of a variant held for an order until it is paid or the hold runs out |
| `odoo_carts`, `odoo_cart_lines` | Carts the shop's backend keeps for its visitors |
| `odoo_conflicts` | What the sync could not settle and a person must look at in Odoo |
| `odoo_sync_runs` | Each full walk of the catalog |
| `odoo_notices` | Change notices received, so the same one is processed once |
| `odoo_settings` | One row: what Odoo has installed, the sealed secrets, the purge address |

Product images are copied into Kitsuden's own storage, so the site serves them without a request
to Odoo.

### Buying: cart, held stock, payment

1. The shop's backend keeps a cart (`/carts`), checks it out (`/carts/:id/checkout`) or places an
   order directly (`/orders`). The order HOLDS its units: what the catalog shows as available is
   Odoo's free quantity less what is held here, and a second customer cannot take a held unit
   (409 naming the line). Holds last `holdMinutes` (10 by default).
2. The order is made in Odoo by the queue. Read it again for its number and `amountDue` (Odoo's
   total less any store credit).
3. The shop's backend opens the payment with kon-payments (`POST /api/payments/orders/checkout`,
   metadata `odooOrderId`, the amount due in cents): Stripe, Tilopay, Yappy or another provider
   there.
4. kon-payments announces the payment. This kon checks the amount and currency against what the
   order owes, marks it paid and asks Odoo to confirm it. With the bridge module that one call
   also records the payment and takes the store credit, in one Odoo transaction; without it the
   order is confirmed and the payment stays in kon-payments only.
5. Unpaid when the hold runs out, the order expires, its units go back on sale and Odoo is asked
   to cancel the quotation. A payment that arrives after its units were sold is kept as a conflict
   for a person.

Alternatively, a shop may let Odoo take the money: `paymentUrl` is the order's page on Odoo's own
portal.

### Whose books

Odoo keeps them. With the bridge module, a paid web order is invoiced and its payment registered
in Odoo, in the journal set in Odoo's settings. kon-payments does not post those payments to
kon-conta (they carry `odooOrderId`), and kon-conta does not follow Odoo unless
`CONTA_FOLLOW_ODOO=true`, which is for an installation whose ledger is kon-conta and whose Odoo
runs without accounting.

### What it does not do

- **Holds do not reach Odoo's point of sale.** A sale at the counter can still take a unit the web
  holds. The web never sells the same unit twice; the counter and the web can.
- **Store credit needs the bridge module.** Without it, an order asking for store credit is
  refused (409).
- **It does not rotate the API key.** The key is held by the host's connections and never reaches
  this kon, so it cannot ask Odoo for a new one. It warns before the key expires.
- **One category per product.** It mirrors Odoo's internal product category, not the eCommerce
  categories, of which a product can have several.
- **One price.** It mirrors the sales price of each variant, not pricelists, and does not know
  whether that price includes tax: that is a setting of the Odoo website.

## HTTP API

Public, read from the mirror. None of these calls Odoo.

| Route | What it does |
| --- | --- |
| `GET /api/odoo/catalog/products` | Published products, a page at a time. Filters: `search`, `category`, `attributes`, `priceMin`, `priceMax`, `inStock`; `sort`; `facets=true` counts the matches in each category |
| `GET /api/odoo/catalog/products/:slug` | One product with its variants. The Odoo id at the end of the slug is what is looked up, so a link made before a rename still works |
| `GET /api/odoo/catalog/categories` | The category tree, with the published products in each |
| `GET /api/odoo/catalog/summaries` | Slug and last change of every published product, for a sitemap; `after` and `limit` to read on |

From Odoo:

| Route | What it does |
| --- | --- |
| `POST /api/odoo/webhook` | A signed change notice. See "Change notices" below |

For the kon's team (admin, editor, or an agent that opens this kon):

| Route | What it does |
| --- | --- |
| `GET /api/odoo/status` | Where Odoo is, what it has installed, how fresh the mirror is, the last walk, open conflicts, days left on the key |
| `POST /api/odoo/connection/check` | Asks Odoo what it has installed and records it |
| `POST /api/odoo/sync` | Starts a full walk of the catalog (it also runs every night) |
| `GET /api/odoo/settings` | The settings. Secrets are never returned |
| `PATCH /api/odoo/settings` | Changes the settings; `webhookSecret` and `purgeSecret` are write-only |
| `GET /api/odoo/conflicts` | What the sync could not settle |
| `POST /api/odoo/conflicts/:id/resolve` | Marks a conflict as looked at |
| `GET /api/odoo/orders` | Orders taken here |
| `POST /api/odoo/orders` | Takes an order, holds its units and queues it for Odoo. Optional `walletAmount` (store credit, needs the bridge). Idempotent on `clientRef` |
| `POST /api/odoo/carts` | Opens a cart |
| `GET /api/odoo/carts/:id` | The cart, with current prices and what is available |
| `PUT /api/odoo/carts/:id/lines` | Sets how many of a variant the cart has; 0 takes it out |
| `POST /api/odoo/carts/:id/checkout` | Turns the cart into an order, holding its units. Idempotent on `clientRef` |
| `GET /api/odoo/orders/:id` | One order, with Odoo's number, totals and payment page |
| `GET /api/odoo/wallet` | A customer's store credit (eWallet), asked from Odoo now |
| `POST /api/odoo/products/provision` | Creates a product in Odoo unless it already has that reference |

### Change notices

Odoo says which records changed, never their new values; this kon reads them back with its key.

```
POST /api/odoo/webhook
X-Odoo-Signature: sha256=<hex HMAC-SHA256 of the raw body, with the webhook secret>

{ "id": "<unique per notice>",
  "changes": [ { "model": "product.template", "ids": [12, 13] },
               { "model": "product.product",  "ids": [40] },
               { "model": "sale.order",       "ids": [7] } ] }
```

Models accepted: `product.template`, `product.product` (a stock change is a notice about the
variant whose quantity moved), `product.category`, `sale.order`, `account.payment`. A notice
already seen is acknowledged and dropped.

Odoo does not send this shape by itself. The Odoo module `kitsuden_bridge` (its own repository,
`kitsuden-odoo-bridge`, LGPL-3) writes what changed to an outbox in the same transaction and sends
it signed. The same module adds the one-transaction methods `create_order` and `confirm_payment`
(order confirmed, store credit taken, invoice and payment recorded) that this kon uses when it
finds them.

### Events

Emitted for other kons, automation rules and agents. Delivery is in-process and at most once, and
some repeat: deduplicate on the Odoo id each payload carries.

| Event | When |
| --- | --- |
| `odoo:product.changed` | Products in the mirror changed |
| `odoo:price.changed` | A price changed in Odoo |
| `odoo:stock.changed` | A free quantity changed, or a product can no longer be bought |
| `odoo:sale_order.created` | An order taken here now exists in Odoo |
| `odoo:sale_order.confirmed` | A sales order is confirmed in Odoo, whoever made it |
| `odoo:sale_order.cancelled` | A sales order was cancelled in Odoo |
| `odoo:payment.received` | A customer payment is registered in Odoo |
| `odoo:order.paid` | A payment from kon-payments matched what an order owes |
| `odoo:order.expired` | An unpaid order ran out of time; its units are back on sale |
| `odoo:payment.mismatch` | A payment named an order but not for what it owes |
| `odoo:order.paid_unavailable` | A payment arrived after the order's units were sold |
| `odoo:order.settle_failed` | Odoo refused to confirm a paid order |
| `odoo:sync.completed` | A full walk finished |
| `odoo:key.expiring` | The API key stops working within two weeks |

kon-conta listens to `odoo:sale_order.confirmed` and `odoo:payment.received` and keeps the books
from them: the customer, an issued invoice, and the payment on it.

## Who can do what

`odoo.policy.ts` decides. Anyone reads the published catalog. Everything else is for the kon's
team: a human admin or editor, or an agent that opens the kon (`odoo:*`, `kon:odoo:*`). A
signed-in visitor has no order routes here: the shop's own backend takes orders on a customer's
behalf, with an agent key. Row security in the migration says the same.

## Configuration

| Where | Name | What it is |
| --- | --- | --- |
| Environment | `ODOO_URL` | Where Odoo is: `https://erp.example.com`. Required |
| Environment | `ODOO_DATABASE` | The database name, when the server hosts several |
| Host environment | `CONNECTIONS_PRIVATE_HOSTS` | Must list the Odoo host when it is on a private address |
| Connection | provider `odoo` | The API key, stored by an admin, sealed by the host |
| Settings | `webhookSecret` | Shared with Odoo; signs its notices. Sealed |
| Settings | `purgeUrl`, `purgeSecret`, `purgeSource` | Where and how the site's cache is told what changed |
| Settings | `keyExpiresOn` | The key's last day, to be warned before it |
| Settings | `lang` | Language of translatable fields, such as `es_ES` |
| Settings | `holdMinutes` | How long an unpaid order holds its units (2 to 120, default 10) |

Three schedules run by themselves: a full walk of the catalog every night, a check every minute
that expires unpaid orders whose hold ran out, and a morning check that warns about the key and
forgets notices older than a month and carts untouched for thirty days.

## Agents and MCP

Each operation is an MCP tool, `odoo__<operation>`, in three groups: `kon:odoo/catalog`,
`kon:odoo/orders` and `kon:odoo/operations`. `receive-notice` is not a tool: Odoo calls it.
Fine scopes are `kon:odoo:<operation>`. See [AGENTS.md](AGENTS.md).

## Tests

`tests/unit/kon-odoo-live.test.ts` runs the same flows against a real Odoo with the bridge module
(skipped unless `ODOO_LIVE_URL`, `ODOO_LIVE_DB` and `ODOO_LIVE_KEY_FILE` are set; the bridge
repository's `docker-compose.yml` and `scripts/seed_live.py` make one).

`tests/unit/kon-odoo.test.ts` (the kon against an in-memory Odoo),
`tests/unit/kon-odoo-checkout.test.ts` (carts, holds, paying, expiry, store credit) and
`tests/unit/kon-odoo-conta.test.ts` (this kon and kon-conta on one database):

```bash
pnpm vitest run tests/unit/kon-odoo.test.ts tests/unit/kon-odoo-checkout.test.ts tests/unit/kon-odoo-conta.test.ts
```

## License

MIT
