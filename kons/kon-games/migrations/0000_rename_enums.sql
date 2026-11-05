-- Rename the games enums with their own prefix
-- ============================================================================
--
-- Avoids clashing with other kons' enums: `content_status` is a name
-- the blog wants too.
--
-- ── WHY THIS IS NOT AN `ALTER TYPE IF EXISTS` ──────────────────────────────
--
-- Because that syntax DOES NOT EXIST in PostgreSQL. `ALTER TYPE` does not accept
-- `IF EXISTS`, so the file was a syntax error, not a migration:
--
--     ERROR:  syntax error at or near "EXISTS"
--
-- It was never applied. And since the kon installer swallowed the error, the
-- kon stayed "activated" with no tables. The condition has to be written by hand.
--
-- ── AND WHY THE TARGET IS CHECKED TOO ──────────────────────────────────────
--
-- Because both names can coexist: in a database where the schema was
-- maintained by hand, `games_content_status` already exists AND `content_status`
-- is still there (from another kon, or from the old schema). Renaming on top of it
-- fails. If the target exists, the work is already done or does not belong here.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'content_status')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'games_content_status') THEN
    ALTER TYPE content_status RENAME TO games_content_status;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tag_category')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'games_tag_category') THEN
    ALTER TYPE tag_category RENAME TO games_tag_category;
  END IF;
END $$;
