-- English names for kon-directory: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS directory_documents_escritura ON directory_employee_documents;
DROP POLICY IF EXISTS directory_documents_lectura ON directory_employee_documents;
DROP POLICY IF EXISTS directory_employees_alta ON directory_employees;
DROP POLICY IF EXISTS directory_employees_baja ON directory_employees;
DROP POLICY IF EXISTS directory_employees_edicion ON directory_employees;
DROP POLICY IF EXISTS directory_employees_lectura ON directory_employees;

-- Functions whose name or parameters change.
DROP TRIGGER IF EXISTS directory_proteger_campos_de_rrhh ON directory_employees;
DROP FUNCTION IF EXISTS directory_proteger_campos_de_rrhh();

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:directory:listar-organizaciones":"kon:directory:list-organizations","directory:listar-organizaciones":"directory:list-organizations","directory__listar-organizaciones":"directory__list-organizations","kon:directory:crear-organizacion":"kon:directory:create-organization","directory:crear-organizacion":"directory:create-organization","directory__crear-organizacion":"directory__create-organization","kon:directory:ver-organizacion":"kon:directory:get-organization","directory:ver-organizacion":"directory:get-organization","directory__ver-organizacion":"directory__get-organization","kon:directory:listar-departamentos":"kon:directory:list-departments","directory:listar-departamentos":"directory:list-departments","directory__listar-departamentos":"directory__list-departments","kon:directory:crear-departamento":"kon:directory:create-department","directory:crear-departamento":"directory:create-department","directory__crear-departamento":"directory__create-department","kon:directory:ver-departamento":"kon:directory:get-department","directory:ver-departamento":"directory:get-department","directory__ver-departamento":"directory__get-department","kon:directory:listar-puestos":"kon:directory:list-positions","directory:listar-puestos":"directory:list-positions","directory__listar-puestos":"directory__list-positions","kon:directory:crear-puesto":"kon:directory:create-position","directory:crear-puesto":"directory:create-position","directory__crear-puesto":"directory__create-position","kon:directory:listar-empleados":"kon:directory:list-employees","directory:listar-empleados":"directory:list-employees","directory__listar-empleados":"directory__list-employees","kon:directory:crear-empleado":"kon:directory:create-employee","directory:crear-empleado":"directory:create-employee","directory__crear-empleado":"directory__create-employee","kon:directory:ver-empleado":"kon:directory:get-employee","directory:ver-empleado":"directory:get-employee","directory__ver-empleado":"directory__get-employee","kon:directory:editar-empleado":"kon:directory:update-employee","directory:editar-empleado":"directory:update-employee","directory__editar-empleado":"directory__update-employee","kon:directory:dar-de-baja-empleado":"kon:directory:offboard-employee","directory:dar-de-baja-empleado":"directory:offboard-employee","directory__dar-de-baja-empleado":"directory__offboard-employee","kon:directory:ver-organigrama":"kon:directory:get-org-chart","directory:ver-organigrama":"directory:get-org-chart","directory__ver-organigrama":"directory__get-org-chart","kon:directory:ver-cadena-de-mando":"kon:directory:get-reporting-chain","directory:ver-cadena-de-mando":"directory:get-reporting-chain","directory__ver-cadena-de-mando":"directory__get-reporting-chain","kon:directory:listar-documentos-de-empleado":"kon:directory:list-employee-documents","directory:listar-documentos-de-empleado":"directory:list-employee-documents","directory__listar-documentos-de-empleado":"directory__list-employee-documents","kon:directory:anadir-documento-de-empleado":"kon:directory:add-employee-document","directory:anadir-documento-de-empleado":"directory:add-employee-document","directory__anadir-documento-de-empleado":"directory__add-employee-document","kon:directory:buscar-en-directorio":"kon:directory:search-directory","directory:buscar-en-directorio":"directory:search-directory","directory__buscar-en-directorio":"directory__search-directory","kon:directory:ver-estadisticas-de-directorio":"kon:directory:get-directory-stats","directory:ver-estadisticas-de-directorio":"directory:get-directory-stats","directory__ver-estadisticas-de-directorio":"directory__get-directory-stats"}'::jsonb;
  ops jsonb := '{"listar-organizaciones":"list-organizations","crear-organizacion":"create-organization","ver-organizacion":"get-organization","listar-departamentos":"list-departments","crear-departamento":"create-department","ver-departamento":"get-department","listar-puestos":"list-positions","crear-puesto":"create-position","listar-empleados":"list-employees","crear-empleado":"create-employee","ver-empleado":"get-employee","editar-empleado":"update-employee","dar-de-baja-empleado":"offboard-employee","ver-organigrama":"get-org-chart","ver-cadena-de-mando":"get-reporting-chain","listar-documentos-de-empleado":"list-employee-documents","anadir-documento-de-empleado":"add-employee-document","buscar-en-directorio":"search-directory","ver-estadisticas-de-directorio":"get-directory-stats"}'::jsonb;
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('agent_identities', 'scopes'), ('agent_identities', 'allowed_tools'), ('agent_proposals', 'scopes'),
    ('oauth_authorization_requests', 'requested_scopes'), ('oauth_codes', 'scopes'), ('oauth_grants', 'scopes'), ('oauth_tokens', 'scopes')
  ) AS v(tbl, col) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t.tbl AND column_name = t.col) THEN
      EXECUTE format($f$
        UPDATE %1$I SET %2$I = (
          SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e) <> 'string' THEN e
                                         WHEN left(e #>> '{}', 1) = '!' THEN to_jsonb('!' || coalesce($1 ->> substr(e #>> '{}', 2), substr(e #>> '{}', 2)))
                                         ELSE to_jsonb(coalesce($1 ->> (e #>> '{}'), e #>> '{}')) END), '[]'::jsonb)
          FROM jsonb_array_elements(%2$I) AS e)
        WHERE jsonb_typeof(%2$I) = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(%2$I) AS e
          WHERE jsonb_typeof(e) = 'string' AND $1 ? ltrim(e #>> '{}', '!'))
      $f$, t.tbl, t.col) USING m;
    END IF;
  END LOOP;
  IF to_regclass('public.agent_proposals') IS NOT NULL THEN
    UPDATE agent_proposals SET
        operation_key = coalesce(m ->> operation_key, operation_key),
        tool = coalesce(m ->> tool, tool),
        operation_id = coalesce(ops ->> operation_id, operation_id)
      WHERE status = 'pending' AND (m ? coalesce(operation_key, '') OR m ? coalesce(tool, ''));
  END IF;
END $$;
