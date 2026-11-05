-- 0001 — Card simulators
-- Idempotent.
-- GAME and CARDS: editorial. DECK: personal (owner_id + RLS). SESSION:
-- shared between players/spectators — what each one SEES is decided by
-- viewFor per seat, not by the row.
CREATE TABLE IF NOT EXISTS cardsim_games (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  definition JSONB NOT NULL,
  published TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cardsim_games_slug_idx ON cardsim_games (slug);

CREATE TABLE IF NOT EXISTS cardsim_cards (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cardsim_cards_game_card_idx ON cardsim_cards (game_id, card_id);

CREATE TABLE IF NOT EXISTS cardsim_decks (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Mazo',
  cards JSONB NOT NULL,
  owner_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cardsim_decks_owner_idx ON cardsim_decks (owner_id, game_id);

-- The session does NOT store the state: it stores {seed, decks, actions} and
-- the state is rebuilt with replay(). A game is a few KB.
CREATE TABLE IF NOT EXISTS cardsim_sessions (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  seed INTEGER NOT NULL,
  decks JSONB NOT NULL,
  seats JSONB NOT NULL,
  actions JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  owner_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cardsim_sessions_owner_idx ON cardsim_sessions (owner_id, status);
