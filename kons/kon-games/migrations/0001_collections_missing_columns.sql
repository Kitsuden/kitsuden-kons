-- game_collections: columns the schema declares and the table did not have
-- ============================================================================
--
-- `games.schema.ts` has declared `description` and `is_active` on `game_collections`
-- for a long time. The table was created by the core's base migration, which is
-- older, and nobody wrote the migration for the change.
--
-- The result: `GET /api/games/collections` selected the eight columns of the
-- Drizzle schema against a table that has six, and Postgres answered
--
--     ERROR:  column "description" does not exist
--
-- A 500 on a public route. It went unnoticed because that route had been
-- unreachable for months: `/:id` shadowed it and the error that came out was a
-- different one ("invalid input syntax for type uuid"). Fixing the route order
-- uncovered this one.
--
-- The startup schema verifier did not see it either: it only compared the
-- core's tables, not the kons'.

ALTER TABLE game_collections ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE game_collections ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
