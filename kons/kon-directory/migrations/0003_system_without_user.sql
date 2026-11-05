-- 0003 — Directory: "system" means empty id AND role (2026-10-23)
-- ============================================================================
-- Idempotent: DROP POLICY IF EXISTS / CREATE OR REPLACE.
--
-- 0002_entry_security treated any context with an empty
-- `app.current_user_id` as the system. The kon set its own context and gave
-- anonymous users an id that matched nothing (`anonimo`), so it went unnoticed.
-- Since 2026-10-23 the HOST sets the context for every kon, following the
-- core's convention: an anonymous user carries id '' and role `anonymous`. With
-- 0002 they would have gone through these policies —and the trigger that
-- protects the HR fields— as if they were the system.
--
-- Active, visible records remain readable by anyone
-- (`directory_employees_lectura`), as in 0002: it is a directory.

DROP POLICY IF EXISTS directory_employees_lectura ON directory_employees;
CREATE POLICY directory_employees_lectura ON directory_employees
  FOR SELECT TO PUBLIC
  USING (
    (COALESCE(current_setting('app.current_user_id', true), '') = ''
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) = 'admin'
    OR (is_active AND coalesce(visible_in_directory, true))
    OR user_id = current_setting('app.current_user_id', true)
  );

DROP POLICY IF EXISTS directory_employees_alta ON directory_employees;
CREATE POLICY directory_employees_alta ON directory_employees
  FOR INSERT TO PUBLIC
  WITH CHECK (
    (COALESCE(current_setting('app.current_user_id', true), '') = ''
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) = 'admin'
  );

DROP POLICY IF EXISTS directory_employees_edicion ON directory_employees;
CREATE POLICY directory_employees_edicion ON directory_employees
  FOR UPDATE TO PUBLIC
  USING (
    (COALESCE(current_setting('app.current_user_id', true), '') = ''
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) = 'admin'
    OR user_id = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    (COALESCE(current_setting('app.current_user_id', true), '') = ''
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) = 'admin'
    OR user_id = current_setting('app.current_user_id', true)
  );

DROP POLICY IF EXISTS directory_employees_baja ON directory_employees;
CREATE POLICY directory_employees_baja ON directory_employees
  FOR DELETE TO PUBLIC
  USING (
    (COALESCE(current_setting('app.current_user_id', true), '') = ''
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) = 'admin'
  );

DROP POLICY IF EXISTS directory_documents_lectura ON directory_employee_documents;
CREATE POLICY directory_documents_lectura ON directory_employee_documents
  FOR SELECT TO PUBLIC
  USING (
    (COALESCE(current_setting('app.current_user_id', true), '') = ''
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) = 'admin'
    OR (
      NOT coalesce(is_confidential, false)
      AND EXISTS (
        SELECT 1 FROM directory_employees e
        WHERE e.id = directory_employee_documents.employee_id
          AND e.user_id = current_setting('app.current_user_id', true)
      )
    )
  );

DROP POLICY IF EXISTS directory_documents_escritura ON directory_employee_documents;
CREATE POLICY directory_documents_escritura ON directory_employee_documents
  FOR ALL TO PUBLIC
  USING (
    (COALESCE(current_setting('app.current_user_id', true), '') = ''
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) = 'admin'
  )
  WITH CHECK (
    (COALESCE(current_setting('app.current_user_id', true), '') = ''
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) = 'admin'
  );

-- The trigger that stops an employee from touching the HR fields of their own
-- record: same loophole, same fix.
CREATE OR REPLACE FUNCTION directory_proteger_campos_de_rrhh()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (COALESCE(current_setting('app.current_user_id', true), '') = ''
      AND COALESCE(current_setting('app.current_user_role', true), '') = '')
     OR current_setting('app.current_user_role', true) = 'admin' THEN
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
    RAISE EXCEPTION 'directory: solo RR. HH. cambia esos campos de una ficha'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
