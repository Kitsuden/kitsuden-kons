-- kon-odoo 0001 — carts, stock held while a customer pays, and the payment of an order
-- ============================================================================
-- Idempotent (IF NOT EXISTS, DROP … IF EXISTS).
--
-- Odoo reserves nothing for a quotation, so two web orders could both want the last unit. A hold
-- is this kon's own claim on units of a variant, for a few minutes: what the public catalog shows
-- as available is Odoo's free quantity minus what is held here. `qty_held` lives on the variant,
-- next to `qty_free`, so the catalog reads it without seeing anyone's holds, and so that taking a
-- hold is one conditional UPDATE that two checkouts cannot both win.
--
-- Holds do not reach the point of sale: a sale at the counter does not see them.

ALTER TABLE odoo_settings ADD COLUMN IF NOT EXISTS hold_minutes integer NOT NULL DEFAULT 10;
ALTER TABLE odoo_settings DROP CONSTRAINT IF EXISTS odoo_settings_hold_minutes_check;
ALTER TABLE odoo_settings ADD CONSTRAINT odoo_settings_hold_minutes_check CHECK (hold_minutes BETWEEN 2 AND 120);

ALTER TABLE odoo_variants ADD COLUMN IF NOT EXISTS qty_held numeric(19,4) NOT NULL DEFAULT 0;
ALTER TABLE odoo_variants DROP CONSTRAINT IF EXISTS odoo_variants_qty_held_check;
ALTER TABLE odoo_variants ADD CONSTRAINT odoo_variants_qty_held_check CHECK (qty_held >= 0);

-- ── Orders: what is left to pay, and the payment ─────────────────────────────
ALTER TABLE odoo_orders ADD COLUMN IF NOT EXISTS wallet_amount numeric(19,4) NOT NULL DEFAULT 0;
ALTER TABLE odoo_orders ADD COLUMN IF NOT EXISTS amount_due numeric(19,4);
ALTER TABLE odoo_orders ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz;
ALTER TABLE odoo_orders ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE odoo_orders ADD COLUMN IF NOT EXISTS paid_amount numeric(19,4);
ALTER TABLE odoo_orders ADD COLUMN IF NOT EXISTS payment_provider varchar(32);
ALTER TABLE odoo_orders ADD COLUMN IF NOT EXISTS payment_ref varchar(191);
ALTER TABLE odoo_orders ADD COLUMN IF NOT EXISTS settled_at timestamptz;

ALTER TABLE odoo_orders DROP CONSTRAINT IF EXISTS odoo_orders_status_check;
ALTER TABLE odoo_orders ADD CONSTRAINT odoo_orders_status_check
  CHECK (status IN ('pending', 'created', 'confirmed', 'cancelled', 'failed', 'expired'));
CREATE INDEX IF NOT EXISTS odoo_orders_hold_idx ON odoo_orders (hold_expires_at) WHERE paid_at IS NULL;
-- A payment is applied to one order once.
CREATE UNIQUE INDEX IF NOT EXISTS odoo_orders_payment_idx ON odoo_orders (payment_provider, payment_ref) WHERE payment_ref IS NOT NULL;

ALTER TABLE odoo_conflicts DROP CONSTRAINT IF EXISTS odoo_conflicts_kind_check;
ALTER TABLE odoo_conflicts ADD CONSTRAINT odoo_conflicts_kind_check
  CHECK (kind IN ('duplicate_reference', 'variant_recreated', 'currency_mismatch', 'payment_mismatch', 'paid_unavailable', 'settle_failed'));

-- ── Holds ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS odoo_holds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES odoo_orders(id) ON DELETE CASCADE,
  variant_id   uuid NOT NULL REFERENCES odoo_variants(id) ON DELETE CASCADE,
  quantity     numeric(19,4) NOT NULL CHECK (quantity > 0),
  expires_at   timestamptz NOT NULL,
  released_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS odoo_holds_active_idx ON odoo_holds (expires_at) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS odoo_holds_order_idx ON odoo_holds (order_id);

-- ── Carts ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS odoo_carts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid REFERENCES odoo_orders(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS odoo_carts_updated_idx ON odoo_carts (updated_at);

CREATE TABLE IF NOT EXISTS odoo_cart_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id     uuid NOT NULL REFERENCES odoo_carts(id) ON DELETE CASCADE,
  variant_id  uuid NOT NULL REFERENCES odoo_variants(id) ON DELETE CASCADE,
  quantity    numeric(19,4) NOT NULL CHECK (quantity > 0),
  added_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id, variant_id)
);

-- Carts and holds belong to the shop's backend and the team, never to the public.
SELECT kitsuden_rls_team('odoo_carts', 'odoo', 'odoo-order:view', 'odoo-order:create');
SELECT kitsuden_rls_team('odoo_cart_lines', 'odoo', 'odoo-order:view', 'odoo-order:create');
SELECT kitsuden_rls_team('odoo_holds', 'odoo', 'odoo-order:view', 'odoo-order:create');
