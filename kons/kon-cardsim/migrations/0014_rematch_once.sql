-- 0014 — One rematch per game (2026-11-20)
-- ============================================================================
-- Both players press "rematch" when a game ends. Each press created a new session, so the two
-- players ended up at two different tables. `rematch_id` remembers the rematch a game already
-- started: the second press joins it instead of opening another. Idempotent.

ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS rematch_id text;
