-- 0001 — Autobattler compositions
-- Idempotent.
--
-- Three tables, and the middle one is ONE on purpose: units, traits, items and
-- augments are four things in the game but the same thing to the database: (set, id,
-- name, document). Four tables would mean four identical importers and a
-- UNION in the most frequent query ("give me the whole set for the editor").

CREATE TABLE IF NOT EXISTS autobattler_sets (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  game TEXT NOT NULL DEFAULT 'tft',
  rules JSONB NOT NULL,
  source TEXT,
  -- A set without a patch cannot be dated when Riot rebalances.
  patch TEXT,
  current BOOLEAN NOT NULL DEFAULT false,
  owner_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS autobattler_sets_slug_idx ON autobattler_sets (slug);
CREATE INDEX IF NOT EXISTS autobattler_sets_game_idx ON autobattler_sets (game, current);

CREATE TABLE IF NOT EXISTS autobattler_entities (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL,
  -- unit · trait · item · augment
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,
  data JSONB NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS autobattler_entities_unique_idx
  ON autobattler_entities (set_id, kind, entity_id);
CREATE INDEX IF NOT EXISTS autobattler_entities_kind_idx ON autobattler_entities (set_id, kind);
CREATE INDEX IF NOT EXISTS autobattler_entities_name_idx ON autobattler_entities (set_id, name);

CREATE TABLE IF NOT EXISTS autobattler_comps (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  slots JSONB NOT NULL,
  level INTEGER,
  augments JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]',
  -- The tier list tier is an editorial OPINION: it is set by hand and does not
  -- come from any calculation, which is why it does not live inside `stats`.
  tier TEXT,
  -- And the stats are NOT produced by this kon: they come from outside. `stats_source`
  -- exists so it is always known where each figure came from.
  stats JSONB,
  stats_source TEXT,
  stats_updated_at TIMESTAMPTZ,
  gold_cost REAL,
  author_id TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS autobattler_comps_slug_idx ON autobattler_comps (slug);
CREATE INDEX IF NOT EXISTS autobattler_comps_list_idx ON autobattler_comps (set_id, status, tier);
CREATE INDEX IF NOT EXISTS autobattler_comps_author_idx ON autobattler_comps (author_id);
