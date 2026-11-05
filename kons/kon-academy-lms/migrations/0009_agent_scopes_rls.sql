-- 0009: row security recognises agents by their scopes.
-- ============================================================================
-- Idempotent: CREATE OR REPLACE / DROP POLICY IF EXISTS.
--
-- An agent reaches Postgres with app.current_user_role = 'agent' and its scopes in
-- app.agent_scopes. The personal tables only admitted the row owner, the human `admin` role,
-- academy administrators and supervisors (0007), so an agent that passed a manager route with
-- `academy:manage` (or even `admin`) read only its own rows: reports and lists came back empty,
-- and writing another learner's assignment failed the WITH CHECK.
--
-- The rule is the core's (`kitsuden_agent_can_in_kon`, agent-functions.sql, applied before the
-- kons' migrations) and the same as `agentManagesAcademy` / `agentAdministersAcademy` in
-- academy.policy.ts:
--
--   academy_agent_administers()  `academy:administer` (or `academy:*`), or a scope that opens the
--                                whole kon (`admin`, `academy-lms:*`, `kon:academy-lms:*`)
--   academy_agent_manages()      `academy:manage`, or the above
--
-- A denial (`!academy:*`, `!academy-lms:*`, `!kon:academy-lms:*`) wins.
--
-- Not SECURITY DEFINER: they read only settings, no table.

CREATE OR REPLACE FUNCTION academy_agent_administers()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
    SELECT kitsuden_agent_can_in_kon('academy-lms', 'academy:administer')
$function$;

CREATE OR REPLACE FUNCTION academy_agent_manages()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
    SELECT kitsuden_agent_can_in_kon('academy-lms', 'academy:manage')
        OR kitsuden_agent_can_in_kon('academy-lms', 'academy:administer')
$function$;

-- The learners' personal tables: a managing agent reads and writes them, for every learner.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'assignments',
    'learning_path_assignments',
    'certificates',
    'satisfaction_surveys',
    'feedback',
    'course_progress',
    'learning_path_progress',
    'topic_progress',
    'user_answers',
    'quiz_results'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_academy_agent', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (academy_agent_manages()) WITH CHECK (academy_agent_manages())',
      t || '_academy_agent', t
    );
  END LOOP;
END $$;

-- Profiles carry the academy role: a managing agent reads them, only an administering agent
-- writes them (the routes that write profiles are administrator routes).
DROP POLICY IF EXISTS training_user_profiles_academy_agent_reads ON training_user_profiles;
CREATE POLICY training_user_profiles_academy_agent_reads ON training_user_profiles
  FOR SELECT TO PUBLIC USING (academy_agent_manages());

DROP POLICY IF EXISTS training_user_profiles_academy_agent ON training_user_profiles;
CREATE POLICY training_user_profiles_academy_agent ON training_user_profiles
  FOR ALL TO PUBLIC USING (academy_agent_administers()) WITH CHECK (academy_agent_administers());
