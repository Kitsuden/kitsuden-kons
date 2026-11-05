-- 0001 — Formula systems
-- Idempotent. Editorial: no ownership columns.
CREATE TABLE IF NOT EXISTS formula_systems (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  -- The system's formulas. They are validated with compileSystem BEFORE reaching here:
  -- a system with cycles or unknown functions is not saved.
  stats JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS formula_systems_slug_idx ON formula_systems (slug);
