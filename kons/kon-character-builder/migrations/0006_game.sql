-- 0006 — The game a builder belongs to
--
-- `game` is the slug of a game in the catalog (kon-games, `/api/games`). Every gaming kon names it
-- `game` and stores the slug, so a site can ask each one "what do you have for this game?" with the
-- same value. Optional. Idempotent.
ALTER TABLE builder_definitions ADD COLUMN IF NOT EXISTS game TEXT;
CREATE INDEX IF NOT EXISTS builder_definitions_game_idx ON builder_definitions (game);
