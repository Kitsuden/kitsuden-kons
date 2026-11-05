-- 0004 — Members: the EFFECTIVE team, agents included (phase D fixes, 2026-10-25)
-- ============================================================================
-- Idempotent: DROP POLICY IF EXISTS / CREATE POLICY.
--
-- The members base (`members`, `member_access`) belongs to the team: the system
-- or a human admin/editor role (0003). An AGENT with `admin` passed the app
-- policy (members.policy.ts, `can()`) and got an EMPTY list: the RLS did not
-- know the `agent` role (phase D, e2e test over HTTP).
--
-- Now there is also `kitsuden_effective_staff('members')` (core,
-- apps/api/src/db/agent-functions.sql: a human admin/editor or an agent with
-- `admin`, `members:*`, `kon:members:*`) and an agent with a fine-grained
-- permission on members (`member:view|create|update|delete`, what `can()` grants it),
-- unless a denial of the whole kon (`!members:*`) shuts it out.
-- What it may DO with them is decided by the app; the database just stops hiding
-- the rows from it. `member_signins` and `member_sessions` remain the system's
-- ONLY (access tokens): neither the team nor an agent reads them.

DO $$
DECLARE
  t TEXT;
  quien CONSTANT TEXT :=
    $Q$((COALESCE(current_setting('app.current_user_role', true), '') = ''
         AND COALESCE(current_setting('app.current_user_id', true), '') = '')
        OR kitsuden_effective_staff('members')
        OR kitsuden_agent_can_in_kon('members', 'member:view')
        OR kitsuden_agent_can_in_kon('members', 'member:create')
        OR kitsuden_agent_can_in_kon('members', 'member:update')
        OR kitsuden_agent_can_in_kon('members', 'member:delete'))$Q$;
BEGIN
  FOREACH t IN ARRAY ARRAY['members', 'member_access'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_permitir', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      t || '_permitir', t, quien, quien);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_solo_equipo', t);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      t || '_solo_equipo', t, quien, quien);
  END LOOP;
END $$;
