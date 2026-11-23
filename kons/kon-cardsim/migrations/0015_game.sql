-- 0015 — The catalog game a simulator game belongs to
--
-- `game` is the slug of a game in the catalog (kon-games, `/api/games`). Every gaming kon names it
-- `game` and stores the slug, so a site can ask each one "what do you have for this game?" with the
-- same value. It is NOT the simulator's own `game_id` (a `cardsim_games` row): two simulator games
-- (standard and a draft format, say) can belong to the same catalog game. Optional. Idempotent.
ALTER TABLE cardsim_games ADD COLUMN IF NOT EXISTS game TEXT;
CREATE INDEX IF NOT EXISTS cardsim_games_game_idx ON cardsim_games (game);
