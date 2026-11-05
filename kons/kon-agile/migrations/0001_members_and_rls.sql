-- ============================================================================
-- kon-agile — project members and RLS
-- ============================================================================
--
-- Until now any account with a session (sign-up is public) listed ALL
-- projects, read any issue by its key, commented, created issues in other
-- people's projects and approved anyone's intakes; and the GETs did not even
-- require a session. The only barrier was an "admin only" prefix outside the kon.
--
-- 1. `agile_project_members`: who is in each project and with which role
--    (owner / member / viewer). Whoever created the project is an implicit owner.
-- 2. RLS forced on every table of the kon:
--      read      → admin, or any role in the project
--      write     → admin, or owner/member (a viewer may also propose intakes)
--      members   → managed by the owner
--
-- Kitsuden convention: with an empty context (migrations, seeds) they fail
-- OPEN; the kon sets the context on every request (contexto-rls.ts).
-- The functions are SECURITY DEFINER: they run as the owner (the role that
-- migrates, superuser in production), so they read membership without going
-- through the RLS of those same tables (no recursion) and only answer for
-- THE CALLER.
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "agile_project_members" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL,
    "user_id" text NOT NULL,
    "role" text DEFAULT 'member' NOT NULL,
    "added_by" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "agile_project_members_role_check" CHECK ("role" IN ('owner', 'member', 'viewer'))
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'agile_project_members_project_id_agile_projects_id_fk') THEN
        ALTER TABLE "agile_project_members"
            ADD CONSTRAINT "agile_project_members_project_id_agile_projects_id_fk"
            FOREIGN KEY ("project_id") REFERENCES "agile_projects"("id") ON DELETE cascade;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "agile_project_members_project_user_idx"
    ON "agile_project_members" USING btree ("project_id", "user_id");

-- Projects that already existed keep their creator as owner.
INSERT INTO "agile_project_members" ("project_id", "user_id", "role", "added_by")
SELECT p."id", p."created_by", 'owner', 'migracion-0001'
FROM "agile_projects" p
WHERE p."created_by" IS NOT NULL AND p."created_by" <> ''
ON CONFLICT ("project_id", "user_id") DO NOTHING;

-- The caller's role in a project (or NULL if they are not in it).
CREATE OR REPLACE FUNCTION agile_rol_en_proyecto(p uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public
AS $$
    SELECT CASE
        WHEN EXISTS (SELECT 1 FROM agile_projects
                     WHERE id = p
                       AND created_by = current_setting('app.current_user_id', true))
            THEN 'owner'
        ELSE (SELECT role FROM agile_project_members
              WHERE project_id = p
                AND user_id = current_setting('app.current_user_id', true))
    END
$$;

-- Project of an issue (for the tables that hang off the issue).
CREATE OR REPLACE FUNCTION agile_proyecto_de_issue(i uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public
AS $$
    SELECT project_id FROM agile_issues WHERE id = i
$$;

DO $$
DECLARE
    sistema text := '(current_setting(''app.current_user_id'', true) IS NULL '
        || 'OR current_setting(''app.current_user_id'', true) = '''' '
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
