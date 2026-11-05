-- 0003 — Player country
-- ============================================================================
-- Idempotent.
--
-- ISO 3166-1 alpha-2 in upper case. The CODE is stored, not the name: the flag
-- is derived from it with the Unicode regional indicator symbols, with no
-- country table and no CDN, and the translated name is the UI's problem.

ALTER TABLE esports_players ADD COLUMN IF NOT EXISTS country VARCHAR(2);
