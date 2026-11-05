-- 0002 — Rooms, matches, ratings and matchmaking queue
-- Idempotent: can be reapplied on a database that already has 0001.
--
-- None of this touches how a GAME is stored: the session is still
-- {seed, decks, actions} and the state is still rebuilt with replay().
-- What is added is what surrounds the game — who joins, against whom, in
-- which match and with what score.

-- Index for the deck builder's search.
CREATE INDEX IF NOT EXISTS cardsim_cards_game_name_idx ON cardsim_cards (game_id, name);

-- Share a deck by URL without exposing its internal id.
ALTER TABLE cardsim_decks ADD COLUMN IF NOT EXISTS share_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS cardsim_decks_share_idx ON cardsim_decks (share_id);

-- The Bo3: several sessions with a shared score. Each game stores ITS own
-- snapshot of the decks because the side deck changes between games.
CREATE TABLE IF NOT EXISTS cardsim_matches (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  best_of INTEGER NOT NULL DEFAULT 1,
  seats JSONB NOT NULL,
  wins JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  rated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cardsim_matches_status_idx ON cardsim_matches (game_id, status);

-- Room: visibility, password (salted scrypt hash, never in plain text) and
-- spectators.
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS allow_spectators BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS match_id TEXT;
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS game_index INTEGER NOT NULL DEFAULT 0;
-- Undo means truncating the action list: it is enough to store up to where and
-- who asked for it, while waiting for the opponent to accept.
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS undo_request JSONB;
-- State epoch: goes up on undo (which truncates the actions) and on sitting
-- down (which changes the decks). It is what lets the rebuilt state be cached
-- without risking serving a stale board — an entry from another epoch is dropped.
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS state_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS result JSONB;
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

-- Clock. It lives OUTSIDE the engine on purpose: time is wall-clock time and
-- the engine has to be reproducible — a clock inside would make every replay
-- produce a different game. When it runs out, the server sends a normal
-- `concede`, which does go into the log and does get replayed.
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS clocks JSONB;
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS clock_started_at TIMESTAMPTZ;
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS increment_ms INTEGER NOT NULL DEFAULT 0;

-- Short room code: it is what gets read out loud or pasted into a chat. A
-- 24-character cuid2 cannot be read out loud.
ALTER TABLE cardsim_sessions ADD COLUMN IF NOT EXISTS code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS cardsim_sessions_code_idx ON cardsim_sessions (code);

CREATE INDEX IF NOT EXISTS cardsim_sessions_lobby_idx
  ON cardsim_sessions (game_id, status, visibility);
CREATE INDEX IF NOT EXISTS cardsim_sessions_match_idx ON cardsim_sessions (match_id);

-- Ratings: derived from the games, but materialized — recomputing the Elo of
-- thousands of games to draw a table would be absurd.
CREATE TABLE IF NOT EXISTS cardsim_ratings (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1200,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cardsim_ratings_game_user_idx ON cardsim_ratings (game_id, user_id);
CREATE INDEX IF NOT EXISTS cardsim_ratings_board_idx ON cardsim_ratings (game_id, rating);

-- Matchmaking queue. The unique index per user is the rule: nobody queues
-- twice, not even if the button is pressed twice.
CREATE TABLE IF NOT EXISTS cardsim_queue (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  deck_id TEXT NOT NULL,
  rated BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cardsim_queue_user_idx ON cardsim_queue (user_id);
CREATE INDEX IF NOT EXISTS cardsim_queue_game_idx ON cardsim_queue (game_id, created_at);
