-- ════════════════════════════════════════════════════════════════════════════
-- Duplicate indexes on blog_posts
-- ════════════════════════════════════════════════════════════════════════════
--
-- Drizzle's base schema (`drizzle/0000_…sql`) creates `blog_slug_idx`,
-- `blog_status_idx` and `blog_published_idx`, and this kon's 0000_initial
-- creates the SAME ones under another name (`blog_posts_*_idx`). Two identical
-- indexes break nothing (ON CONFLICT (slug) accepts both as arbiters), but
-- every write maintains twice as much.
--
-- The kon's ones stay, since they are the ones the kon assumes. This goes here
-- and not in `src/db/migrations/` because the runner runs the kons AFTERWARDS:
-- on a fresh database, the `blog_posts_*` ones would not exist there yet.
--
-- Each one is dropped only if its twin exists: `slug` is never left without a
-- unique index. Idempotent.

DO $$
BEGIN
  IF to_regclass('public.blog_posts_slug_idx') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.blog_slug_idx;
  END IF;
  IF to_regclass('public.blog_posts_status_idx') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.blog_status_idx;
  END IF;
  IF to_regclass('public.blog_posts_published_idx') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.blog_published_idx;
  END IF;
END $$;
