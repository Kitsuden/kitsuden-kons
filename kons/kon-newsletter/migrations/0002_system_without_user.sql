-- Newsletter: "system" means empty role AND no user in the session (2026-10-21).
--
-- 0001 let `app.current_user_role = ''` through as the system context even
-- when there was an `app.current_user_id`: a session with a user but no role
-- set saw every subscriber. The startup verifier (scripts/verify-rls.ts)
-- caught it in production and stopped the API. It is the same loophole the
-- core closed in rls-owned-tables.sql.
--
-- Idempotent: recreates both policies with the strict condition.

DO $$
DECLARE
  t TEXT;
  quien CONSTANT TEXT :=
    $Q$(
      coalesce(current_setting('app.current_user_role', true), '') = 'admin'
      OR (
        coalesce(current_setting('app.current_user_role', true), '') = ''
        AND coalesce(current_setting('app.current_user_id', true), '') = ''
      )
    )$Q$;
BEGIN
  FOREACH t IN ARRAY ARRAY['nl_members', 'nl_subscriptions', 'nl_suppressions', 'nl_deliveries', 'nl_events']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_permitir', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      t || '_permitir', t, quien, quien);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_solo_admin', t);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      t || '_solo_admin', t, quien, quien);
  END LOOP;
END $$;
