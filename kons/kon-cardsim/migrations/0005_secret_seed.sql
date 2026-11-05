-- 0005 — Secret seed per game (audit 2026-10-25)
-- ============================================================================
-- With a 31-bit seed, a player could brute-force it from their hand and know
-- both decks and all the randomness. New games carry a 256-bit secret; old
-- ones (NULL) keep their numeric seed.
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS rng_secreto text;
