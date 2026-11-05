-- 0006 — DMS: "system" means empty id AND empty role (2026-10-23)
-- ============================================================================
-- Idempotent (CREATE OR REPLACE).
--
-- All the policies from 0005 ask `dms_sistema()`, which returned true
-- with an empty `app.current_user_id`. While the kon opened its own RLS
-- transaction only for requests WITH a user that did not matter: the anonymous user never reached the
-- database. Since 2026-10-23 the HOST opens the RLS transaction for every
-- request to a kon, and the anonymous user carries id '' and role `anonymous`: with 0005
-- it would have passed as the system. It is the same hatch the core closed in
-- rls-owned-tables.sql.
--
-- What the route does as the system on purpose (notifying a reviewer, counting
-- a view) goes through `ctx.db.asSystem`, which empties both id AND role.

CREATE OR REPLACE FUNCTION dms_sistema() RETURNS boolean
    LANGUAGE sql STABLE
AS $$
    SELECT (COALESCE(current_setting('app.current_user_id', true), '') = ''
            AND COALESCE(current_setting('app.current_user_role', true), '') = '')
        OR current_setting('app.current_user_role', true) = 'admin'
$$;
