-- 0014 — Guest registration off by default (audit 2026-10-25)
-- ============================================================================
-- Only the DEFAULT changes: existing tournaments keep their value.
ALTER TABLE esports_tournaments ALTER COLUMN allow_guest_registration SET DEFAULT false;
