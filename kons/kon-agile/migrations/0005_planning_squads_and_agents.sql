-- kon-agile 1.3: planning, squads and agents as teammates.
--
-- New tables: squads and their members, checklist items, custom fields, saved views, initiatives,
-- notifications, and the agent work queue (what an agent was asked to do, and why).
-- New columns: archived issues, the initiative of an issue or module, where a cycle carried its
-- unfinished work.
--
-- The rule for agents, also enforced here so a route that forgets it still cannot write:
--   · an agent writes only on issues assigned to itself;
--   · if it is the scrum master of a squad, also on the issues of that squad's members and on
--     unassigned ones;
--   · it never changes the project's configuration (states, cycles, modules, labels, fields,
--     initiatives, squads) nor decides intakes: that stays with people.
-- An agent arrives with `app.current_user_role = 'agent'`. An agent key that acts AS a person
-- (`user:act`) arrives with that person's role and is treated as that person.
--
-- Idempotent.

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "agile_squads" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL REFERENCES "agile_projects"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "description" text,
    "scrum_master_id" text,
    "created_by" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "agile_squads_project_name_idx" ON "agile_squads" ("project_id", "name");
CREATE INDEX IF NOT EXISTS "agile_squads_scrum_master_idx" ON "agile_squads" ("project_id", "scrum_master_id");

CREATE TABLE IF NOT EXISTS "agile_squad_members" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "squad_id" uuid NOT NULL REFERENCES "agile_squads"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL,
    "added_by" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "agile_squad_members_unique_idx" ON "agile_squad_members" ("squad_id", "user_id");

CREATE TABLE IF NOT EXISTS "agile_initiatives" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL REFERENCES "agile_projects"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "description" text,
    "status" text DEFAULT 'planned' NOT NULL,
    "lead_id" text,
    "color" text DEFAULT '#6366f1',
    "start_date" timestamp with time zone,
    "target_date" timestamp with time zone,
    "created_by" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "agile_initiatives_status_check" CHECK ("status" IN ('planned', 'active', 'completed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS "agile_checklist_items" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "issue_id" uuid NOT NULL REFERENCES "agile_issues"("id") ON DELETE CASCADE,
    "text" text NOT NULL,
    "is_done" boolean DEFAULT false NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "done_by" text,
    "done_at" timestamp with time zone,
    "created_by" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "agile_checklist_items_issue_idx" ON "agile_checklist_items" ("issue_id", "sort_order");

CREATE TABLE IF NOT EXISTS "agile_custom_fields" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL REFERENCES "agile_projects"("id") ON DELETE CASCADE,
    "key" text NOT NULL,
    "name" text NOT NULL,
    "type" text NOT NULL,
    "options" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "is_required" boolean DEFAULT false NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "agile_custom_fields_type_check" CHECK ("type" IN ('text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'user', 'url'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "agile_custom_fields_project_key_idx" ON "agile_custom_fields" ("project_id", "key");

CREATE TABLE IF NOT EXISTS "agile_saved_views" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL REFERENCES "agile_projects"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "layout" text DEFAULT 'board' NOT NULL,
    "filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "group_by" text,
    "sub_group_by" text,
    "display" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "is_shared" boolean DEFAULT false NOT NULL,
    "owner_id" text NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "agile_saved_views_layout_check" CHECK ("layout" IN ('board', 'table', 'calendar', 'timeline'))
);
CREATE INDEX IF NOT EXISTS "agile_saved_views_project_idx" ON "agile_saved_views" ("project_id", "sort_order");

CREATE TABLE IF NOT EXISTS "agile_notifications" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL REFERENCES "agile_projects"("id") ON DELETE CASCADE,
    "issue_id" uuid REFERENCES "agile_issues"("id") ON DELETE CASCADE,
    "comment_id" uuid REFERENCES "agile_comments"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL,
    "actor_id" text,
    "kind" text NOT NULL,
    "message" text,
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "agile_notifications_kind_check" CHECK ("kind" IN ('mention', 'assigned', 'handoff', 'agent_work'))
);
CREATE INDEX IF NOT EXISTS "agile_notifications_user_idx" ON "agile_notifications" ("user_id", "read_at", "created_at");

-- What an agent was asked to do. The kon writes a row; the agent (its runner, or the core's run
-- queue when the kon can reach it) takes it, and marks it done with what it cost.
CREATE TABLE IF NOT EXISTS "agile_agent_work" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL REFERENCES "agile_projects"("id") ON DELETE CASCADE,
    "issue_id" uuid REFERENCES "agile_issues"("id") ON DELETE CASCADE,
    "agent_id" text NOT NULL,
    "trigger" text NOT NULL,
    "status" text DEFAULT 'queued' NOT NULL,
    "prompt" text,
    "requested_by" text,
    "schedule_id" uuid,
    "run_id" text,
    "result" text,
    "input_tokens" integer,
    "output_tokens" integer,
    "cost_usd" numeric(12, 6),
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "agile_agent_work_trigger_check" CHECK ("trigger" IN ('assigned', 'mention', 'handoff', 'schedule', 'manual')),
    CONSTRAINT "agile_agent_work_status_check" CHECK ("status" IN ('queued', 'running', 'done', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS "agile_agent_work_agent_idx" ON "agile_agent_work" ("agent_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "agile_agent_work_project_idx" ON "agile_agent_work" ("project_id", "created_at");

-- An agent that wakes on a schedule: every `interval_minutes`, with a prompt and the issues that
-- match `filters` (or none).
CREATE TABLE IF NOT EXISTS "agile_agent_schedules" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL REFERENCES "agile_projects"("id") ON DELETE CASCADE,
    "agent_id" text NOT NULL,
    "name" text NOT NULL,
    "prompt" text NOT NULL,
    "interval_minutes" integer NOT NULL,
    "filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "last_run_at" timestamp with time zone,
    "next_run_at" timestamp with time zone,
    "created_by" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "agile_agent_schedules_interval_check" CHECK ("interval_minutes" BETWEEN 15 AND 43200)
);
CREATE INDEX IF NOT EXISTS "agile_agent_schedules_due_idx" ON "agile_agent_schedules" ("is_active", "next_run_at");

-- ── Columns ─────────────────────────────────────────────────────────────────

-- Whether a member is an agent. The core gives a kon no lookup for an arbitrary id (agents live
-- in `agent_identities`), so whoever adds the member says it; work for an agent is queued only then.
ALTER TABLE "agile_project_members" ADD COLUMN IF NOT EXISTS "is_agent" boolean DEFAULT false NOT NULL;
ALTER TABLE "agile_issues" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
ALTER TABLE "agile_issues" ADD COLUMN IF NOT EXISTS "initiative_id" uuid;
ALTER TABLE "agile_modules" ADD COLUMN IF NOT EXISTS "initiative_id" uuid;
ALTER TABLE "agile_cycles" ADD COLUMN IF NOT EXISTS "carried_over_to_id" uuid;
ALTER TABLE "agile_cycles" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_issues_initiative_id_fk') THEN
        ALTER TABLE "agile_issues" ADD CONSTRAINT "agile_issues_initiative_id_fk"
            FOREIGN KEY ("initiative_id") REFERENCES "agile_initiatives"("id") ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_modules_initiative_id_fk') THEN
        ALTER TABLE "agile_modules" ADD CONSTRAINT "agile_modules_initiative_id_fk"
            FOREIGN KEY ("initiative_id") REFERENCES "agile_initiatives"("id") ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_cycles_carried_over_to_id_fk') THEN
        ALTER TABLE "agile_cycles" ADD CONSTRAINT "agile_cycles_carried_over_to_id_fk"
            FOREIGN KEY ("carried_over_to_id") REFERENCES "agile_cycles"("id") ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_agent_work_schedule_id_fk') THEN
        ALTER TABLE "agile_agent_work" ADD CONSTRAINT "agile_agent_work_schedule_id_fk"
            FOREIGN KEY ("schedule_id") REFERENCES "agile_agent_schedules"("id") ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "agile_issues_project_archived_idx" ON "agile_issues" ("project_id", "archived_at");
CREATE INDEX IF NOT EXISTS "agile_issues_parent_idx" ON "agile_issues" ("parent_id");
CREATE INDEX IF NOT EXISTS "agile_issues_assignee_idx" ON "agile_issues" ("project_id", "assignee_id");
CREATE INDEX IF NOT EXISTS "agile_activity_log_issue_idx" ON "agile_activity_log" ("issue_id", "created_at");
CREATE INDEX IF NOT EXISTS "agile_activity_log_project_idx" ON "agile_activity_log" ("project_id", "created_at");

-- ── Functions ───────────────────────────────────────────────────────────────
-- SECURITY DEFINER, like agile_project_role: they read squads without going through those tables'
-- RLS (no recursion) and only answer for the caller.

CREATE OR REPLACE FUNCTION agile_squad_project(s uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT project_id FROM agile_squads WHERE id = s
$function$;

CREATE OR REPLACE FUNCTION agile_caller_is_agent()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
    SELECT COALESCE(current_setting('app.current_user_role', true), '') = 'agent'
$function$;

-- May the caller write on an issue of project `p` assigned to `assignee`? Always yes for a person;
-- for an agent, only its own issues, or, as scrum master of a squad in that project, the issues of
-- the squad's members and unassigned ones.
CREATE OR REPLACE FUNCTION agile_agent_reach(p uuid, assignee text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT NOT agile_caller_is_agent()
        OR assignee = current_setting('app.current_user_id', true)
        OR EXISTS (
            SELECT 1 FROM agile_squads s
            WHERE s.project_id = p
              AND s.scrum_master_id = current_setting('app.current_user_id', true)
              AND (assignee IS NULL
                   OR EXISTS (SELECT 1 FROM agile_squad_members m
                              WHERE m.squad_id = s.id AND m.user_id = assignee))
        )
$function$;

CREATE OR REPLACE FUNCTION agile_agent_reach_issue(i uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT COALESCE((SELECT agile_agent_reach(project_id, assignee_id) FROM agile_issues WHERE id = i), false)
$function$;

-- ── Policies ────────────────────────────────────────────────────────────────

DO $$
DECLARE
    system_ctx text := '((COALESCE(current_setting(''app.current_user_id'', true), '''') = '''' '
        || 'AND COALESCE(current_setting(''app.current_user_role'', true), '''') = '''') '
        || 'OR current_setting(''app.current_user_role'', true) = ''admin'')';
    me text := 'current_setting(''app.current_user_id'', true)';
    t record;
    role_of text;
    reads text;
    writes text;
    person_writes text;
    ins text;
    upd_using text;
    upd_check text;
    del text;
BEGIN
    -- (table, expression that gives the row's project, kind)
    --   config: people with write rights; agents never
    --   issue:  issues themselves (agent reach on the assignee)
    --   child:  rows of an issue (agent reach on that issue)
    --   intake: proposed by anyone in the project, decided by people
    --   log:    appended by writers, never changed
    --   work:   the agent queue (requested by writers; an agent updates its own rows)
    FOR t IN
        SELECT * FROM (VALUES
            ('agile_states',          'project_id',                           'config'),
            ('agile_cycles',          'project_id',                           'config'),
            ('agile_modules',         'project_id',                           'config'),
            ('agile_labels',          'project_id',                           'config'),
            ('agile_estimates',       'project_id',                           'config'),
            ('agile_custom_fields',   'project_id',                           'config'),
            ('agile_initiatives',     'project_id',                           'config'),
            ('agile_squads',          'project_id',                           'config'),
            ('agile_squad_members',   'agile_squad_project(squad_id)',        'config'),
            ('agile_agent_schedules', 'project_id',                           'config'),
            ('agile_issues',          'project_id',                           'issue'),
            ('agile_comments',        'agile_issue_project(issue_id)',        'child'),
            ('agile_checklist_items', 'agile_issue_project(issue_id)',        'child'),
            ('agile_issue_labels',    'agile_issue_project(issue_id)',        'child'),
            ('agile_module_issues',   'agile_issue_project(issue_id)',        'child'),
            ('agile_issue_links',     'agile_issue_project(source_id)',       'link'),
            ('agile_intakes',         'project_id',                           'intake'),
            ('agile_activity_log',    'project_id',                           'log'),
            ('agile_agent_work',      'project_id',                           'work')
        ) AS v(tbl, project_expr, kind)
    LOOP
        role_of := format('agile_project_role(%s)', t.project_expr);
        reads := system_ctx || ' OR ' || role_of || ' IS NOT NULL';
        writes := system_ctx || ' OR ' || role_of || ' IN (''owner'', ''member'')';
        person_writes := system_ctx || ' OR (' || role_of || ' IN (''owner'', ''member'') AND NOT agile_caller_is_agent())';

        IF t.kind = 'config' THEN
            ins := person_writes; upd_using := person_writes; upd_check := person_writes; del := person_writes;
        ELSIF t.kind = 'issue' THEN
            ins := system_ctx || ' OR (' || role_of || ' IN (''owner'', ''member'') AND agile_agent_reach(project_id, assignee_id))';
            upd_using := ins;
            -- A hand-off moves the issue out of the agent's reach: the new row only needs a writer.
            upd_check := writes;
            del := person_writes;
        ELSIF t.kind = 'child' THEN
            ins := system_ctx || ' OR (' || role_of || ' IN (''owner'', ''member'') AND agile_agent_reach_issue(issue_id))';
            upd_using := ins; upd_check := ins; del := ins;
        ELSIF t.kind = 'link' THEN
            ins := system_ctx || ' OR (' || role_of || ' IN (''owner'', ''member'') AND agile_agent_reach_issue(source_id))';
            upd_using := ins; upd_check := ins; del := ins;
        ELSIF t.kind = 'intake' THEN
            ins := reads; upd_using := person_writes; upd_check := person_writes; del := person_writes;
        ELSIF t.kind = 'log' THEN
            ins := writes; upd_using := system_ctx; upd_check := system_ctx; del := system_ctx;
        ELSE -- work
            ins := writes;
            upd_using := system_ctx || ' OR (' || role_of || ' IN (''owner'', ''member'') AND (NOT agile_caller_is_agent() OR agent_id = ' || me || '))';
            upd_check := upd_using;
            del := person_writes;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = t.tbl) THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tbl);
            EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.tbl);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_agile_lee', t.tbl);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_agile_select', t.tbl);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_agile_insert', t.tbl);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_agile_update', t.tbl);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_agile_delete', t.tbl);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_agile_alta', t.tbl);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_agile_cambia', t.tbl);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_agile_borra', t.tbl);
            EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', t.tbl || '_agile_select', t.tbl, reads);
            EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', t.tbl || '_agile_insert', t.tbl, ins);
            EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', t.tbl || '_agile_update', t.tbl, upd_using, upd_check);
            EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', t.tbl || '_agile_delete', t.tbl, del);
        END IF;
    END LOOP;

    -- Saved views: a private one is its owner's; a shared one is the project's, and only people with
    -- write rights share or change it.
    EXECUTE 'ALTER TABLE agile_saved_views ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE agile_saved_views FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS agile_saved_views_agile_lee ON agile_saved_views';
    EXECUTE 'DROP POLICY IF EXISTS agile_saved_views_agile_select ON agile_saved_views';
    EXECUTE 'DROP POLICY IF EXISTS agile_saved_views_agile_insert ON agile_saved_views';
    EXECUTE 'DROP POLICY IF EXISTS agile_saved_views_agile_update ON agile_saved_views';
    EXECUTE 'DROP POLICY IF EXISTS agile_saved_views_agile_delete ON agile_saved_views';
    EXECUTE format('CREATE POLICY agile_saved_views_agile_select ON agile_saved_views FOR SELECT USING (%s OR (agile_project_role(project_id) IS NOT NULL AND (is_shared OR owner_id = %s)))', system_ctx, me);
    EXECUTE format('CREATE POLICY agile_saved_views_agile_insert ON agile_saved_views FOR INSERT WITH CHECK (%s OR (agile_project_role(project_id) IS NOT NULL AND owner_id = %s AND (NOT is_shared OR (agile_project_role(project_id) IN (''owner'', ''member'') AND NOT agile_caller_is_agent()))))', system_ctx, me);
    EXECUTE format('CREATE POLICY agile_saved_views_agile_update ON agile_saved_views FOR UPDATE USING (%1$s OR (agile_project_role(project_id) IS NOT NULL AND ((NOT is_shared AND owner_id = %2$s) OR (is_shared AND agile_project_role(project_id) IN (''owner'', ''member'') AND NOT agile_caller_is_agent())))) WITH CHECK (%1$s OR (agile_project_role(project_id) IS NOT NULL AND ((NOT is_shared AND owner_id = %2$s) OR (is_shared AND agile_project_role(project_id) IN (''owner'', ''member'') AND NOT agile_caller_is_agent()))))', system_ctx, me);
    EXECUTE format('CREATE POLICY agile_saved_views_agile_delete ON agile_saved_views FOR DELETE USING (%s OR (agile_project_role(project_id) IS NOT NULL AND ((NOT is_shared AND owner_id = %s) OR (is_shared AND agile_project_role(project_id) IN (''owner'', ''member'') AND NOT agile_caller_is_agent()))))', system_ctx, me);

    -- Notifications: each person (or agent) reads and clears their own; writers create them.
    EXECUTE 'ALTER TABLE agile_notifications ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE agile_notifications FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS agile_notifications_agile_lee ON agile_notifications';
    EXECUTE 'DROP POLICY IF EXISTS agile_notifications_agile_select ON agile_notifications';
    EXECUTE 'DROP POLICY IF EXISTS agile_notifications_agile_insert ON agile_notifications';
    EXECUTE 'DROP POLICY IF EXISTS agile_notifications_agile_update ON agile_notifications';
    EXECUTE 'DROP POLICY IF EXISTS agile_notifications_agile_delete ON agile_notifications';
    EXECUTE format('CREATE POLICY agile_notifications_agile_select ON agile_notifications FOR SELECT USING (%s OR user_id = %s)', system_ctx, me);
    EXECUTE format('CREATE POLICY agile_notifications_agile_insert ON agile_notifications FOR INSERT WITH CHECK (%s OR agile_project_role(project_id) IN (''owner'', ''member''))', system_ctx);
    EXECUTE format('CREATE POLICY agile_notifications_agile_update ON agile_notifications FOR UPDATE USING (%1$s OR user_id = %2$s) WITH CHECK (%1$s OR user_id = %2$s)', system_ctx, me);
    EXECUTE format('CREATE POLICY agile_notifications_agile_delete ON agile_notifications FOR DELETE USING (%s OR user_id = %s)', system_ctx, me);
END $$;
