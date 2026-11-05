-- 0002 — Agile: "system" means empty id AND empty role (2026-10-23)
-- ============================================================================
-- Idempotent: recreates ALL the policies of 0001_members_and_rls with the strict
-- condition. The body is the same block as 0001_members_and_rls; only `sistema` changes.
--
-- 0001_members_and_rls treated any context with an empty `app.current_user_id` as
-- the system. While the kon opened its own RLS transaction only for requests
-- WITH a user this did not matter: the anonymous user never reached the database.
-- Since 2026-10-23 the HOST opens the RLS transaction for every request to a kon,
-- and the anonymous user carries id '' and role `anonymous`: with 0001_members_and_rls
-- it would pass these policies as if it were the system. It is the same hatch the
-- core closed in rls-owned-tables.sql.

DO $$
DECLARE
    -- System = empty id AND empty role (the anonymous user of a request carries
    -- role `anonymous` and NO longer passes here), or admin.
    sistema text := '((COALESCE(current_setting(''app.current_user_id'', true), '''') = '''' '
        || 'AND COALESCE(current_setting(''app.current_user_role'', true), '''') = '''') '
        || 'OR current_setting(''app.current_user_role'', true) = ''admin'')';
    t record;
    rol text;
    lee text;
    escribe text;
    propone text;
BEGIN
    -- (table, expression that gives the row's project)
    FOR t IN
        SELECT * FROM (VALUES
            ('agile_states',         'project_id'),
            ('agile_issues',         'project_id'),
            ('agile_cycles',         'project_id'),
            ('agile_modules',        'project_id'),
            ('agile_intakes',        'project_id'),
            ('agile_labels',         'project_id'),
            ('agile_estimates',      'project_id'),
            ('agile_activity_log',   'project_id'),
            ('agile_comments',       'agile_proyecto_de_issue(issue_id)'),
            ('agile_module_issues',  'agile_proyecto_de_issue(issue_id)'),
            ('agile_issue_labels',   'agile_proyecto_de_issue(issue_id)'),
            ('agile_issue_links',    'agile_proyecto_de_issue(source_id)')
        ) AS v(tabla, proyecto)
    LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = t.tabla) THEN
            rol := format('agile_rol_en_proyecto(%s)', t.proyecto);
            lee := sistema || ' OR ' || rol || ' IS NOT NULL';
            escribe := sistema || ' OR ' || rol || ' IN (''owner'', ''member'')';
            -- An intake is a PROPOSAL: someone who only views can make one too.
            propone := CASE WHEN t.tabla = 'agile_intakes' THEN lee ELSE escribe END;

            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tabla);
            EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.tabla);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tabla || '_agile_lee', t.tabla);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tabla || '_agile_alta', t.tabla);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tabla || '_agile_cambia', t.tabla);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tabla || '_agile_borra', t.tabla);
            EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)',
                t.tabla || '_agile_lee', t.tabla, lee);
            EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)',
                t.tabla || '_agile_alta', t.tabla, propone);
            EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',
                t.tabla || '_agile_cambia', t.tabla, escribe, escribe);
            EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)',
                t.tabla || '_agile_borra', t.tabla, escribe);
        END IF;
    END LOOP;

    -- Projects: seen by their members; created by whoever is listed as creator;
    -- changed by an owner/member (the key counter goes up when an issue is created).
    EXECUTE 'ALTER TABLE agile_projects ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE agile_projects FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS agile_projects_agile_lee ON agile_projects';
    EXECUTE 'DROP POLICY IF EXISTS agile_projects_agile_alta ON agile_projects';
    EXECUTE 'DROP POLICY IF EXISTS agile_projects_agile_cambia ON agile_projects';
    EXECUTE 'DROP POLICY IF EXISTS agile_projects_agile_borra ON agile_projects';
    EXECUTE format('CREATE POLICY agile_projects_agile_lee ON agile_projects FOR SELECT USING (%s OR created_by = current_setting(''app.current_user_id'', true) OR agile_rol_en_proyecto(id) IS NOT NULL)', sistema);
    EXECUTE format('CREATE POLICY agile_projects_agile_alta ON agile_projects FOR INSERT WITH CHECK (%s OR created_by = current_setting(''app.current_user_id'', true))', sistema);
    EXECUTE format('CREATE POLICY agile_projects_agile_cambia ON agile_projects FOR UPDATE USING (%s OR agile_rol_en_proyecto(id) IN (''owner'', ''member'')) WITH CHECK (%s OR agile_rol_en_proyecto(id) IN (''owner'', ''member''))', sistema, sistema);
    EXECUTE format('CREATE POLICY agile_projects_agile_borra ON agile_projects FOR DELETE USING (%s OR agile_rol_en_proyecto(id) = ''owner'')', sistema);

    -- Members: seen by whoever is in the project; managed by the owner.
    EXECUTE 'ALTER TABLE agile_project_members ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE agile_project_members FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS agile_project_members_agile_lee ON agile_project_members';
    EXECUTE 'DROP POLICY IF EXISTS agile_project_members_agile_gestiona ON agile_project_members';
    EXECUTE format('CREATE POLICY agile_project_members_agile_lee ON agile_project_members FOR SELECT USING (%s OR agile_rol_en_proyecto(project_id) IS NOT NULL)', sistema);
    EXECUTE format('CREATE POLICY agile_project_members_agile_gestiona ON agile_project_members FOR ALL USING (%s OR agile_rol_en_proyecto(project_id) = ''owner'') WITH CHECK (%s OR agile_rol_en_proyecto(project_id) = ''owner'')', sistema, sistema);
END $$;
