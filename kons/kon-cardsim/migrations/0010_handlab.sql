-- 0001 — Hand generator
-- Idempotent.
--
-- No zones, no turns, no sessions: a dataset is cards + four rules, and that is
-- enough to deal hands. The engine that deals and counts is cardsim's,
-- fed with a minimal definition synthesized on the fly.

CREATE TABLE IF NOT EXISTS handlab_datasets (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- A dataset without provenance cannot be audited when the source changes.
  source TEXT,
  hand_size INTEGER NOT NULL DEFAULT 7,
  deck_min INTEGER NOT NULL DEFAULT 1,
  deck_max INTEGER NOT NULL DEFAULT 250,
  max_copies INTEGER NOT NULL DEFAULT 4,
  -- Per-card exceptions. It is what lets Hearthstone be described (2 copies,
  -- but 1 if legendary) without writing code.
  copy_limits JSONB NOT NULL DEFAULT '{}',
  card_count INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS handlab_datasets_slug_idx ON handlab_datasets (slug);

CREATE TABLE IF NOT EXISTS handlab_cards (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  name TEXT NOT NULL,
  image_url TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS handlab_cards_dataset_card_idx ON handlab_cards (dataset_id, card_id);
CREATE INDEX IF NOT EXISTS handlab_cards_name_idx ON handlab_cards (dataset_id, name);

CREATE TABLE IF NOT EXISTS handlab_decks (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Mazo',
  cards JSONB NOT NULL,
  owner_id TEXT,
  share_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS handlab_decks_owner_idx ON handlab_decks (owner_id, dataset_id);
CREATE UNIQUE INDEX IF NOT EXISTS handlab_decks_share_idx ON handlab_decks (share_id);
