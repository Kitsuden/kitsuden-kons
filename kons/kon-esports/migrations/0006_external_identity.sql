-- 0006 — External identity: where each imported thing came from
-- ============================================================================
--
-- Without this, an importer can only recognise someone by their name, and the
-- name is exactly what does not hold up:
--
--   · Two different people share a gamertag across platforms. Matching them
--     by alias merges two players into one and mixes their history.
--   · A player renames between two tournaments. Matching by alias creates a
--     duplicate and splits their history in two.
--   · Re-importing the SAME event (because five registrations came in late)
--     would duplicate everything already imported.
--
-- With (source, external_id) the import is idempotent: it runs as many times
-- as needed and updates instead of duplicating. It is the difference between
-- an importer people use and one they are afraid to touch.

-- ── Players ─────────────────────────────────────────────────────────────────

ALTER TABLE esports_players ADD COLUMN IF NOT EXISTS external_source VARCHAR(20);
ALTER TABLE esports_players ADD COLUMN IF NOT EXISTS external_id VARCHAR(64);

-- Partial: players created by hand have no external source, and without the
-- WHERE all of them would collide with each other on (NULL, NULL).
CREATE UNIQUE INDEX IF NOT EXISTS players_external_unique
  ON esports_players (external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;

-- ── Teams ───────────────────────────────────────────────────────────────────

ALTER TABLE esports_teams ADD COLUMN IF NOT EXISTS external_source VARCHAR(20);
ALTER TABLE esports_teams ADD COLUMN IF NOT EXISTS external_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS teams_external_unique
  ON esports_teams (external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;

-- ── Tournaments ─────────────────────────────────────────────────────────────
--
-- NO unique index here: the same start.gg event may be imported on purpose
-- into two Kitsuden tournaments (a trial run and the real one, or two editions
-- from the same URL). What is needed is knowing where it came from so it can
-- be synced again, not preventing it from repeating.

ALTER TABLE esports_tournaments ADD COLUMN IF NOT EXISTS external_source VARCHAR(20);
ALTER TABLE esports_tournaments ADD COLUMN IF NOT EXISTS external_id VARCHAR(64);
ALTER TABLE esports_tournaments ADD COLUMN IF NOT EXISTS external_url TEXT;

CREATE INDEX IF NOT EXISTS tournaments_external_idx
  ON esports_tournaments (external_source, external_id);

-- ── Prize pool ──────────────────────────────────────────────────────────────
--
-- In CENTS and as an integer, never floating point: a prize is money, and
-- `0.1 + 0.2` is not `0.3`. It is also how Matcherino publishes it (`balance`),
-- so there is no conversion to lose anything along the way.
--
-- The currency sits next to the number because a figure without a currency in
-- a broadcast overlay is worse than showing nothing.

ALTER TABLE esports_tournaments ADD COLUMN IF NOT EXISTS prize_pool_cents INTEGER;
ALTER TABLE esports_tournaments ADD COLUMN IF NOT EXISTS prize_pool_currency VARCHAR(3);
ALTER TABLE esports_tournaments ADD COLUMN IF NOT EXISTS prize_pool_synced_at TIMESTAMPTZ;
