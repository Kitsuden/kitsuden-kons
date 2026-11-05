-- Migration: Rename esports tables to use esports_ prefix
-- Prevents collision with other kons (e.g. CRM, sports, etc.)
-- Run: cd apps/api && bun run db:migrate

-- Rename the legacy tables to the kon's prefix
-- ----------------------------------------------------------------------------
--
-- Only has an effect on databases coming from the earlier version of the core,
-- where these tables were called `players`, `teams`, `tournaments`… Since
-- `0000_base_schema.sql` creates the `esports_*` ones, this also has to check
-- that the TARGET is free: with both present, `RENAME TO` fails with
-- "relation already exists" and brings down the whole chain.
--
-- `ALTER TABLE IF EXISTS` only covers half of the condition — that the source
-- exists. The other half has to be written out.

DO $$
DECLARE
  par RECORD;
BEGIN
  FOR par IN
    SELECT * FROM (VALUES
      ('players',                 'esports_players'),
      ('teams',                   'esports_teams'),
      ('players_to_teams',        'esports_players_to_teams'),
      ('tournaments',             'esports_tournaments'),
      ('tournament_participants', 'esports_tournament_participants'),
      ('matches',                 'esports_matches')
    ) AS t(viejo, nuevo)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = par.viejo)
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                        WHERE table_schema = 'public' AND table_name = par.nuevo) THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', par.viejo, par.nuevo);
    END IF;
  END LOOP;
END $$;

-- Rename enums
-- ----------------------------------------------------------------------------
--
-- `ALTER TYPE ... IF EXISTS` does NOT exist in PostgreSQL — `ALTER TABLE` does
-- accept it, and that is where the confusion in the four lines above came
-- from. The file was a syntax error:
--
--     ERROR:  syntax error at or near "EXISTS"
--
-- In other words: this migration was never applied, and with it the whole
-- kon-esports chain fell over (eleven files that depend on these names). The
-- kon installer swallowed the error and marked the kon as activated anyway.
--
-- The target is checked too because both names can coexist in a database
-- whose schema was maintained by hand; renaming onto a type that already
-- exists fails.

DO $$
DECLARE
  par RECORD;
BEGIN
  FOR par IN
    SELECT * FROM (VALUES
      ('tournament_format',   'esports_tournament_format'),
      ('tournament_status',   'esports_tournament_status'),
      ('participant_status',  'esports_participant_status'),
      ('match_status',        'esports_match_status')
    ) AS t(viejo, nuevo)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = par.viejo)
       AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = par.nuevo) THEN
      EXECUTE format('ALTER TYPE %I RENAME TO %I', par.viejo, par.nuevo);
    END IF;
  END LOOP;
END $$;
