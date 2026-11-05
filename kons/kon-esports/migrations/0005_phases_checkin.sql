-- 0005 — Chained phases and check-in
-- ============================================================================
-- Idempotent.
--
-- ── Phases ──────────────────────────────────────────────────────────────────
-- A real FGC tournament is not *one bracket*: it is a SEQUENCE (pools → top 8).
--
-- The design decision: **the phase owns its sets, the tournament owns its
-- people**. `esports_tournament_participants` remains the roll —who signed
-- up, their global seed, their check-in— and that is NOT duplicated per phase.
-- What is per phase is who enters (`esports_phase_entries`) and its sets
-- (`esports_matches.phase_id`).
--
-- `phase_id` is NULLABLE on purpose: a tournament without phases keeps working
-- exactly as before, with all its sets at `phase_id IS NULL`. Without that,
-- adding phases would have forced migrating every existing tournament into a
-- fictitious phase.

CREATE TABLE IF NOT EXISTS esports_phases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES esports_tournaments(id) ON DELETE CASCADE,

  -- 1-based. The order IS the sequence.
  "order" INTEGER NOT NULL,
  name VARCHAR(80) NOT NULL,
  format esports_bracket_format NOT NULL DEFAULT 'double_elimination',

  -- Parallel groups: >1 means pools played at the same time.
  groups INTEGER NOT NULL DEFAULT 1,
  -- How many advance PER GROUP, not in total: that is how it is announced and
  -- played, and it saves the TO from doing division in their head when the
  -- pools do not come out the same size.
  advances_per_group INTEGER NOT NULL DEFAULT 1,

  status VARCHAR(20) NOT NULL DEFAULT 'pending',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Two phases cannot take the same place in the sequence.
CREATE UNIQUE INDEX IF NOT EXISTS phases_order_unique
  ON esports_phases (tournament_id, "order");

CREATE TABLE IF NOT EXISTS esports_phase_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phase_id UUID NOT NULL REFERENCES esports_phases(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL
    REFERENCES esports_tournament_participants(id) ON DELETE CASCADE,

  -- Group within the phase, 1-based. Always 1 if the phase has no pools.
  "group" INTEGER NOT NULL DEFAULT 1,
  -- Seed WITHIN its group.
  seed INTEGER NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A participant enters each phase only once.
CREATE UNIQUE INDEX IF NOT EXISTS phase_entries_unique
  ON esports_phase_entries (phase_id, participant_id);

ALTER TABLE esports_matches ADD COLUMN IF NOT EXISTS phase_id UUID;

-- The hot query: "the sets of this phase". Without this, every bracket load
-- scans all the tournament's sets, including the other pools.
CREATE INDEX IF NOT EXISTS matches_phase_idx ON esports_matches (phase_id);

-- ── Check-in ────────────────────────────────────────────────────────────────
-- In a 128-player tournament with open registration, between 15% and 30% do
-- not show up. Without check-in that is 20-40 first-round sets waiting for
-- someone who is not there.
--
-- A timestamp and not a boolean: the TO needs to know who arrived late when
-- deciding whom to wait for.

ALTER TABLE esports_tournament_participants
  ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ;

ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS check_in_opens_at TIMESTAMPTZ;
ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS check_in_closes_at TIMESTAMPTZ;
