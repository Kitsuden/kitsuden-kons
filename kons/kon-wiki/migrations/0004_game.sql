-- 0004 — The game of a wiki, by slug
--
-- `game` is the slug of a game in the catalog (kon-games, `/api/games`). Every gaming kon names it
-- `game` and stores the slug, so a site can ask each one "what do you have for this game?" with the
-- same value. The wiki already had `game_id` (the catalog's uuid): it stays, and `game` is filled
-- from it where the catalog is installed. A wiki can now name its game without kon-games. Idempotent.
ALTER TABLE wikis ADD COLUMN IF NOT EXISTS game TEXT;
CREATE INDEX IF NOT EXISTS wikis_game_slug_idx ON wikis (game);

DO $$
BEGIN
  -- `games` belongs to kon-games: only read it if it is there, and has the columns this needs.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'games' AND column_name = 'slug')
     AND EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'games' AND column_name = 'id' AND data_type = 'uuid')
  THEN
    UPDATE wikis w SET game = g.slug
      FROM games g
     WHERE w.game IS NULL AND w.game_id IS NOT NULL AND g.id = w.game_id;
  END IF;
END $$;
