-- 0001 — Interactive maps
-- Idempotent. Editorial: no ownership columns.
-- NORMALIZED coordinates [0..1]: uploading an HD map does not move markers.
CREATE TABLE IF NOT EXISTS game_maps (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS game_maps_slug_idx ON game_maps (slug);

CREATE TABLE IF NOT EXISTS map_categories (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT NOT NULL DEFAULT '#00d2a8'
);
CREATE UNIQUE INDEX IF NOT EXISTS map_categories_idx ON map_categories (map_id, category_id);

CREATE TABLE IF NOT EXISTS map_markers (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL,
  layer_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS map_markers_map_idx ON map_markers (map_id, layer_id);
