-- 0001 — Broadcast: broadcast sets and character roster
-- ============================================================================
-- Idempotent: it can be reapplied without breaking anything.
--
-- This kon had no migrations: its tables came from the schema merge and from
-- `drizzle push`. That works in development, but it leaves the kon with no way
-- to install itself on its own —which is exactly what a kon must be able to do—
-- and with no place to read the table's real shape without running TypeScript.

CREATE TABLE IF NOT EXISTS broadcast_matches (
  id TEXT PRIMARY KEY,

  event_title TEXT NOT NULL DEFAULT 'TORNEO',
  round TEXT NOT NULL DEFAULT 'Winners Finals',
  first_to INTEGER NOT NULL DEFAULT 3,

  -- Game profile the set was created with (`2xko`, `sf6`, `1v1`…).
  -- It is stored IN THE ROW because it defines the shape of side_a/side_b: if it
  -- lived only in the settings, changing the tournament's game would reinterpret
  -- the payload of sets already played and the VODs would stop matching.
  profile_id TEXT,

  -- Polymorphic by design: each game profile defines its own shape and
  -- validates it with its Zod schema. What was game-specific was the
  -- TypeScript type, never the table.
  side_a JSONB NOT NULL,
  side_b JSONB NOT NULL,

  casters JSONB NOT NULL DEFAULT '[]',
  screens JSONB NOT NULL,

  -- Set on air: at most one per operator.
  live BOOLEAN NOT NULL DEFAULT false,

  -- Top caption. One field, not a queue: there is one current message and the
  -- operator overwrites it or clears it.
  ticker TEXT,

  startgg_set_id TEXT,

  -- The `kon-esports` bracket set it was built from. No foreign key: that
  -- kon may not be installed, and an FK between kons would make it impossible
  -- to create this table without it — exactly the coupling the dynamic bridge avoids.
  -- `bracket_match_id` (`W2M1`) is only unique WITHIN a tournament, so the two
  -- go together or they identify nothing.
  tournament_id TEXT,
  bracket_match_id TEXT,

  status TEXT NOT NULL DEFAULT 'draft',

  -- Used by the "broadcast" policy (isolation by owner) and by RLS.
  owner_id TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broadcast_matches_owner_live_idx
  ON broadcast_matches (owner_id, live);

-- The TO's panel asks "which sets of this tournament have I built?" every time
-- it opens; without this it is a scan of the whole table.
CREATE INDEX IF NOT EXISTS broadcast_matches_tournament_idx
  ON broadcast_matches (tournament_id, bracket_match_id);

-- ── Character roster ─────────────────────────────────────────────────────────
-- Fighting games have NO public CDN equivalent to Data Dragon, so the roster
-- and its portraits are loaded here and served from `kon-media`.
CREATE TABLE IF NOT EXISTS broadcast_champions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  season INTEGER NOT NULL DEFAULT 1,
  portrait_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broadcast_champions_sort_idx
  ON broadcast_champions (sort_order);
