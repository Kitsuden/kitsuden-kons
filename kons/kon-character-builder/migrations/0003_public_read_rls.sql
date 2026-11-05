-- 0003 — Public read of published builds, in the database (2026-10-23)
-- ============================================================================
-- Idempotent: DROP POLICY IF EXISTS before each CREATE.
--
-- Until now the kons' routes used the global `db`, without an RLS context:
-- Postgres treated them as the system and `builder_builds_owner_isolation`
-- (rls-owned-tables.sql) filtered nothing. Since every request to a kon runs
-- in its own RLS transaction, an anonymous user or a user who is not the owner
-- only sees the rows a policy lets them see.
--
-- A `public` build shows in the gallery and an `unlisted` one opens through its
-- link: both are readable without being the owner, by design (the kon's `builder`
-- policy says the same). `private` ones, only their owner and admin.
--
-- READ only: writing still belongs to the owner (the ownership policy).
-- Votes (`builder_build_votes`) are NOT opened: they reveal who voted. The
-- route does the count as the system, after authorizing.

DO $$
BEGIN
  IF to_regclass('public.builder_builds') IS NOT NULL THEN
    DROP POLICY IF EXISTS builder_builds_lectura_publica ON builder_builds;
    CREATE POLICY builder_builds_lectura_publica ON builder_builds
      FOR SELECT TO PUBLIC
      USING (visibility IN ('public', 'unlisted'));
  END IF;
END $$;
