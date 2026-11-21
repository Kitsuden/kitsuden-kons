-- 0002 — One-time payments this kon opened
-- ============================================================================
-- Idempotent (IF NOT EXISTS, DROP POLICY IF EXISTS).
--
-- Tilopay sends the buyer back with an order number, and Yappy notifies with an order number and
-- a status: neither carries the metadata that tells which order of which kon was paid, and Yappy
-- carries no amount. Both are kept here when the payment is opened and read back by `reference`
-- on the server, never taken from the request.
--
-- Written and read only by the system (the operation that opens a payment, the return route);
-- admins may read it to reconcile by hand.

CREATE TABLE IF NOT EXISTS pay_checkouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference     varchar(15) NOT NULL,
  provider      varchar(32) NOT NULL,
  amount        integer NOT NULL CHECK (amount > 0),
  currency      varchar(3) NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}',
  success_url   text NOT NULL,
  cancel_url    text,
  provider_ref  varchar(191),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pay_checkouts_reference_idx ON pay_checkouts (reference);

DO $$
DECLARE
  system_only text := $q$(coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')$q$;
BEGIN
  ALTER TABLE pay_checkouts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE pay_checkouts FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS pay_checkouts_system ON pay_checkouts;
  EXECUTE format('CREATE POLICY pay_checkouts_system ON pay_checkouts FOR ALL USING (%s OR current_setting(''app.current_user_role'', true) = ''admin'') WITH CHECK (%s)', system_only, system_only);
END $$;
