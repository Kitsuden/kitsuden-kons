-- 0013 — Selling: product lines on a deal, quotes, and sales targets
-- Idempotent.
--
--   crm_deal_lines     what a deal sells. The price is FROZEN when the line is added: a catalog that
--                      changes later does not change what was offered. The product is referenced by shape
--                      ({ product_type, product_id }: a shop variant, another kon's item, or nothing)
--   crm_quotes         a quote of a deal: a snapshot of its lines, draft → sent → accepted / rejected
--   crm_sales_targets  how much a person is expected to win in a period
--
-- Lines and quotes are visible exactly when their deal is: the team policy of the CRM, and a restrictive
-- policy that asks the deal itself (whose own row security already narrows by `records` access).

CREATE TABLE IF NOT EXISTS crm_deal_lines (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  product_type TEXT,
  product_id TEXT,
  sku TEXT,
  name TEXT NOT NULL,
  quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  discount_pct NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  tax_pct NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (tax_pct BETWEEN 0 AND 100),
  line_total INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_deal_lines_product_shape CHECK ((product_type IS NULL) = (product_id IS NULL))
);
CREATE INDEX IF NOT EXISTS crm_deal_lines_deal_idx ON crm_deal_lines (deal_id, position);

CREATE TABLE IF NOT EXISTS crm_quotes (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
  number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  lines JSONB NOT NULL DEFAULT '[]',
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  valid_until DATE,
  notes TEXT,
  sent_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  accepted_by TEXT,
  rejected_at TIMESTAMPTZ,
  -- What accepting it set in motion: nothing, an order in kon-ecommerce, or a payment in kon-payments.
  outcome TEXT CHECK (outcome IN ('none', 'order', 'payment')),
  outcome_ref TEXT,
  checkout_url TEXT,
  paid_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_quotes_deal_idx ON crm_quotes (deal_id);

CREATE TABLE IF NOT EXISTS crm_sales_targets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_sales_targets_period CHECK (period_end >= period_start),
  UNIQUE (user_id, period_start, period_end)
);

DO $$
DECLARE
  t text;
  team CONSTANT text :=
    '((COALESCE(current_setting(''app.current_user_id'', true), '''') = '''' '
    || 'AND COALESCE(current_setting(''app.current_user_role'', true), '''') = '''') '
    || 'OR current_setting(''app.current_user_role'', true) IN (''admin'', ''editor'', ''agent''))';
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_deal_lines', 'crm_quotes', 'crm_sales_targets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_team', t);
    EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL USING (%s) WITH CHECK (%s)', t || '_team', t, team, team);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['crm_deal_lines', 'crm_quotes'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_scope', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL USING (EXISTS (SELECT 1 FROM crm_deals d WHERE d.id = %I.deal_id)) WITH CHECK (EXISTS (SELECT 1 FROM crm_deals d WHERE d.id = %I.deal_id))',
      t || '_scope', t, t, t);
  END LOOP;
END $$;
