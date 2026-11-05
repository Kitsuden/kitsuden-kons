-- 0002 — Secure orders: idempotency, expiring reservations and RLS
-- ============================================================================
-- Idempotent: it can be reapplied without breaking anything.
--
-- Audit 2026-10-15. `POST /api/shop/orders` is anonymous on purpose (the
-- buyer has no account) and it DEDUCTS stock when it creates the order as
-- `pending`. With nothing else, anyone could drain the stock of a one-off piece
-- with a loop of orders that never paid, and a network retry duplicated both
-- the order and the deduction.

-- ── Idempotency ────────────────────────────────────────────────────────────
-- The FINGERPRINT (sha256 of email + key) is stored, not the key: a key
-- guessed with another email does not return anyone's order.
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS shop_orders_idempotency_idx
  ON shop_orders (idempotency_key);

-- ── Expiring reservations ──────────────────────────────────────────────────
-- An unpaid `pending` order holds units; `releaseExpiredReservations` cancels
-- them and restocks once the time limit passes. This index makes that sweep cheap.
CREATE INDEX IF NOT EXISTS shop_orders_pending_idx
  ON shop_orders (placed_at) WHERE status = 'pending';

-- ── RLS: orders (email, address) belong to the shop's TEAM ───────────────────
-- The buyer is not a user of the system, so there is no "owner" to
-- isolate by. The rule is by ROLE: with a user in context, only admin/editor
-- read or write orders. Without context (anonymous order creation, workers,
-- migrations) it is allowed, like the rest of the project's policies
-- (see apps/api/src/db/rls-owned-tables.sql).
--
-- It covers the generic paths that go through `withTransactionalRLS` (data, items,
-- GraphQL): a regular account with context does not read other people's orders even
-- if one of those routes were opened by mistake.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['shop_orders', 'shop_order_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Without FORCE, the table owner is exempt and the policy is decorative.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_equipo', t);
    EXECUTE format($POLICY$
      CREATE POLICY %I ON %I
        FOR ALL
        TO PUBLIC
        USING (
          current_setting('app.current_user_id', true) IS NULL
          OR current_setting('app.current_user_id', true) = ''
          OR current_setting('app.current_user_role', true) IN ('admin', 'editor')
        )
        WITH CHECK (
          current_setting('app.current_user_id', true) IS NULL
          OR current_setting('app.current_user_id', true) = ''
          OR current_setting('app.current_user_role', true) IN ('admin', 'editor')
        )
    $POLICY$, t || '_equipo', t);
  END LOOP;
END $$;
