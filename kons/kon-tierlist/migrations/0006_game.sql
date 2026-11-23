-- 0006 — The game a tier list belongs to
--
-- `game` is the slug of a game in the catalog (kon-games, `/api/games`). Every gaming kon names it
-- `game` and stores the slug, so a site can ask each one "what do you have for this game?" with the
-- same value. Optional. A personal list forked from a template copies the template's. Idempotent.
ALTER TABLE tier_lists ADD COLUMN IF NOT EXISTS game TEXT;
CREATE INDEX IF NOT EXISTS tier_lists_game_idx ON tier_lists (game, kind);
