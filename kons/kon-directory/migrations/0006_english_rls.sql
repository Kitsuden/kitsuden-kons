-- RLS for kon-directory after the English rename: functions, triggers and policies come back with the new names.
--
-- The previous file dropped the old ones; between both files the tables stay closed, not open.

-- Functions: their bodies are text, so a rename does not reach them.
CREATE OR REPLACE FUNCTION directory_protect_hr_fields()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (COALESCE(current_setting('app.current_user_id', true), '') = ''
      AND COALESCE(current_setting('app.current_user_role', true), '') = '')
     OR kitsuden_effective_admin('directory') THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.first_name IS DISTINCT FROM OLD.first_name
     OR NEW.last_name IS DISTINCT FROM OLD.last_name
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.work_email IS DISTINCT FROM OLD.work_email
     OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.position_id IS DISTINCT FROM OLD.position_id
     OR NEW.manager_id IS DISTINCT FROM OLD.manager_id
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.employment_type IS DISTINCT FROM OLD.employment_type
     OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.end_date IS DISTINCT FROM OLD.end_date
     OR NEW.birth_date IS DISTINCT FROM OLD.birth_date
     OR NEW.salary_band IS DISTINCT FROM OLD.salary_band
     OR NEW.custom_fields IS DISTINCT FROM OLD.custom_fields
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION 'directory: only HR may change those fields on an entry'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

-- Triggers.
DROP TRIGGER IF EXISTS directory_protect_hr_fields ON directory_employees;
CREATE TRIGGER directory_protect_hr_fields BEFORE UPDATE ON directory_employees FOR EACH ROW EXECUTE FUNCTION directory_protect_hr_fields();

-- Policies, with the new names and the core's English helpers.
DROP POLICY IF EXISTS directory_documents_escritura ON directory_employee_documents;
DROP POLICY IF EXISTS directory_documents_write ON directory_employee_documents;
CREATE POLICY directory_documents_write ON directory_employee_documents AS PERMISSIVE FOR ALL USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR kitsuden_effective_admin('directory'::text))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR kitsuden_effective_admin('directory'::text)));
DROP POLICY IF EXISTS directory_documents_lectura ON directory_employee_documents;
DROP POLICY IF EXISTS directory_documents_select ON directory_employee_documents;
CREATE POLICY directory_documents_select ON directory_employee_documents AS PERMISSIVE FOR SELECT USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR kitsuden_effective_admin('directory'::text) OR ((NOT COALESCE(is_confidential, false)) AND (EXISTS ( SELECT 1
   FROM directory_employees e
  WHERE ((e.id = directory_employee_documents.employee_id) AND (e.user_id = current_setting('app.current_user_id'::text, true))))))));
DROP POLICY IF EXISTS directory_employees_high ON directory_employees;
DROP POLICY IF EXISTS directory_employees_insert ON directory_employees;
CREATE POLICY directory_employees_insert ON directory_employees AS PERMISSIVE FOR INSERT WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR kitsuden_effective_admin('directory'::text)));
DROP POLICY IF EXISTS directory_employees_low ON directory_employees;
DROP POLICY IF EXISTS directory_employees_delete ON directory_employees;
CREATE POLICY directory_employees_delete ON directory_employees AS PERMISSIVE FOR DELETE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR kitsuden_effective_admin('directory'::text)));
DROP POLICY IF EXISTS directory_employees_edicion ON directory_employees;
DROP POLICY IF EXISTS directory_employees_update ON directory_employees;
CREATE POLICY directory_employees_update ON directory_employees AS PERMISSIVE FOR UPDATE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR kitsuden_effective_admin('directory'::text) OR (user_id = current_setting('app.current_user_id'::text, true)))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR kitsuden_effective_admin('directory'::text) OR (user_id = current_setting('app.current_user_id'::text, true))));
DROP POLICY IF EXISTS directory_employees_lectura ON directory_employees;
DROP POLICY IF EXISTS directory_employees_select ON directory_employees;
CREATE POLICY directory_employees_select ON directory_employees AS PERMISSIVE FOR SELECT USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR kitsuden_effective_admin('directory'::text) OR (is_active AND COALESCE(visible_in_directory, true)) OR (user_id = current_setting('app.current_user_id'::text, true))));
