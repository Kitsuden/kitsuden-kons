-- kon-odoo — initial schema
-- ============================================================================
-- A kon's tables are created HERE, never from code: the API connects with a role without the
-- CREATE privilege (which is what makes row security effective). Applied by `pnpm db:migrate`,
-- by `kitsuden kon add`, or by the panel when the kon is switched on.
--
-- A migration that was applied is history: to change a table, add 0001_<what>.sql.
--
-- Odoo owns the facts in the mirror tables (categories, products, variants, partners). The sync
-- writes them as the system; nobody edits them by hand.

-- ── Settings: one row ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS odoo_settings (
  id                 integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  capabilities       jsonb,
  currency           varchar(3),
  lang               varchar(10),
  webhook_secret     jsonb,
  purge_url          text,
  purge_secret       jsonb,
  purge_source       varchar(60) NOT NULL DEFAULT 'odoo',
  key_expires_on     date,
  last_full_sync_at  timestamptz,
  last_notice_at     timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO odoo_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Mirror ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS odoo_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  odoo_id         integer NOT NULL UNIQUE,
  name            text NOT NULL,
  slug            text NOT NULL,
  parent_odoo_id  integer,
  path            text NOT NULL DEFAULT '/',
  synced_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS odoo_categories_path_idx ON odoo_categories (path text_pattern_ops);
CREATE INDEX IF NOT EXISTS odoo_categories_slug_idx ON odoo_categories (slug);

CREATE TABLE IF NOT EXISTS odoo_products (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  odoo_id           integer NOT NULL UNIQUE,
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  description       text,
  sku               text,
  barcode           text,
  list_price        numeric(19,4),
  min_price         numeric(19,4),
  max_price         numeric(19,4),
  currency          varchar(3),
  category_odoo_id  integer,
  attributes        jsonb NOT NULL DEFAULT '{}',
  qty_free          numeric(19,4),
  in_stock          boolean NOT NULL DEFAULT true,
  published         boolean NOT NULL DEFAULT false,
  active            boolean NOT NULL DEFAULT true,
  image_version     text,
  image_key         text,
  odoo_write_date   timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- What the public listing filters and sorts by. Partial: unpublished rows are never listed.
CREATE INDEX IF NOT EXISTS odoo_products_category_idx ON odoo_products (category_odoo_id) WHERE published;
CREATE INDEX IF NOT EXISTS odoo_products_price_idx ON odoo_products (min_price) WHERE published;
CREATE INDEX IF NOT EXISTS odoo_products_name_idx ON odoo_products (lower(name)) WHERE published;
CREATE INDEX IF NOT EXISTS odoo_products_recent_idx ON odoo_products (created_at DESC) WHERE published;
CREATE INDEX IF NOT EXISTS odoo_products_stock_idx ON odoo_products (in_stock) WHERE published;
CREATE INDEX IF NOT EXISTS odoo_products_attributes_idx ON odoo_products USING gin (attributes);
CREATE INDEX IF NOT EXISTS odoo_products_sku_idx ON odoo_products (sku);

CREATE TABLE IF NOT EXISTS odoo_variants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  odoo_id            integer NOT NULL UNIQUE,
  product_id         uuid NOT NULL REFERENCES odoo_products(id) ON DELETE CASCADE,
  sku                text,
  barcode            text,
  options            jsonb NOT NULL DEFAULT '{}',
  price              numeric(19,4),
  qty_free           numeric(19,4),
  qty_on_hand        numeric(19,4),
  active             boolean NOT NULL DEFAULT true,
  visible            boolean NOT NULL DEFAULT false,
  previous_odoo_ids  integer[] NOT NULL DEFAULT '{}',
  odoo_write_date    timestamptz,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS odoo_variants_product_idx ON odoo_variants (product_id);
CREATE INDEX IF NOT EXISTS odoo_variants_sku_idx ON odoo_variants (sku);

CREATE TABLE IF NOT EXISTS odoo_partners (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  odoo_id    integer NOT NULL UNIQUE,
  email      text,
  name       text NOT NULL,
  phone      text,
  vat        text,
  user_id    text,
  synced_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS odoo_partners_email_idx ON odoo_partners (email);
CREATE INDEX IF NOT EXISTS odoo_partners_user_idx ON odoo_partners (user_id);

-- ── Orders ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS odoo_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ref      varchar(120) NOT NULL UNIQUE,
  odoo_id         integer UNIQUE,
  odoo_name       text,
  partner_id      uuid REFERENCES odoo_partners(id) ON DELETE SET NULL,
  customer        jsonb NOT NULL,
  lines           jsonb NOT NULL,
  note            text,
  status          varchar(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'created', 'confirmed', 'cancelled', 'failed')),
  amount_untaxed  numeric(19,4),
  amount_tax      numeric(19,4),
  amount_total    numeric(19,4),
  currency        varchar(3),
  payment_url     text,
  error           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS odoo_orders_status_idx ON odoo_orders (status, created_at DESC);

-- ── Operation ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS odoo_notices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id    varchar(120) NOT NULL UNIQUE,
  changes      integer NOT NULL DEFAULT 0,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS odoo_notices_received_idx ON odoo_notices (received_at DESC);

CREATE TABLE IF NOT EXISTS odoo_sync_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status       varchar(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  cursor       integer NOT NULL DEFAULT 0,
  products     integer NOT NULL DEFAULT 0,
  variants     integer NOT NULL DEFAULT 0,
  retired      integer NOT NULL DEFAULT 0,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS odoo_sync_runs_started_idx ON odoo_sync_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS odoo_conflicts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         varchar(40) NOT NULL
               CHECK (kind IN ('duplicate_reference', 'variant_recreated', 'currency_mismatch')),
  reference    text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}',
  resolved_at  timestamptz,
  resolved_by  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- The same problem is reported once while it is open.
CREATE UNIQUE INDEX IF NOT EXISTS odoo_conflicts_open_idx ON odoo_conflicts (kind, reference) WHERE resolved_at IS NULL;

-- ── Row security ─────────────────────────────────────────────────────────────
-- With the core's helpers (agent-functions.sql), so the database says the same as
-- odoo.policy.ts even if a query forgets a filter:
--   · the system (the sync, the queue), the team (admin, editor) and an agent with the scope
--     named below, or the whole kon (`odoo:*`, `kon:odoo:*`);
--   · anyone, signed in or not, reads the catalog that is published.
SELECT kitsuden_rls_team('odoo_categories', 'odoo', 'odoo-catalog:view', 'odoo-catalog:update');
SELECT kitsuden_rls_public_read('odoo_categories', $$true$$);

SELECT kitsuden_rls_team('odoo_products', 'odoo', 'odoo-catalog:view', 'odoo-catalog:update');
SELECT kitsuden_rls_public_read('odoo_products', $$published AND active$$);

SELECT kitsuden_rls_team('odoo_variants', 'odoo', 'odoo-catalog:view', 'odoo-catalog:update');
SELECT kitsuden_rls_public_read('odoo_variants', $$visible AND active$$);

-- Customers and their orders: never public.
SELECT kitsuden_rls_team('odoo_partners', 'odoo', 'odoo-order:view', 'odoo-order:create');
SELECT kitsuden_rls_team('odoo_orders', 'odoo', 'odoo-order:view', 'odoo-order:create');

SELECT kitsuden_rls_team('odoo_settings', 'odoo', 'odoo-admin:view', 'odoo-admin:update');
SELECT kitsuden_rls_team('odoo_sync_runs', 'odoo', 'odoo-admin:view', 'odoo-admin:update');
SELECT kitsuden_rls_team('odoo_conflicts', 'odoo', 'odoo-admin:view', 'odoo-admin:update');

-- Change notices: written only by the system (the webhook), read by admins.
DO $$
DECLARE
  system_only text := $q$(coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')$q$;
BEGIN
  ALTER TABLE odoo_notices ENABLE ROW LEVEL SECURITY;
  ALTER TABLE odoo_notices FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS odoo_notices_system ON odoo_notices;
  EXECUTE format('CREATE POLICY odoo_notices_system ON odoo_notices FOR ALL USING (%s OR current_setting(''app.current_user_role'', true) = ''admin'') WITH CHECK (%s)', system_only, system_only);
END $$;
