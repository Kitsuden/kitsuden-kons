-- 0002 — Bracket engine: seeding, double elimination and DQ
-- ============================================================================
-- The previous generator only knew single elimination: the tables had nowhere
-- to store the bracket side or where the loser drops to. Everything here is
-- ADDITIVE — no existing tournament changes shape.
--
-- Idempotent: it can be reapplied without breaking anything.

-- ── New set statuses ────────────────────────────────────────────────────────
-- 'Bye'  = advanced without playing; 'Void' = the set never comes to exist
-- (empty branch). ALTER TYPE ... ADD VALUE does not accept IF NOT EXISTS in
-- every version, so it is checked first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'esports_match_status' AND e.enumlabel = 'Bye'
  ) THEN
    ALTER TYPE esports_match_status ADD VALUE 'Bye';
  END IF;

  IF NOT EXISTS (
    SELECT FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'esports_match_status' AND e.enumlabel = 'Void'
  ) THEN
    ALTER TYPE esports_match_status ADD VALUE 'Void';
  END IF;
END $$;

-- ── New types ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE esports_bracket_format AS ENUM ('single_elimination', 'double_elimination');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE esports_seed_method AS ENUM ('as_entered', 'random', 'by_rating');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE esports_bracket_side AS ENUM ('winners', 'losers', 'grand_final');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Tournaments: bracket configuration ──────────────────────────────────────
ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS bracket_format esports_bracket_format
    NOT NULL DEFAULT 'single_elimination',
  ADD COLUMN IF NOT EXISTS seed_method esports_seed_method
    NOT NULL DEFAULT 'as_entered',
  -- Stored so the same draw can be REGENERATED if someone disputes it.
  ADD COLUMN IF NOT EXISTS shuffle_seed INTEGER,
  ADD COLUMN IF NOT EXISTS champion_id UUID;

-- ── Participants: seeding and elimination by DQ ─────────────────────────────
ALTER TABLE esports_tournament_participants
  ADD COLUMN IF NOT EXISTS seed INTEGER,
  ADD COLUMN IF NOT EXISTS rating INTEGER,
  ADD COLUMN IF NOT EXISTS eliminated BOOLEAN NOT NULL DEFAULT false;

-- ── Sets: bracket side and loser's path ─────────────────────────────────────
ALTER TABLE esports_matches
  ADD COLUMN IF NOT EXISTS bracket_match_id VARCHAR(20),
  ADD COLUMN IF NOT EXISTS bracket_side esports_bracket_side
    NOT NULL DEFAULT 'winners',
  -- Without this column double elimination is impossible: there is nowhere
  -- to record which losers-bracket set the loser drops into.
  ADD COLUMN IF NOT EXISTS loser_next_match_id UUID,
  ADD COLUMN IF NOT EXISTS dq_participant_id UUID;

-- Reconciliation by engine id (`W2M1`, `GF`…) within each tournament.
CREATE UNIQUE INDEX IF NOT EXISTS esports_matches_bracket_id_idx
  ON esports_matches (tournament_id, bracket_match_id)
  WHERE bracket_match_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS esports_matches_side_round_idx
  ON esports_matches (tournament_id, bracket_side, round);
