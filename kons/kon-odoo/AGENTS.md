# AGENTS.md — kon-odoo

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Keep it true when the kon changes.

## What it is

Odoo as the ERP behind a shop. A mirror of Odoo's catalog, stock and prices that the public reads
instead of the ERP; orders made in Odoo; events (`odoo:*`) other kons act on. Odoo owns every
fact: the mirror is a copy, and nothing in it is edited by hand.

Tested against Odoo 19.0 Community with the kitsuden_bridge module (`tests/unit/kon-odoo-live.test.ts`,
skipped without a live Odoo). Odoo keeps the books: kon-conta follows Odoo only with
`CONTA_FOLLOW_ODOO=true`.

## Calling it

- The catalog needs no key: `odoo__list-products`, `odoo__get-product`, `odoo__list-categories`.
  They read this Kitsuden's tables and never call Odoo, so they are cheap to call often.
- Everything else needs a key with `odoo:*`, `kon:odoo:*` or the operation's fine scope
  (`kon:odoo:create-order`). A deny on the key wins over any grant.
- `create-order` answers at once with `status: "pending"`. The order is made in Odoo by the
  queue: read it again (`get-order`) for its number, total and `paymentUrl`. `status: "failed"`
  carries Odoo's reason in `error` and is not retried. Send the same `clientRef` to retry safely:
  it answers the same order.
- An order names variants by `variantId` or by `sku` (Odoo's internal reference). A reference on
  two variants is refused: look at `list-conflicts`.
- To sell: `create-cart`, `set-cart-line`, `checkout-cart` (or `create-order`). The order holds its
  units; a 409 names the line there is not enough of. When `get-order` shows `amountDue`, open the
  payment with kon-payments (`payments__open-order-checkout`, metadata `odooOrderId`, amount in
  cents). The order turns `confirmed` when the payment arrives and Odoo confirms it, or `expired`
  when nobody pays in time.
- `get-wallet` and `check-connection` call Odoo while you wait. A 409 from them is Odoo not being
  reachable or refusing the key; the message says which.
- `update-settings` is sensitive. It never returns a secret, only whether one is stored.
- `availability: "OutOfStock"` means no free units. `quantity: null` means Odoo does not count
  that product: it can always be sold.
- A write held for human approval answers `202 KITSUDEN_E_APPROVAL_REQUIRED`: report the proposal,
  do not retry.

## Map of the code

- `kon.json` — manifest: version, tables, mount path. The single source.
- `index.ts` — the kon definition: rate limits, schedules, events, what startup registers.
- `odoo.client.ts` — the JSON-2 client. No dependency; the caller passes what makes the request.
- `odoo.connection.ts` — where Odoo is, the host connection that carries the key, and
  `detectCapabilities`: what this instance has installed, found with `fields_get`.
- `odoo.mirror.ts` — from Odoo's records to rows. `planProduct` is arithmetic; `applyPlans`
  writes and says what changed.
- `odoo.sync.ts` — reading from Odoo: by notice, the full walk a page per job, images.
- `odoo.webhook.ts` — signed notices in, signed purge notices out.
- `odoo.orders.ts` — orders, customers, payments, store credit, products made on demand.
- `odoo.holds.ts` — stock held while a customer pays: place, release, extend, availability.
- `odoo.checkout.ts` — carts, the payment from kon-payments, settling in Odoo, expiry.
- `odoo.queues.ts` — the two queues, the two schedules, what is and is not worth retrying.
- `odoo.catalog.ts` — the public catalog's queries.
- `odoo.routes.ts` — the operations.
- `odoo.policy.ts` — who may do what.
- `odoo.state.ts` — the settings row, capabilities, sealing and opening secrets.
- `odoo.events.ts` — the events declaration.
- `odoo.schema.ts`, `migrations/` — tables and their row security.

## Rules that must hold

- Tables are created by migrations only, never at runtime.
- Public requests never call Odoo. Only `check-connection` and `get-wallet` call it inside a
  request; everything else goes through the queue.
- A notice is verified against the stored secret before anything is read from it. Without a
  stored secret every notice is refused.
- A notice names records, never values. Values are always read back from Odoo with the key.
- The API key never reaches this kon: requests go through the host connection's `fetch`.
- A secret in the settings is stored sealed (`ctx.secrets`) and never returned by any operation.
  The two sealed columns are declared in `secretColumns`.
- What can be sold is `free_qty`, not `qty_available`. A negative quantity counts as none.
- A variant's Odoo id is not an identity. A new id with a known internal reference keeps its row
  (`previous_odoo_ids` remembers the old one). A row is hidden, never deleted: an order may name it.
- Missing products is never read as "module not installed": `detectCapabilities` throws when the
  key's user cannot read `product.template` or `product.product`.
- A job that must record a failure writes it and returns. Throwing undoes what the job wrote.
- The unpublished catalog is not served by the catalog routes to anyone, the team included.
- `get-wallet` never reads or returns a card's code.
- An order and its holds are placed together or not at all (a savepoint around both).
- What can be sold is `qty_free - qty_held`. A hold is taken in one conditional UPDATE; it is
  released when Odoo confirms or cancels the order, when it fails, or when it expires unpaid.
- A payment is believed only for the exact amount and currency the order owes; anything else is a
  `payment_mismatch` conflict and nothing is settled. kon-payments is never imported: its events
  are read structurally.
- Every call to Odoo is its own transaction there. Nothing here assumes two calls are atomic.

## Changing it

- Schema change: edit `odoo.schema.ts` and add the next numbered migration. Never edit an
  applied migration.
- A field the sync needs from Odoo goes in `WANTED` (`odoo.connection.ts`): only fields listed
  there and present on the instance are asked for, so a missing module costs nothing.
- A new route is also classified in `authorization-matrix.kons.json` and listed in `README.md`.
- A new event goes in `odoo.events.ts`. Never rename or remove a field of a payload: other kons
  build on it.
- New file next to `index.ts`: run `pnpm kon:sync` (package.json `files`).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`.

## Tests

`pnpm vitest run tests/unit/kon-odoo.test.ts tests/unit/kon-odoo-conta.test.ts`. The Odoo double
is `FakeOdoo` in `tests/unit/helpers/odoo-bench.ts`: when the kon makes a call the double does not
know, teach the double, do not loosen the kon.
