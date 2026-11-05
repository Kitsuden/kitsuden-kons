-- 0003 — Games of a series, and the match's production fields
-- ============================================================================
-- Idempotent.
--
-- ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
--
-- `broadcast.schema.ts` declared `broadcast_games` and four new columns of
-- `broadcast_matches` (`theme`, `sponsors`, `starts_at`, `fearless`) that no
-- migration created. The startup guard caught it and REFUSED to start:
--
--     ERROR: there are tables declared in the code that the database does NOT have.
--        · broadcast_games   (kon-broadcast: broadcastGames)
--
-- Refusing is the right thing. Without that guard the API would have started
-- happily and blown up with "relation "broadcast_games" does not exist"
-- the first time someone opened a series — that is, live on air.
--
-- ── THE DEFAULTS ARE NOT DECORATION ────────────────────────────────────────
--
-- Each new column carries the same DEFAULT the schema declares. Without them,
-- rows that ALREADY exist would be left with NULL in columns the code reads
-- as non-null, and the failure would show up when opening an old match, not
-- when migrating.

-- ── Production fields of the match ─────────────────────────────────────────
ALTER TABLE broadcast_matches
  -- The default is the SAME one `DEFAULT_THEME` declares in broadcast.schema.ts.
  -- With `'{}'` the column would exist and the schema guard would pass, but a
  -- match created outside drizzle would go on air with no accent, no
  -- surface and no opacity — and that shows live on air, not here.
  ADD COLUMN IF NOT EXISTS theme JSONB NOT NULL DEFAULT
    '{"accent":"#4c8dff","surface":"#070a10","surfaceOpacity":0.86,"corners":"sharp","fontFamily":null}'::jsonb,
  ADD COLUMN IF NOT EXISTS sponsors JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- No default and nullable: "no announced time" is a real state, and it is the
  -- one that keeps the countdown from being drawn.
  ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fearless TEXT NOT NULL DEFAULT 'off';

-- ── The games of a series ──────────────────────────────────────────────────
--
-- One row per game within a match. It exists
-- because in competition the sides swap between games, and that is
-- GAME data: storing it on the match makes Fearless
-- lock the characters on the wrong side from the second game on.
CREATE TABLE IF NOT EXISTS broadcast_games (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,

  -- 1-based. Game 1 of a Bo5 is 1, not 0.
  game_number INTEGER NOT NULL DEFAULT 1,

  -- Whether side A of the match takes the first side WITHIN the game
  -- (blue in a MOBA, P1 in a fighting game).
  side_a_first BOOLEAN NOT NULL DEFAULT true,

  draft JSONB,

  -- Picked characters, indexed by MATCH side and not by
  -- game side. See the schema note: getting the distinction wrong
  -- invalidates the whole series.
  drafted JSONB NOT NULL DEFAULT '{"blue": [], "red": []}'::jsonb,

  -- Ingest adapter used. Stored so it can be diagnosed later.
  ingest_id TEXT,
  -- Token of the local agent. It lives in the GAME row so that the reach
  -- of a leak is one specific game.
  ingest_token TEXT,
  -- Patch played: it changes the gold and objective constants.
  patch TEXT,

  -- Snapshot of the last frame, for the post-game and for recovering if the
  -- production restarts. It is not a continuous log.
  snapshot JSONB,
  gold_series JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- `blue` | `red` | NULL. GAME side, not match side.
  winner TEXT,
  duration INTEGER,

  status TEXT NOT NULL DEFAULT 'pending',

  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The index that matters: "give me the games of this match, in order".
CREATE INDEX IF NOT EXISTS broadcast_games_match_idx
  ON broadcast_games (match_id, game_number);
