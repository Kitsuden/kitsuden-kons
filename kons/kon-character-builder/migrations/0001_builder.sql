-- 0001 — Builders and builds
-- Idempotent.
-- The DEFINITION is editorial (no ownership); the BUILD is PERSONAL: it carries
-- owner_id and is classified in rls-owned-tables.sql.
CREATE TABLE IF NOT EXISTS builder_definitions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  definition JSONB NOT NULL,
  published TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS builder_definitions_slug_idx ON builder_definitions (slug);

CREATE TABLE IF NOT EXISTS builder_builds (
  id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Mi build',
  build JSONB NOT NULL,
  -- Precomputed shareable code: it is read a thousand times more than it is written.
  code TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  owner_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_builds_owner_idx ON builder_builds (owner_id, builder_id);
