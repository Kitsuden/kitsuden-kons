-- English names for kon-agile: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS agile_activity_log_agile_alta ON agile_activity_log;
DROP POLICY IF EXISTS agile_activity_log_agile_borra ON agile_activity_log;
DROP POLICY IF EXISTS agile_activity_log_agile_cambia ON agile_activity_log;
DROP POLICY IF EXISTS agile_activity_log_agile_lee ON agile_activity_log;
DROP POLICY IF EXISTS agile_comments_agile_alta ON agile_comments;
DROP POLICY IF EXISTS agile_comments_agile_borra ON agile_comments;
DROP POLICY IF EXISTS agile_comments_agile_cambia ON agile_comments;
DROP POLICY IF EXISTS agile_comments_agile_lee ON agile_comments;
DROP POLICY IF EXISTS agile_cycles_agile_alta ON agile_cycles;
DROP POLICY IF EXISTS agile_cycles_agile_borra ON agile_cycles;
DROP POLICY IF EXISTS agile_cycles_agile_cambia ON agile_cycles;
DROP POLICY IF EXISTS agile_cycles_agile_lee ON agile_cycles;
DROP POLICY IF EXISTS agile_estimates_agile_alta ON agile_estimates;
DROP POLICY IF EXISTS agile_estimates_agile_borra ON agile_estimates;
DROP POLICY IF EXISTS agile_estimates_agile_cambia ON agile_estimates;
DROP POLICY IF EXISTS agile_estimates_agile_lee ON agile_estimates;
DROP POLICY IF EXISTS agile_intakes_agile_alta ON agile_intakes;
DROP POLICY IF EXISTS agile_intakes_agile_borra ON agile_intakes;
DROP POLICY IF EXISTS agile_intakes_agile_cambia ON agile_intakes;
DROP POLICY IF EXISTS agile_intakes_agile_lee ON agile_intakes;
DROP POLICY IF EXISTS agile_issue_labels_agile_alta ON agile_issue_labels;
DROP POLICY IF EXISTS agile_issue_labels_agile_borra ON agile_issue_labels;
DROP POLICY IF EXISTS agile_issue_labels_agile_cambia ON agile_issue_labels;
DROP POLICY IF EXISTS agile_issue_labels_agile_lee ON agile_issue_labels;
DROP POLICY IF EXISTS agile_issue_links_agile_alta ON agile_issue_links;
DROP POLICY IF EXISTS agile_issue_links_agile_borra ON agile_issue_links;
DROP POLICY IF EXISTS agile_issue_links_agile_cambia ON agile_issue_links;
DROP POLICY IF EXISTS agile_issue_links_agile_lee ON agile_issue_links;
DROP POLICY IF EXISTS agile_issues_agile_alta ON agile_issues;
DROP POLICY IF EXISTS agile_issues_agile_borra ON agile_issues;
DROP POLICY IF EXISTS agile_issues_agile_cambia ON agile_issues;
DROP POLICY IF EXISTS agile_issues_agile_lee ON agile_issues;
DROP POLICY IF EXISTS agile_labels_agile_alta ON agile_labels;
DROP POLICY IF EXISTS agile_labels_agile_borra ON agile_labels;
DROP POLICY IF EXISTS agile_labels_agile_cambia ON agile_labels;
DROP POLICY IF EXISTS agile_labels_agile_lee ON agile_labels;
DROP POLICY IF EXISTS agile_module_issues_agile_alta ON agile_module_issues;
DROP POLICY IF EXISTS agile_module_issues_agile_borra ON agile_module_issues;
DROP POLICY IF EXISTS agile_module_issues_agile_cambia ON agile_module_issues;
DROP POLICY IF EXISTS agile_module_issues_agile_lee ON agile_module_issues;
DROP POLICY IF EXISTS agile_modules_agile_alta ON agile_modules;
DROP POLICY IF EXISTS agile_modules_agile_borra ON agile_modules;
DROP POLICY IF EXISTS agile_modules_agile_cambia ON agile_modules;
DROP POLICY IF EXISTS agile_modules_agile_lee ON agile_modules;
DROP POLICY IF EXISTS agile_project_members_agile_gestiona ON agile_project_members;
DROP POLICY IF EXISTS agile_project_members_agile_lee ON agile_project_members;
DROP POLICY IF EXISTS agile_projects_agile_alta ON agile_projects;
DROP POLICY IF EXISTS agile_projects_agile_borra ON agile_projects;
DROP POLICY IF EXISTS agile_projects_agile_cambia ON agile_projects;
DROP POLICY IF EXISTS agile_projects_agile_lee ON agile_projects;
DROP POLICY IF EXISTS agile_states_agile_alta ON agile_states;
DROP POLICY IF EXISTS agile_states_agile_borra ON agile_states;
DROP POLICY IF EXISTS agile_states_agile_cambia ON agile_states;
DROP POLICY IF EXISTS agile_states_agile_lee ON agile_states;

-- Functions whose name or parameters change.
DROP FUNCTION IF EXISTS agile_proyecto_de_issue(uuid);
DROP FUNCTION IF EXISTS agile_rol_en_proyecto(uuid);

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"agile:crear-proyecto":"agile:create-project","kon:agile:leer-tablero":"kon:agile:get-board","agile:leer-tablero":"agile:get-board","agile__leer-tablero":"agile__get-board","kon:agile:proponer-intake":"kon:agile:propose-intake","agile:proponer-intake":"agile:propose-intake","agile__proponer-intake":"agile__propose-intake","kon:agile:listar-proyectos":"kon:agile:list-projects","agile:listar-proyectos":"agile:list-projects","agile__listar-proyectos":"agile__list-projects","kon:agile:crear-proyecto":"kon:agile:create-project","agile__crear-proyecto":"agile__create-project","kon:agile:ver-proyecto":"kon:agile:get-project","agile:ver-proyecto":"agile:get-project","agile__ver-proyecto":"agile__get-project","kon:agile:listar-miembros-de-proyecto":"kon:agile:list-project-members","agile:listar-miembros-de-proyecto":"agile:list-project-members","agile__listar-miembros-de-proyecto":"agile__list-project-members","kon:agile:anadir-miembro-a-proyecto":"kon:agile:add-project-member","agile:anadir-miembro-a-proyecto":"agile:add-project-member","agile__anadir-miembro-a-proyecto":"agile__add-project-member","kon:agile:quitar-miembro-de-proyecto":"kon:agile:remove-project-member","agile:quitar-miembro-de-proyecto":"agile:remove-project-member","agile__quitar-miembro-de-proyecto":"agile__remove-project-member","kon:agile:ver-issue":"kon:agile:get-issue","agile:ver-issue":"agile:get-issue","agile__ver-issue":"agile__get-issue","kon:agile:editar-issue":"kon:agile:update-issue","agile:editar-issue":"agile:update-issue","agile__editar-issue":"agile__update-issue","kon:agile:listar-comentarios-de-issue":"kon:agile:list-issue-comments","agile:listar-comentarios-de-issue":"agile:list-issue-comments","agile__listar-comentarios-de-issue":"agile__list-issue-comments","kon:agile:comentar-issue":"kon:agile:comment-issue","agile:comentar-issue":"agile:comment-issue","agile__comentar-issue":"agile__comment-issue","kon:agile:aprobar-intake":"kon:agile:approve-intake","agile:aprobar-intake":"agile:approve-intake","agile__aprobar-intake":"agile__approve-intake","kon:agile:rechazar-intake":"kon:agile:reject-intake","agile:rechazar-intake":"agile:reject-intake","agile__rechazar-intake":"agile__reject-intake","kon:agile:marcar-intake-duplicado":"kon:agile:mark-intake-duplicate","agile:marcar-intake-duplicado":"agile:mark-intake-duplicate","agile__marcar-intake-duplicado":"agile__mark-intake-duplicate","kon:agile:aprobar-intake-de-tabla":"kon:agile:approve-table-intake","agile:aprobar-intake-de-tabla":"agile:approve-table-intake","agile__aprobar-intake-de-tabla":"agile__approve-table-intake","kon:agile:rechazar-intake-de-tabla":"kon:agile:reject-table-intake","agile:rechazar-intake-de-tabla":"agile:reject-table-intake","agile__rechazar-intake-de-tabla":"agile__reject-table-intake","kon:agile:convertir-intake-de-tabla":"kon:agile:convert-table-intake","agile:convertir-intake-de-tabla":"agile:convert-table-intake","agile__convertir-intake-de-tabla":"agile__convert-table-intake","kon:agile:listar-issues":"kon:agile:list-issues","agile:listar-issues":"agile:list-issues","agile__listar-issues":"agile__list-issues","kon:agile:crear-issue":"kon:agile:create-issue","agile:crear-issue":"agile:create-issue","agile__crear-issue":"agile__create-issue","kon:agile:listar-intakes":"kon:agile:list-intakes","agile:listar-intakes":"agile:list-intakes","agile__listar-intakes":"agile__list-intakes","kon:agile:listar-ciclos":"kon:agile:list-cycles","agile:listar-ciclos":"agile:list-cycles","agile__listar-ciclos":"agile__list-cycles","kon:agile:crear-ciclo":"kon:agile:create-cycle","agile:crear-ciclo":"agile:create-cycle","agile__crear-ciclo":"agile__create-cycle","kon:agile:listar-modulos":"kon:agile:list-modules","agile:listar-modulos":"agile:list-modules","agile__listar-modulos":"agile__list-modules","kon:agile:crear-modulo":"kon:agile:create-module","agile:crear-modulo":"agile:create-module","agile__crear-modulo":"agile__create-module"}'::jsonb;
  ops jsonb := '{"leer-tablero":"get-board","proponer-intake":"propose-intake","listar-proyectos":"list-projects","crear-proyecto":"create-project","ver-proyecto":"get-project","listar-miembros-de-proyecto":"list-project-members","anadir-miembro-a-proyecto":"add-project-member","quitar-miembro-de-proyecto":"remove-project-member","ver-issue":"get-issue","editar-issue":"update-issue","listar-comentarios-de-issue":"list-issue-comments","comentar-issue":"comment-issue","aprobar-intake":"approve-intake","rechazar-intake":"reject-intake","marcar-intake-duplicado":"mark-intake-duplicate","aprobar-intake-de-tabla":"approve-table-intake","rechazar-intake-de-tabla":"reject-table-intake","convertir-intake-de-tabla":"convert-table-intake","listar-issues":"list-issues","crear-issue":"create-issue","listar-intakes":"list-intakes","listar-ciclos":"list-cycles","crear-ciclo":"create-cycle","listar-modulos":"list-modules","crear-modulo":"create-module"}'::jsonb;
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
