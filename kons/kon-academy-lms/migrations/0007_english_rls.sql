-- RLS for kon-academy-lms after the English rename: functions, triggers and policies come back with the new names.
--
-- The previous file dropped the old ones; between both files the tables stay closed, not open.

-- Functions: their bodies are text, so a rename does not reach them.
CREATE OR REPLACE FUNCTION academy_administers()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM training_user_profiles p
        WHERE p.user_id = current_setting('app.current_user_id', true)
          AND p.active
          AND p.training_role::text = 'administrator'
    )
$function$;

CREATE OR REPLACE FUNCTION academy_manages()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM training_user_profiles p
        WHERE p.user_id = current_setting('app.current_user_id', true)
          AND p.active
          AND p.training_role::text IN ('administrator', 'supervisor')
    )
$function$;

CREATE OR REPLACE FUNCTION academy_supervises_group(p_group text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM training_user_profiles p
        JOIN assignment_groups g ON g.id = p_group
        WHERE p.user_id = current_setting('app.current_user_id', true)
          AND p.active
          AND p.training_role::text = 'supervisor'
          AND (
            g.supervisor_principal_id = p.id
            OR EXISTS (
              SELECT 1 FROM group_supervisors gs
              WHERE gs.group_id = g.id AND gs.supervisor_id = p.id
            )
          )
    )
$function$;

CREATE OR REPLACE FUNCTION academy_supervises_user(p_user text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM group_users gu
        WHERE gu.user_id = p_user AND academy_supervises_group(gu.group_id)
    )
$function$;

-- Policies, with the new names and the core's English helpers.
DROP POLICY IF EXISTS assignments_academy_manage ON assignments;
CREATE POLICY assignments_academy_manage ON assignments AS PERMISSIVE FOR ALL USING ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id)) OR ((group_id IS NOT NULL) AND academy_supervises_group(group_id)))) WITH CHECK ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id)) OR ((group_id IS NOT NULL) AND academy_supervises_group(group_id))));
DROP POLICY IF EXISTS assignments_de_group_lectura ON assignments;
DROP POLICY IF EXISTS assignments_group_select ON assignments;
CREATE POLICY assignments_group_select ON assignments AS PERMISSIVE FOR SELECT USING (((user_id IS NULL) AND (COALESCE(current_setting('app.current_user_id'::text, true), ''::text) <> ''::text)));
DROP POLICY IF EXISTS assignments_owner_isolation ON assignments;
CREATE POLICY assignments_owner_isolation ON assignments AS PERMISSIVE FOR ALL USING (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true)))) WITH CHECK (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true))));
DROP POLICY IF EXISTS learning_path_assignments_academy_manage ON learning_path_assignments;
CREATE POLICY learning_path_assignments_academy_manage ON learning_path_assignments AS PERMISSIVE FOR ALL USING ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id)))) WITH CHECK ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id))));
DROP POLICY IF EXISTS learning_path_assignments_owner_isolation ON learning_path_assignments;
CREATE POLICY learning_path_assignments_owner_isolation ON learning_path_assignments AS PERMISSIVE FOR ALL USING (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true)))) WITH CHECK (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true))));
DROP POLICY IF EXISTS certificates_academy_manage ON certificates;
CREATE POLICY certificates_academy_manage ON certificates AS PERMISSIVE FOR ALL USING ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id)))) WITH CHECK ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id))));
DROP POLICY IF EXISTS certificates_owner_isolation ON certificates;
CREATE POLICY certificates_owner_isolation ON certificates AS PERMISSIVE FOR ALL USING (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true)))) WITH CHECK (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true))));
DROP POLICY IF EXISTS satisfaction_surveys_academy_manage ON satisfaction_surveys;
CREATE POLICY satisfaction_surveys_academy_manage ON satisfaction_surveys AS PERMISSIVE FOR ALL USING ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id)))) WITH CHECK ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id))));
DROP POLICY IF EXISTS satisfaction_surveys_owner_isolation ON satisfaction_surveys;
CREATE POLICY satisfaction_surveys_owner_isolation ON satisfaction_surveys AS PERMISSIVE FOR ALL USING (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true)))) WITH CHECK (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true))));
DROP POLICY IF EXISTS feedback_academy_manage ON feedback;
CREATE POLICY feedback_academy_manage ON feedback AS PERMISSIVE FOR ALL USING ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id)))) WITH CHECK ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id))));
DROP POLICY IF EXISTS training_user_profiles_academy_manage ON training_user_profiles;
CREATE POLICY training_user_profiles_academy_manage ON training_user_profiles AS PERMISSIVE FOR ALL USING ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id)))) WITH CHECK ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id))));
DROP POLICY IF EXISTS training_user_profiles_owner_isolation ON training_user_profiles;
CREATE POLICY training_user_profiles_owner_isolation ON training_user_profiles AS PERMISSIVE FOR ALL USING (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true)))) WITH CHECK (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true))));
DROP POLICY IF EXISTS course_progress_academy_manage ON course_progress;
CREATE POLICY course_progress_academy_manage ON course_progress AS PERMISSIVE FOR ALL USING ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id)))) WITH CHECK ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id))));
DROP POLICY IF EXISTS course_progress_owner_isolation ON course_progress;
CREATE POLICY course_progress_owner_isolation ON course_progress AS PERMISSIVE FOR ALL USING (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true)))) WITH CHECK (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true))));
DROP POLICY IF EXISTS learning_path_progress_academy_manage ON learning_path_progress;
CREATE POLICY learning_path_progress_academy_manage ON learning_path_progress AS PERMISSIVE FOR ALL USING ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id)))) WITH CHECK ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id))));
DROP POLICY IF EXISTS learning_path_progress_owner_isolation ON learning_path_progress;
CREATE POLICY learning_path_progress_owner_isolation ON learning_path_progress AS PERMISSIVE FOR ALL USING (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true)))) WITH CHECK (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true))));
DROP POLICY IF EXISTS topic_progress_academy_manage ON topic_progress;
CREATE POLICY topic_progress_academy_manage ON topic_progress AS PERMISSIVE FOR ALL USING ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id)))) WITH CHECK ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id))));
DROP POLICY IF EXISTS topic_progress_owner_isolation ON topic_progress;
CREATE POLICY topic_progress_owner_isolation ON topic_progress AS PERMISSIVE FOR ALL USING (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true)))) WITH CHECK (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true))));
DROP POLICY IF EXISTS user_answers_academy_manage ON user_answers;
CREATE POLICY user_answers_academy_manage ON user_answers AS PERMISSIVE FOR ALL USING ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id)))) WITH CHECK ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id))));
DROP POLICY IF EXISTS user_answers_owner_isolation ON user_answers;
CREATE POLICY user_answers_owner_isolation ON user_answers AS PERMISSIVE FOR ALL USING (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true)))) WITH CHECK (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true))));
DROP POLICY IF EXISTS quiz_results_academy_manage ON quiz_results;
CREATE POLICY quiz_results_academy_manage ON quiz_results AS PERMISSIVE FOR ALL USING ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id)))) WITH CHECK ((academy_administers() OR ((user_id IS NOT NULL) AND academy_supervises_user(user_id))));
DROP POLICY IF EXISTS quiz_results_owner_isolation ON quiz_results;
CREATE POLICY quiz_results_owner_isolation ON quiz_results AS PERMISSIVE FOR ALL USING (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true)))) WITH CHECK (((((current_setting('app.current_user_id'::text, true) = ''::text) OR (current_setting('app.current_user_id'::text, true) IS NULL)) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true))));
