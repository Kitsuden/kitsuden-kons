-- 0003 — Tier list templates: public in the database (2026-10-23)
-- ============================================================================
-- Idempotent: DROP POLICY IF EXISTS before each CREATE.
--
-- `tier_lists` stores two things in the same table (see tierlist.policy.ts):
--
--   · TEMPLATES (`kind <> 'personal'`): a game's editorial tier list.
--     No owner (`owner_id` NULL). Everyone reads it, without a session: it is
--     what the public site renders.
--   · PERSONAL lists: their owner's. `tier_lists_owner_isolation` isolates them
--     (rls-owned-tables.sql).
--
-- Until now the kon's routes ran without an RLS context (= system) and the
-- ownership policy filtered nothing. With the per-request RLS transaction,
-- without this policy an anonymous user would see ZERO templates (their owner
-- is NULL, which matches nobody) and the site would be left without tier lists.
--
-- Writing a template is editorial: admin, editor or an agent (the agent is
-- limited by its scope in the application, `can(..., "publish"|"update", ...)`).
-- A regular user never writes a template, here either.

DO $$
BEGIN
  IF to_regclass('public.tier_lists') IS NOT NULL THEN
    DROP POLICY IF EXISTS tier_lists_plantillas_lectura ON tier_lists;
    CREATE POLICY tier_lists_plantillas_lectura ON tier_lists
      FOR SELECT TO PUBLIC
      USING (kind <> 'personal');

    DROP POLICY IF EXISTS tier_lists_plantillas_edicion ON tier_lists;
    CREATE POLICY tier_lists_plantillas_edicion ON tier_lists
      FOR ALL TO PUBLIC
      USING (
        kind <> 'personal'
        AND current_setting('app.current_user_role', true) IN ('admin', 'editor', 'agent')
      )
      WITH CHECK (
        kind <> 'personal'
        AND current_setting('app.current_user_role', true) IN ('admin', 'editor', 'agent')
      );
  END IF;
END $$;
