-- 0002 — Lost reason on deals
-- ============================================================================
-- Without this field, funnel analytics can say HOW MUCH is lost and WHERE,
-- but never WHY, which is the only one of the three questions that lets you
-- change something.
--
-- Free text and not an enum on purpose: every business loses for its own reasons,
-- and an enum would force a schema migration to add a new one.
-- Idempotent.

ALTER TABLE crm_deals ADD COLUMN IF NOT EXISTS lost_reason TEXT;
ALTER TABLE crm_deals ADD COLUMN IF NOT EXISTS lost_notes TEXT;

-- Grouping by reason is the query that justifies the field.
CREATE INDEX IF NOT EXISTS crm_deals_lost_reason_idx
  ON crm_deals (lost_reason) WHERE lost_reason IS NOT NULL;
