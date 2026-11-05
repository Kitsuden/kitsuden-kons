-- CRM RLS: the team only (security review 2026-10-15)
-- ----------------------------------------------------------------------------
--
-- The CRM book (contacts with email and phone, companies, amounts,
-- notes, documents) belongs to the sales TEAM, not to whoever typed each row,
-- which is why it is not isolated by owner (see `rls-coverage.test.ts`, COLLABORATIVE).
-- But it does not belong to just anyone with an account either, and sign-up is public.
--
-- This policy is by ROLE: with a user context, only `admin`, `editor` and
-- `agent` see or write rows. A `user` or an anonymous user (context `anonimo`)
-- get ZERO rows, whether the query comes from the kon's routes (which set the
-- context on every request, crm.context.ts) or from any other surface
-- that sets a context (GraphQL, explorer, realtime). An agent passes RLS,
-- and it is the kon's policy that decides with its scopes (`crm:*`).
--
-- With an empty context (migrations, workers, data loading) everything passes,
-- as in the rest of Kitsuden.
--
-- Idempotent: DROP POLICY IF EXISTS before each CREATE.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crm_companies',
    'crm_contacts',
    'crm_pipelines',
    'crm_pipeline_stages',
    'crm_deals',
    'crm_activities',
    'crm_entity_configs',
    'crm_stage_transitions',
    'crm_documents'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_equipo', t);
      EXECUTE format($POLICY$
        CREATE POLICY %I ON %I
          FOR ALL TO PUBLIC
          USING (
            current_setting('app.current_user_id', true) = ''
            OR current_setting('app.current_user_id', true) IS NULL
            OR current_setting('app.current_user_role', true) IN ('admin', 'editor', 'agent')
          )
          WITH CHECK (
            current_setting('app.current_user_id', true) = ''
            OR current_setting('app.current_user_id', true) IS NULL
            OR current_setting('app.current_user_role', true) IN ('admin', 'editor', 'agent')
          )
      $POLICY$, t || '_equipo', t);
    END IF;
  END LOOP;
END $$;
