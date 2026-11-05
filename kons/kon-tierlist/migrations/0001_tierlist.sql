-- 0001 — Tier lists
-- ============================================================================
-- Idempotent.
--
-- ONE table, two kinds of row by `kind`: `template` (editorial, public, no
-- owner) and `personal` (a reader's, with owner_id and isolated by RLS).
-- Splitting them into two tables would force a UNION on every read, because 90%
-- of the queries ("give me this tier list") do not care which one it is.
CREATE TABLE IF NOT EXISTS tier_lists (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'template',
  -- Only templates have a public slug.
  slug TEXT,
  title TEXT NOT NULL,

  tiers JSONB NOT NULL,
  items JSONB NOT NULL,
  -- itemId -> tierId. Whatever is ABSENT is unranked: that is the natural state of
  -- everything new that comes in, and writing a null per item would be noise.
  placement JSONB NOT NULL DEFAULT '{}',

  -- Dataset the catalog is synced from. It makes a new character show up
  -- unranked instead of being forgotten.
  catalog_dataset_id TEXT,

  template_id TEXT,
  version TEXT,

  owner_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tier_lists_slug_idx ON tier_lists (slug);
CREATE INDEX IF NOT EXISTS tier_lists_owner_idx ON tier_lists (owner_id, kind);
