-- 0005 — CRM: "system" means empty id AND empty role (2026-10-23)
-- ============================================================================
-- Idempotent: DROP POLICY IF EXISTS / CREATE OR REPLACE.
--
-- 0004_team_rls treated any context with an empty `app.current_user_id` as the
-- system. The kon set its own context and gave the anonymous user an id that
-- matched nothing (`anonimo`), so it went unnoticed. Since 2026-10-23 the
-- HOST sets the context for every kon, with the core's convention: the
-- anonymous user carries id '' and role `anonymous`. With 0004_team_rls it would
-- have passed these policies as if it were the system. It is the same hatch
-- the core closed in rls-owned-tables.sql.

DO $$
DECLARE
  t text;
  quien CONSTANT text := $Q$(
    (COALESCE(current_setting('app.current_user_id', true), '') = ''
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) IN ('admin', 'editor', 'agent')
  )$Q$;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crm_companies', 'crm_contacts', 'crm_pipelines', 'crm_pipeline_stages',
    'crm_deals', 'crm_activities', 'crm_entity_configs', 'crm_stage_transitions',
    'crm_documents'
  ]
  LOOP
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
