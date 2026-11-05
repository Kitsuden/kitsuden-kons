-- Directory security (review 2026-10-15)
-- ----------------------------------------------------------------------------
--
-- 1. `user_id` and `uploaded_by_id` become `text`: `auth_users.id` (better-auth)
--    is text and its ids are not UUID-shaped, so linking an employee record to
--    its account —which is what enables "my record"— could not be done.
--
-- 2. Row-level RLS on employee records and their documents. The kon sets the
--    context on every request (directory.context.ts). Which COLUMNS each user
--    sees is decided by the kon's projection; here we decide which ROWS exist
--    for each user:
--      · records: HR (admin) sees all; everyone else, the active and visible
--        ones plus their own. Writing: admin (or system); the employee can only
--        UPDATE their own, and a trigger stops them from touching HR columns.
--      · documents: admin; the employee, their own NON-confidential ones. Only
--        admin writes them.
--
-- With an empty context (migrations, workers) everything passes, as in the rest
-- of Kitsuden. An anonymous user does NOT go with an empty context: the kon
-- gives it the 'anonymous' role.

DROP POLICY IF EXISTS directory_employees_lectura ON directory_employees;
DROP POLICY IF EXISTS directory_employees_alta ON directory_employees;
DROP POLICY IF EXISTS directory_employees_edicion ON directory_employees;
DROP POLICY IF EXISTS directory_employees_baja ON directory_employees;
DROP POLICY IF EXISTS directory_documents_lectura ON directory_employee_documents;
DROP POLICY IF EXISTS directory_documents_escritura ON directory_employee_documents;

ALTER TABLE directory_employees ALTER COLUMN user_id TYPE text USING user_id::text;
ALTER TABLE directory_employee_documents ALTER COLUMN uploaded_by_id TYPE text USING uploaded_by_id::text;

ALTER TABLE directory_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_employees FORCE ROW LEVEL SECURITY;
ALTER TABLE directory_employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_employee_documents FORCE ROW LEVEL SECURITY;

-- ── Employee records ────────────────────────────────────────────────────────

CREATE POLICY directory_employees_lectura ON directory_employees
  FOR SELECT TO PUBLIC
  USING (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_role', true) = 'admin'
    OR (is_active AND coalesce(visible_in_directory, true))
    OR user_id = current_setting('app.current_user_id', true)
  );

CREATE POLICY directory_employees_alta ON directory_employees
  FOR INSERT TO PUBLIC
  WITH CHECK (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_role', true) = 'admin'
  );

CREATE POLICY directory_employees_edicion ON directory_employees
  FOR UPDATE TO PUBLIC
  USING (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_role', true) = 'admin'
    OR user_id = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_role', true) = 'admin'
    OR user_id = current_setting('app.current_user_id', true)
  );

CREATE POLICY directory_employees_baja ON directory_employees
  FOR DELETE TO PUBLIC
  USING (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_role', true) = 'admin'
  );

-- Someone who edits their own record without being admin does NOT change what
-- belongs to HR: not their position, their manager, their salary band, or which
-- account the record is linked to.
CREATE OR REPLACE FUNCTION directory_proteger_campos_de_rrhh()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF coalesce(current_setting('app.current_user_id', true), '') = ''
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

DROP TRIGGER IF EXISTS directory_proteger_campos_de_rrhh ON directory_employees;
CREATE TRIGGER directory_proteger_campos_de_rrhh
  BEFORE UPDATE ON directory_employees
  FOR EACH ROW EXECUTE FUNCTION directory_proteger_campos_de_rrhh();

-- ── Documents ───────────────────────────────────────────────────────────────

CREATE POLICY directory_documents_lectura ON directory_employee_documents
  FOR SELECT TO PUBLIC
  USING (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
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

CREATE POLICY directory_documents_escritura ON directory_employee_documents
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_role', true) = 'admin'
  )
  WITH CHECK (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_role', true) = 'admin'
  );
