-- 0003 — The game a formula system belongs to
--
-- `game` is the slug of a game in the catalog (kon-games, `/api/games`). Every gaming kon names it
-- `game` and stores the slug, so a site can ask each one "what do you have for this game?" with the
-- same value. Optional: a system that serves several games leaves it empty. Idempotent.
ALTER TABLE formula_systems ADD COLUMN IF NOT EXISTS game TEXT;
CREATE INDEX IF NOT EXISTS formula_systems_game_idx ON formula_systems (game);
