-- kon-agile 1.4: attachments, subscribers, reactions, time, GitHub and full-text search.
--
-- New tables:
--   · agile_issue_attachments    a file of the core's media library hung on an issue;
--   · agile_issue_subscribers    who hears about an issue's comments and state changes;
--   · agile_time_entries         minutes a person logged on an issue;
--   · agile_github_repos         repositories connected to a project (sealed webhook secret);
--   · agile_issue_pull_requests  the pull requests that mention an issue.
-- New columns: `search_vector` on issues and comments (generated), for `search`.
-- New function: agile_toggle_reaction, so any member reacts to a comment without the right to edit it.
--
-- The rule for agents (0005) holds here too: an agent attaches files and logs time only on issues in
-- its reach, and never connects a repository.
--
-- Idempotent.

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "agile_issue_attachments" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "issue_id" uuid NOT NULL REFERENCES "agile_issues"("id") ON DELETE CASCADE,
    "media_id" uuid NOT NULL,
    "name" text NOT NULL,
    "mime_type" text,
    "size" integer,
    "created_by" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "agile_issue_attachments_issue_media_idx" ON "agile_issue_attachments" ("issue_id", "media_id");

CREATE TABLE IF NOT EXISTS "agile_issue_subscribers" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "issue_id" uuid NOT NULL REFERENCES "agile_issues"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "agile_issue_subscribers_issue_user_idx" ON "agile_issue_subscribers" ("issue_id", "user_id");
CREATE INDEX IF NOT EXISTS "agile_issue_subscribers_user_idx" ON "agile_issue_subscribers" ("user_id");

CREATE TABLE IF NOT EXISTS "agile_time_entries" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL REFERENCES "agile_projects"("id") ON DELETE CASCADE,
    "issue_id" uuid NOT NULL REFERENCES "agile_issues"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL,
    "minutes" integer NOT NULL CHECK ("minutes" > 0 AND "minutes" <= 1440),
    "spent_on" text NOT NULL,
    "note" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "agile_time_entries_issue_idx" ON "agile_time_entries" ("issue_id", "spent_on");
CREATE INDEX IF NOT EXISTS "agile_time_entries_project_idx" ON "agile_time_entries" ("project_id", "user_id", "spent_on");

CREATE TABLE IF NOT EXISTS "agile_github_repos" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL REFERENCES "agile_projects"("id") ON DELETE CASCADE,
    "repo" text NOT NULL,
    "webhook_secret" jsonb NOT NULL,
    "close_on_merge" boolean DEFAULT true NOT NULL,
    "created_by" text NOT NULL,
    "last_delivery_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "agile_github_repos_project_repo_idx" ON "agile_github_repos" ("project_id", "repo");

CREATE TABLE IF NOT EXISTS "agile_issue_pull_requests" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "issue_id" uuid NOT NULL REFERENCES "agile_issues"("id") ON DELETE CASCADE,
    "repo_id" uuid NOT NULL REFERENCES "agile_github_repos"("id") ON DELETE CASCADE,
    "number" integer NOT NULL,
    "title" text NOT NULL,
    "url" text NOT NULL,
    "state" text NOT NULL,
    "author" text,
    "closes_issue" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "agile_issue_pull_requests_issue_pr_idx" ON "agile_issue_pull_requests" ("issue_id", "repo_id", "number");

-- ── Notifications for subscribers ───────────────────────────────────────────
-- Two new kinds: a comment and a state change on an issue the member follows.

ALTER TABLE "agile_notifications" DROP CONSTRAINT IF EXISTS "agile_notifications_kind_check";
ALTER TABLE "agile_notifications" ADD CONSTRAINT "agile_notifications_kind_check"
    CHECK ("kind" IN ('mention', 'assigned', 'handoff', 'agent_work', 'comment', 'state_changed'));

-- ── Full-text search ────────────────────────────────────────────────────────
-- `simple`: no language stemming, so a key (`PLAT-12`), a name and an English or Spanish word all
-- match as written. Generated columns: nothing to keep in sync by hand.

ALTER TABLE "agile_issues" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce("key", '') || ' ' || coalesce("name", '')), 'A')
        || setweight(to_tsvector('simple', coalesce("description_text", '')), 'B')
    ) STORED;
CREATE INDEX IF NOT EXISTS "agile_issues_search_idx" ON "agile_issues" USING gin ("search_vector");

ALTER TABLE "agile_comments" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce("content_text", ''))) STORED;
CREATE INDEX IF NOT EXISTS "agile_comments_search_idx" ON "agile_comments" USING gin ("search_vector");

-- ── Reactions ───────────────────────────────────────────────────────────────
-- Any member (viewers and agents too) reacts to a comment of a project they are in, for themselves.
-- Editing a comment stays with writers (0005), so this goes through a definer function that only
-- toggles the caller's own id under one emoji. Returns the comment's reactions after the change,
-- or NULL when the caller cannot see the comment.

CREATE OR REPLACE FUNCTION agile_toggle_reaction(c uuid, emoji text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    me text := current_setting('app.current_user_id', true);
    current_list jsonb;
    result jsonb;
BEGIN
    IF COALESCE(me, '') = '' OR emoji IS NULL OR length(emoji) = 0 OR length(emoji) > 32 THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM agile_comments k
        WHERE k.id = c AND agile_project_role(agile_issue_project(k.issue_id)) IS NOT NULL
    ) THEN
        RETURN NULL;
    END IF;
    SELECT COALESCE(reactions -> emoji, '[]'::jsonb) INTO current_list FROM agile_comments WHERE id = c;
    IF current_list ? me THEN
        current_list := (SELECT COALESCE(jsonb_agg(v), '[]'::jsonb) FROM jsonb_array_elements_text(current_list) v WHERE v <> me);
    ELSE
        current_list := current_list || to_jsonb(me);
    END IF;
    UPDATE agile_comments
       SET reactions = CASE
               WHEN jsonb_array_length(current_list) = 0 THEN COALESCE(reactions, '{}'::jsonb) - emoji
               ELSE jsonb_set(COALESCE(reactions, '{}'::jsonb), ARRAY[emoji], current_list, true)
           END
     WHERE id = c
     RETURNING reactions INTO result;
    RETURN result;
END;
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
    in_reach text;
    ins text;
    upd text;
    del text;
BEGIN
    -- (table, expression that gives the row's project, kind)
    --   child:      rows of an issue, written by writers and agents in reach (attachments)
    --   subscriber: each member subscribes itself; writers subscribe others (an assignee)
    --   time:       each one logs its own time on issues in its reach; people with write rights fix any
    --   config:     people with write rights only (GitHub repositories)
    --   synced:     written by the system (the GitHub webhook); people with write rights may remove
    FOR t IN
        SELECT * FROM (VALUES
            ('agile_issue_attachments',   'agile_issue_project(issue_id)', 'child'),
            ('agile_issue_subscribers',   'agile_issue_project(issue_id)', 'subscriber'),
            ('agile_time_entries',        'project_id',                    'time'),
            ('agile_github_repos',        'project_id',                    'config'),
            ('agile_issue_pull_requests', 'agile_issue_project(issue_id)', 'synced')
        ) AS v(tbl, project_expr, kind)
    LOOP
        role_of := format('agile_project_role(%s)', t.project_expr);
        reads := system_ctx || ' OR ' || role_of || ' IS NOT NULL';
        writes := system_ctx || ' OR ' || role_of || ' IN (''owner'', ''member'')';
        person_writes := system_ctx || ' OR (' || role_of || ' IN (''owner'', ''member'') AND NOT agile_caller_is_agent())';
        in_reach := system_ctx || ' OR (' || role_of || ' IN (''owner'', ''member'') AND agile_agent_reach_issue(issue_id))';

        IF t.kind = 'child' THEN
            ins := in_reach; upd := in_reach; del := in_reach;
        ELSIF t.kind = 'subscriber' THEN
            ins := writes || ' OR (' || role_of || ' IS NOT NULL AND user_id = ' || me || ')';
            upd := system_ctx;
            del := person_writes || ' OR (' || role_of || ' IS NOT NULL AND user_id = ' || me || ')';
        ELSIF t.kind = 'time' THEN
            ins := system_ctx || ' OR (' || role_of || ' IN (''owner'', ''member'') AND user_id = ' || me || ' AND agile_agent_reach_issue(issue_id))';
            upd := person_writes || ' OR (' || role_of || ' IS NOT NULL AND user_id = ' || me || ')';
            del := upd;
        ELSIF t.kind = 'config' THEN
            ins := person_writes; upd := person_writes; del := person_writes;
        ELSE -- synced
            ins := system_ctx; upd := system_ctx; del := person_writes;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = t.tbl) THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tbl);
            EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.tbl);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_agile_select', t.tbl);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_agile_insert', t.tbl);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_agile_update', t.tbl);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_agile_delete', t.tbl);
            EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', t.tbl || '_agile_select', t.tbl, reads);
            EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', t.tbl || '_agile_insert', t.tbl, ins);
            EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', t.tbl || '_agile_update', t.tbl, upd, upd);
            EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', t.tbl || '_agile_delete', t.tbl, del);
        END IF;
    END LOOP;
END $$;
