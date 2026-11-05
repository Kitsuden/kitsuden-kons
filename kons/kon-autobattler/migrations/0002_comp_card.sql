-- What a comp card shows that cannot be computed
-- ============================================================================
-- A comp's card shows two things that do NOT come from the board:
--
--   · The CAROUSEL priority: which component to take first. It depends on which
--     unit carries it and which one arrives earlier in the game.
--   · The CORE units, which are marked inside `slots`.
--
-- Both are the judgment of whoever writes the guide. Deriving them from synergies
-- would give the wrong list: a unit can be essential because of its
-- ability without contributing any rare trait.
--
-- `core` needs no column: it lives in each element of `slots`, which is already JSON.

ALTER TABLE autobattler_comps
  ADD COLUMN IF NOT EXISTS carousel JSONB NOT NULL DEFAULT '[]'::jsonb;
