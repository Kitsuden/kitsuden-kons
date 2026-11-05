-- 0001 — Deck showcase
-- Idempotent.
--
-- No card table and no deck table: the catalog lives in `cardsim_cards` and
-- the lists in `cardsim_decks`. A showcase deck IS a real deck and can be
-- played without exporting anything. Duplicating it here would have created two
-- truths about what a card is, and the second one always goes stale.

CREATE TABLE IF NOT EXISTS deckshow_entries (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  tags JSONB NOT NULL DEFAULT '[]',
  -- The goldfish queries the AUTHOR leaves written: whoever visits the deck
  -- runs them themselves instead of trusting a screenshot.
  goldfish_queries JSONB NOT NULL DEFAULT '[]',
  author_id TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  hidden_reason TEXT,
  featured BOOLEAN NOT NULL DEFAULT false,
  featured_at TIMESTAMPTZ,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS deckshow_entries_slug_idx ON deckshow_entries (slug);
CREATE INDEX IF NOT EXISTS deckshow_entries_gallery_idx
  ON deckshow_entries (game_id, status, featured, published_at);
CREATE INDEX IF NOT EXISTS deckshow_entries_author_idx ON deckshow_entries (author_id);
-- A deck is shown once: without this, republishing creates duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS deckshow_entries_deck_idx ON deckshow_entries (deck_id);

-- One "like" per person and entry. It is a table and not a bare counter because
-- without it we cannot answer "did I like it?", and without that answer the
-- button cannot be drawn and double voting cannot be prevented.
CREATE TABLE IF NOT EXISTS deckshow_likes (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS deckshow_likes_entry_user_idx ON deckshow_likes (entry_id, user_id);
