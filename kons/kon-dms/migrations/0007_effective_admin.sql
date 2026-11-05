-- 0007 — DMS: the EFFECTIVE admin in the database too (phase D fixes, 2026-10-25)
-- ============================================================================
-- Idempotent (CREATE OR REPLACE).
--
-- All the policies from 0005 ask `dms_sistema()`: the system (empty id AND
-- role, 0006) or the human `admin` role. An AGENT with `admin` arrives with
-- role `agent`: the app (dms.access.ts) treated it like any other account and
-- RLS only showed it the documents it had created itself (phase D, e2e test
-- over HTTP: a list with only its own).
--
-- Now the admin is `kitsuden_effective_admin('dms')` (core,
-- apps/api/src/db/agent-functions.sql): the human admin, or an agent with
-- `admin`, `dms:*` or `kon:dms:*` (and without a denial that covers it). It is the
-- same as `isAdmin()` in dms.access.ts. An agent with individual scopes
-- (`dms_document:view`…) still sees only what is shared with it, like a person.

CREATE OR REPLACE FUNCTION dms_sistema() RETURNS boolean
    LANGUAGE sql STABLE
AS $$
    SELECT (COALESCE(current_setting('app.current_user_id', true), '') = ''
            AND COALESCE(current_setting('app.current_user_role', true), '') = '')
        OR kitsuden_effective_admin('dms')
$$;
