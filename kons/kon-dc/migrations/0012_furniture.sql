-- kon-dc — furniture: a catalog kind the Housing module places in members' homes
-- ============================================================================
-- The kind list is a CHECK on dc_items (0003). Postgres named that column check
-- dc_items_kind_check; it is replaced by one that also allows 'furniture'.

ALTER TABLE dc_items DROP CONSTRAINT IF EXISTS dc_items_kind_check;
ALTER TABLE dc_items ADD CONSTRAINT dc_items_kind_check
  CHECK (kind IN ('item', 'consumable', 'role', 'badge', 'background', 'pet', 'furniture'));
