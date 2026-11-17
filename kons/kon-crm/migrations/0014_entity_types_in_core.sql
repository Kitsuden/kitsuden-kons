-- 0014 — A deal's entity type can live in Kitsuden's entities
-- Idempotent.
--
-- On a Kitsuden with runtime entities, kon-crm keeps its entity types there (crm.entitystore.ts) and stops
-- reading crm_entity_configs. A deal's entity_config_id then holds the type's id: the old row id for a type
-- moved from the table, or the entity's slug (`crm-case`) for one created in the core. The foreign key to
-- crm_entity_configs would refuse the second, so it goes. The table and its rows stay: a type that could
-- not be moved is still read from it, and nothing is lost if the kon runs on an older Kitsuden again.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'crm_deals'::regclass AND con.contype = 'f' AND att.attname = 'entity_config_id'
  LOOP
    EXECUTE format('ALTER TABLE crm_deals DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
