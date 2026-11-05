-- 0002 — Unification: `kon-broadcast-moba` is absorbed into Broadcast
-- ============================================================================
-- Idempotent: it can be reapplied without breaking anything.
--
-- ── WHAT WAS HAPPENING ─────────────────────────────────────────────────────
--
-- There were TWO kons with the same container. `moba_series` and `broadcast_matches`
-- turned out to be the same table under other names —`title`/`event_title`,
-- `stage`/`round`, `best_of`/`first_to`, `blue_team`/`side_a`— and their two
-- `report` handlers were the same code: look up, check permission, 409
-- if it does not come from the bracket, `checkReportable`, `reportToBracket`.
--
-- The real difference was not the container: it was that MOBA stores each game
-- separately (draft, gold, objectives) and fighting games do not. That is an
-- optional child table, not a separate kon.
--
-- ── WHAT IT DOES ───────────────────────────────────────────────────────────
--
--   1. Adds to `broadcast_matches` what only the series had: theme,
--      sponsors, start time and Fearless mode. None of them is MOBA-specific —
--      a fighting-game league wants exactly the same.
--   2. Creates `broadcast_games`, the child table.
--   3. MIGRATES whatever rows exist in `moba_series` / `moba_games`.
--   4. Only then drops the old tables.
--
-- ── WHY IT MIGRATES INSTEAD OF DROPPING ────────────────────────────────────
--
-- When this was written the four tables were empty in the reference
-- installation, so dropping would have been enough *there*. But a migration
-- runs on installations nobody has looked at, and "it was empty on my machine"
-- is not a check. The cost of copying them is this file; the cost of not
-- doing it is someone's broadcast.
--
-- `first_to` is NOT `best_of`: a Bo3 is won on reaching 2. The conversion is
-- explicit below — storing a 3 where a 2 belonged closes the match one
-- game too early and advances the bracket with the wrong winner.

-- ── 1. The container gains what only the series had ─────────────────────────

ALTER TABLE broadcast_matches
  ADD COLUMN IF NOT EXISTS theme JSONB NOT NULL DEFAULT
    '{"accent":"#4c8dff","surface":"#070a10","surfaceOpacity":0.86,"corners":"sharp","fontFamily":null}'::jsonb,
  ADD COLUMN IF NOT EXISTS sponsors JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
  -- A rule of the FORMAT, not of the game: changing it in the middle of a Bo5
  -- would invalidate the earlier drafts, so it lives on the match.
  ADD COLUMN IF NOT EXISTS fearless TEXT NOT NULL DEFAULT 'off';

-- ── 2. The child table ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS broadcast_games (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,

  -- 1-based. Game 1 of a Bo5 is 1, not 0.
  game_number INTEGER NOT NULL DEFAULT 1,

  -- Whether side A of the match takes the first side WITHIN the game
  -- (blue in a MOBA, P1 in a fighting game). It is GAME data: in competition the
  -- sides swap from one game to the next.
  side_a_first BOOLEAN NOT NULL DEFAULT TRUE,

  draft JSONB,

  -- Indexed by MATCH side, not by game side. Since the sides swap,
  -- storing it by game side would make Fearless in `team` mode lock
  -- the characters on the wrong side from the second game on — and that
  -- invalidates the whole match.
  drafted JSONB NOT NULL DEFAULT '{"blue":[],"red":[]}'::jsonb,

  ingest_id TEXT,
  -- Bound to ONE game on purpose: it goes into a config file of a
  -- process on the operator's PC, so we must assume it can leak.
  ingest_token TEXT,
  patch TEXT,

  -- Snapshot for the post-game and for recovering after a restart, not a
  -- continuous log: persisting 5 frames per second would be 18,000 writes
  -- per game to draw something nobody will look at two minutes later.
  snapshot JSONB,
  gold_series JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- `blue` | `red` | NULL. GAME side, not match side.
  winner TEXT,
  duration INTEGER,

  status TEXT NOT NULL DEFAULT 'pending',

  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS broadcast_games_match_idx
  ON broadcast_games (match_id, game_number);

-- ── 3. Moving over whatever exists ──────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.moba_series') IS NULL THEN
    RAISE NOTICE 'No hay `moba_series`: nada que trasladar.';
    RETURN;
  END IF;

  -- The side is built from the team, its score and its bracket participant,
  -- which in the old model lived in three separate columns.
  INSERT INTO broadcast_matches (
    id, event_title, round, first_to, profile_id,
    side_a, side_b, casters, screens, live, ticker,
    theme, sponsors, starts_at, fearless,
    tournament_id, bracket_match_id, status, owner_id, created_at, updated_at
  )
  SELECT
    s.id,
    s.title,
    s.stage,
    -- Bo3 → 2, Bo5 → 3. It is NOT a copy of `best_of`.
    (GREATEST(s.best_of, 1) / 2) + 1,
    -- The profile is left unset: the game cannot be deduced from a MOBA
    -- row, and guessing it would reinterpret the payload with the wrong schema.
    -- NULL makes it resolve against the configured profile, which is the
    -- behaviour rows from before profiles already had.
    NULL,
    jsonb_build_object(
      'playerId', NULL,
      'participantId', s.blue_participant_id,
      'country', NULL,
      'sponsor', COALESCE(s.blue_team->>'tag', ''),
      'logoUrl', s.blue_team->>'logoUrl',
      'name', COALESCE(s.blue_team->>'name', 'AZUL'),
      'chars', '[]'::jsonb,
      'score', s.blue_score,
      'losers', FALSE,
      'color', COALESCE(s.blue_team->>'color', '#4c8dff')
    ),
    jsonb_build_object(
      'playerId', NULL,
      'participantId', s.red_participant_id,
      'country', NULL,
      'sponsor', COALESCE(s.red_team->>'tag', ''),
      'logoUrl', s.red_team->>'logoUrl',
      'name', COALESCE(s.red_team->>'name', 'ROJO'),
      'chars', '[]'::jsonb,
      'score', s.red_score,
      'losers', FALSE,
      'color', COALESCE(s.red_team->>'color', '#ff4d5e')
    ),
    s.casters,
    '{"ko":false,"versus":false,"casters":false,"result":false}'::jsonb,
    FALSE,
    NULL,
    s.theme,
    s.sponsors,
    s.starts_at,
    s.fearless,
    s.tournament_id,
    s.bracket_match_id,
    s.status,
    s.owner_id,
    s.created_at,
    s.updated_at
  FROM moba_series s
  -- Reapplicable: if it was already moved, it is not duplicated.
  ON CONFLICT (id) DO NOTHING;

  IF to_regclass('public.moba_games') IS NOT NULL THEN
    INSERT INTO broadcast_games (
      id, match_id, game_number, side_a_first, draft, drafted,
      ingest_id, ingest_token, patch, snapshot, gold_series,
      winner, duration, status, started_at, ended_at, created_at, updated_at
    )
    SELECT
      g.id, g.series_id, g.game_number, g.blue_is_series_blue, g.draft, g.drafted,
      g.ingest_id, g.ingest_token, g.patch, g.snapshot, g.gold_series,
      g.winner, g.duration, g.status, g.started_at, g.ended_at, g.created_at, g.updated_at
    FROM moba_games g
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RAISE NOTICE 'Trasladadas las filas de moba_series/moba_games a broadcast_matches/broadcast_games.';
END $$;

-- ── 4. Out with the old tables ──────────────────────────────────────────────
--
-- After the move and not before. `moba_games` first in case some
-- installation went as far as giving it the foreign key the model did not declare.

DROP TABLE IF EXISTS moba_games;
DROP TABLE IF EXISTS moba_series;
