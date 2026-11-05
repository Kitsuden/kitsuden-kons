-- 0003 — Newsletter: the EFFECTIVE admin in the database too (phase D fixes, 2026-10-25)
-- ============================================================================
-- Idempotent: recreates both policies of 0002.
--
-- The `nl_*` tables (subscribers, sends, events: personal data) only let
-- through the system (empty id AND role) and the human `admin` role. An AGENT
-- with `admin` arrives with role `agent`: the admin route gave it a 403 and,
-- even if it got through, the database would have hidden everything (phase D).
--
-- Now the admin is `kitsuden_effective_admin('newsletter')` (core,
-- apps/api/src/db/agent-functions.sql): the human admin, or an agent with
-- `admin`, `newsletter:*` or `kon:newsletter:*` (with no denial covering it).
-- The same thing newsletter.routes.ts checks.

DO $$
DECLARE
  t TEXT;
  quien CONSTANT TEXT :=
    $Q$(
      kitsuden_effective_admin('newsletter')
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
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_permitir', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      t || '_permitir', t, quien, quien);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_solo_admin', t);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      t || '_solo_admin', t, quien, quien);
  END LOOP;
END $$;
