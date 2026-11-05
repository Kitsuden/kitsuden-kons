-- 0001 — Shop: catalog, variants, orders and order lines
-- ============================================================================
-- Idempotent: it can be reapplied without breaking anything.
--
-- It covers two scenarios with the SAME tables, because the difference between
-- selling a file and selling a mug is not in the order but in the
-- fulfillment: `fulfillment_type` decides which data is needed and what happens
-- after payment.

DO $$ BEGIN
  CREATE TYPE shop_product_kind AS ENUM ('digital', 'physical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- `in_production` exists because here the seller also MAKES the goods: between
  -- paying and shipping there are days of work, and the buyer asks.
  CREATE TYPE shop_order_status AS ENUM (
    'pending', 'paid', 'in_production', 'ready', 'shipped', 'delivered', 'cancelled', 'refunded'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE shop_fulfillment_type AS ENUM ('digital', 'shipping', 'pickup');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Catalog ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shop_products (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  kind        shop_product_kind NOT NULL DEFAULT 'digital',
  media_id    TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  metadata    JSONB NOT NULL DEFAULT '{}',
  owner_id    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shop_products_slug_idx ON shop_products (slug);
CREATE INDEX IF NOT EXISTS shop_products_active_idx ON shop_products (active);

-- The variant ALWAYS exists, even if the product has only one: if price
-- and stock lived on the product, adding "large mug" would force a data
-- migration. One extra row avoids that migration forever.
CREATE TABLE IF NOT EXISTS shop_variants (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT 'Única',
  sku         TEXT,

  -- In whole CENTS. Never float: 0.1 + 0.2 is not 0.3, and this is money.
  price_cents INTEGER NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'EUR',

  -- NULL = unlimited stock. It tells a file (a thousand times) apart from a mug
  -- (you made six). It is modelled as ABSENCE and not as a large number so that
  -- "0 left" and "does not apply" are never confused.
  stock       INTEGER,

  attributes  JSONB NOT NULL DEFAULT '{}',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Selling below zero is a bug you only see when an angry customer
  -- shows up. It is forbidden in the database too, not only in the code.
  CONSTRAINT shop_variants_stock_no_negativo CHECK (stock IS NULL OR stock >= 0)
);

CREATE INDEX IF NOT EXISTS shop_variants_product_idx ON shop_variants (product_id);
CREATE UNIQUE INDEX IF NOT EXISTS shop_variants_sku_idx ON shop_variants (sku) WHERE sku IS NOT NULL;

-- ── Orders ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shop_orders (
  id               TEXT PRIMARY KEY,
  number           TEXT NOT NULL,
  status           shop_order_status NOT NULL DEFAULT 'pending',
  fulfillment_type shop_fulfillment_type NOT NULL,

  -- The buyer is stored IN the order, not by reference: an order is a
  -- historical document, and if the customer changes their email tomorrow,
  -- yesterday's order must still say where it was sent.
  customer_email   TEXT NOT NULL,
  customer_name    TEXT,

  subtotal_cents   INTEGER NOT NULL DEFAULT 0,
  shipping_cents   INTEGER NOT NULL DEFAULT 0,
  total_cents      INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'EUR',

  shipping_address JSONB,
  pickup_note      TEXT,
  notes            TEXT,

  -- Opaque reference to the payment in kon-payments. NO foreign key: the shop
  -- works even if that kon is not installed.
  payment_ref      TEXT,

  placed_at        TIMESTAMPTZ,
  owner_id         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The fulfillment type decides which data is mandatory. Checking it
  -- here stops a new route from skipping the application's validation.
  CONSTRAINT shop_orders_envio_con_direccion
    CHECK (fulfillment_type <> 'shipping' OR shipping_address IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS shop_orders_number_idx ON shop_orders (number);
CREATE INDEX IF NOT EXISTS shop_orders_status_idx ON shop_orders (status);
CREATE INDEX IF NOT EXISTS shop_orders_email_idx ON shop_orders (customer_email);

-- The line stores name and price FROZEN. It is the most important decision
-- of the schema: without it, the total of a year-old order would be recalculated
-- with today's price, and deleting a product would destroy the accounting.
--
-- `variant_id` stays as a hint for restocking or analysis — nullable and with NO
-- cascading delete: deleting a product cannot delete the history of what
-- was sold.
CREATE TABLE IF NOT EXISTS shop_order_items (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  variant_id       TEXT,

  product_name     TEXT NOT NULL,
  variant_name     TEXT,
  unit_price_cents INTEGER NOT NULL,
  quantity         INTEGER NOT NULL,
  subtotal_cents   INTEGER NOT NULL,
  kind             shop_product_kind NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT shop_order_items_cantidad_positiva CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS shop_order_items_order_idx ON shop_order_items (order_id);

-- ── Order number counter ────────────────────────────────────────────────────
-- A sequence and not MAX(number)+1: two simultaneous orders would read the
-- same maximum and generate the same number, which has a unique index and would
-- make one of the two buyers fail.
CREATE SEQUENCE IF NOT EXISTS shop_order_number_seq;
