-- 0003 — The game a map belongs to
--
-- `game` is the slug of a game in the catalog (kon-games, `/api/games`). Every gaming kon names it
-- `game` and stores the slug, so a site can ask each one "what do you have for this game?" with the
-- same value. Optional. Idempotent.
ALTER TABLE game_maps ADD COLUMN IF NOT EXISTS game TEXT;
CREATE INDEX IF NOT EXISTS game_maps_game_idx ON game_maps (game);
