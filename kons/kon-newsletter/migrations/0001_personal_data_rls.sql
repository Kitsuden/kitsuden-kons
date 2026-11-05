-- 0001 — Database wall for the newsletter's personal data
-- ============================================================================
-- Idempotent: DROP POLICY IF EXISTS before each CREATE.
--
-- WHY
--
-- `nl_members` stores email addresses, consent IP and the confirmation and
-- UNSUBSCRIBE tokens in plain text (the unsubscribe one has to be placeable in
-- every email). `nl_suppressions`, `nl_deliveries` and `nl_events` are more
-- addresses and the trail of who opened what. Only the kon's routes protected
-- them.
--
-- And `nl_members` had an OWNERSHIP policy (rls-owned-tables.sql, by
-- `user_id`) that an anonymous user with a context gets through: their
-- `current_user_id` is '', which is the system's loophole. A RESTRICTIVE policy
-- is AND-ed with any permissive one, so it closes that without touching the
-- shared file.
--
-- WHO GETS THROUGH: the system (no context: the kon's routes, the sending, the
-- bounce webhooks) and `admin`, which is the only role with a newsletter panel.
-- Nobody else, not `editor` nor `anonymous` either.

DO $$
DECLARE
  t TEXT;
  quien CONSTANT TEXT :=
    $Q$coalesce(current_setting('app.current_user_role', true), '') IN ('', 'admin')$Q$;
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
