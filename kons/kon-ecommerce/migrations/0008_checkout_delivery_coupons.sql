-- 0008 — Paying, delivering and discounting: what the shop's own scenario was missing
-- ============================================================================
-- Idempotent: it can be applied again without breaking anything.
--
-- Until now an order stayed `pending` until someone on the team marked it paid by hand, a
-- digital product had no way to reach the buyer, there were no discount codes and the buyer
-- heard nothing after buying. This adds the tables those four need. Their row security is in
-- 0009, so a test database without the core's agent functions can still load this file.

-- ── Orders ─────────────────────────────────────────────────────────────────
-- `access_token_hash`: the buyer has no account; a random token, given once when the order is
-- created and sent by email, opens THAT order (pay it, see it, download what it bought). Only
-- its sha256 is stored, like a password.
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS access_token_hash TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS promotion_id TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS promotion_code TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS payment_provider TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS tracking_url TEXT;

CREATE INDEX IF NOT EXISTS shop_orders_payment_ref_idx ON shop_orders (payment_ref);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shop_orders_discount_valid') THEN
    ALTER TABLE shop_orders ADD CONSTRAINT shop_orders_discount_valid
      CHECK (discount_cents >= 0 AND total_cents >= 0);
  END IF;
END $$;

-- ── Variants: how a digital purchase is delivered ──────────────────────────
-- `license_mode`: `none`, `generate` (a random key per unit) or `pool` (keys the team uploaded,
-- for software someone else licenses). `download_limit` and `download_days`: NULL is no limit.
ALTER TABLE shop_variants ADD COLUMN IF NOT EXISTS license_mode TEXT NOT NULL DEFAULT 'none';
ALTER TABLE shop_variants ADD COLUMN IF NOT EXISTS download_limit INTEGER;
ALTER TABLE shop_variants ADD COLUMN IF NOT EXISTS download_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shop_variants_delivery_valid') THEN
    ALTER TABLE shop_variants ADD CONSTRAINT shop_variants_delivery_valid CHECK (
      license_mode IN ('none', 'generate', 'pool')
      AND (download_limit IS NULL OR download_limit > 0)
      AND (download_days IS NULL OR download_days > 0)
    );
  END IF;
END $$;

-- ── Files a purchase delivers ──────────────────────────────────────────────
-- The file itself lives in the core's media library; this says which product (or only which
-- variant of it) delivers it. Deleting the product deletes the attachment, never the media.
CREATE TABLE IF NOT EXISTS shop_product_files (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  variant_id  TEXT REFERENCES shop_variants(id) ON DELETE CASCADE,
  media_id    TEXT NOT NULL,
  -- What the buyer sees. The storage key is read from the media row at download time.
  filename    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_product_files_product_idx ON shop_product_files (product_id);

-- ── License keys the team uploaded (`license_mode = 'pool'`) ───────────────
CREATE TABLE IF NOT EXISTS shop_license_keys (
  id             TEXT PRIMARY KEY,
  variant_id     TEXT NOT NULL REFERENCES shop_variants(id) ON DELETE CASCADE,
  license_key    TEXT NOT NULL,
  -- Set when a paid order takes it. A taken key is never handed out twice.
  order_item_id  TEXT,
  assigned_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_license_keys_unique_idx
  ON shop_license_keys (variant_id, license_key);
CREATE INDEX IF NOT EXISTS shop_license_keys_free_idx
  ON shop_license_keys (variant_id) WHERE order_item_id IS NULL;

-- ── What a paid order gives its buyer ──────────────────────────────────────
-- One row per file and per license key. `order_item_id` has no foreign key on purpose, like
-- `variant_id` on the lines: the history of what was delivered outlives the catalog.
CREATE TABLE IF NOT EXISTS shop_entitlements (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES shop_orders(id),
  order_item_id   TEXT,
  kind            TEXT NOT NULL,
  file_id         TEXT REFERENCES shop_product_files(id) ON DELETE SET NULL,
  filename        TEXT,
  license_key     TEXT,
  downloads_used  INTEGER NOT NULL DEFAULT 0,
  download_limit  INTEGER,
  expires_at      TIMESTAMPTZ,
  -- A refund revokes; the row stays so the history says what was delivered and taken back.
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shop_entitlements_kind_valid CHECK (kind IN ('download', 'license')),
  CONSTRAINT shop_entitlements_downloads_valid
    CHECK (download_limit IS NULL OR downloads_used <= download_limit)
);
CREATE INDEX IF NOT EXISTS shop_entitlements_order_idx ON shop_entitlements (order_id);

-- ── Discount codes ─────────────────────────────────────────────────────────
-- Shaped after Medusa's promotions (MIT): an APPLICATION (what is taken off, and from what) and
-- RULES (when it applies). Small on purpose; the shape lets it grow without a rewrite.
CREATE TABLE IF NOT EXISTS shop_promotions (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL,
  description         TEXT,
  active              BOOLEAN NOT NULL DEFAULT true,
  -- `percentage`: `value` is 1-100. `fixed`: `value` is cents, in `currency`.
  application_type    TEXT NOT NULL,
  -- `order`: off the eligible lines. `shipping`: off the shipping cost.
  application_target  TEXT NOT NULL DEFAULT 'order',
  value               INTEGER NOT NULL,
  currency            TEXT,
  min_subtotal_cents  INTEGER,
  -- Only these products count towards the discount; NULL is every product.
  product_ids         JSONB,
  starts_at           TIMESTAMPTZ,
  ends_at             TIMESTAMPTZ,
  usage_limit         INTEGER,
  usage_count         INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shop_promotions_application_valid CHECK (
    application_type IN ('percentage', 'fixed')
    AND application_target IN ('order', 'shipping')
    AND value > 0
    AND (application_type <> 'percentage' OR value <= 100)
    AND (application_type <> 'fixed' OR currency IS NOT NULL)
  ),
  CONSTRAINT shop_promotions_usage_valid CHECK (
    usage_count >= 0 AND (usage_limit IS NULL OR usage_count <= usage_limit)
  )
);
-- Codes are compared without case: `SUMMER` and `summer` are the same code.
CREATE UNIQUE INDEX IF NOT EXISTS shop_promotions_code_idx ON shop_promotions (lower(code));

-- ── "My orders" links ──────────────────────────────────────────────────────
-- The buyer asks with their email and gets a link that lists their orders for a short while.
-- Only the token's sha256 is stored.
CREATE TABLE IF NOT EXISTS shop_order_links (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_order_links_email_idx ON shop_order_links (email, created_at);
