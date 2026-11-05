-- 0003 — Orders: "system" means empty id AND empty role (2026-10-23)
-- ============================================================================
-- Idempotent: it recreates the two policies from 0002 with the strict
-- condition.
--
-- 0002 treated any context with an empty `app.current_user_id` as the
-- system. While the kons' routes ran without context that did not matter; since
-- every request to a kon runs in its own RLS transaction, the ANONYMOUS user carries id ''
-- and role `anonymous`, and with 0002 it went through the policy as if it were the
-- system: any anonymous route could read the orders (email, address)
-- if the application failed. It is the same hatch the core closed in
-- rls-owned-tables.sql and the newsletter in its 0002.
--
-- Creating an order still works: the route does it as the system
-- (`ctx.db.asSystem`) after validating the body.

DO $$
DECLARE
  t TEXT;
  quien CONSTANT TEXT :=
    $Q$(
      (COALESCE(current_setting('app.current_user_id', true), '') = ''
       AND COALESCE(current_setting('app.current_user_role', true), '') = '')
      OR current_setting('app.current_user_role', true) IN ('admin', 'editor')
    )$Q$;
BEGIN
  FOREACH t IN ARRAY ARRAY['shop_orders', 'shop_order_items'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_equipo', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      t || '_equipo', t, quien, quien);
  END LOOP;
END $$;
