-- 0004 — Round robin as a tournament format
-- ============================================================================
-- Idempotent.
--
-- Group sets reuse `esports_matches`: the matchday goes in `round`, the table
-- in `match_order` and the engine id (`RR2M1`) in `bracket_match_id` — the
-- same reconciliation key as elimination, so Broadcast references group sets
-- and bracket sets with the same field.

ALTER TYPE esports_bracket_format ADD VALUE IF NOT EXISTS 'round_robin';
