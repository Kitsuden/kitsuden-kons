-- English names for kon-ecommerce: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS shop_order_items_agente_cambia ON shop_order_items;
DROP POLICY IF EXISTS shop_order_items_agente_lee ON shop_order_items;
DROP POLICY IF EXISTS shop_order_items_equipo ON shop_order_items;
DROP POLICY IF EXISTS shop_orders_agente_cambia ON shop_orders;
DROP POLICY IF EXISTS shop_orders_agente_lee ON shop_orders;
DROP POLICY IF EXISTS shop_orders_equipo ON shop_orders;

-- Functions whose name or parameters change.
DROP FUNCTION IF EXISTS shop_agente_puede(text);

-- Constraints.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('shop_order_items', 'shop_order_items_cantidad_positiva', 'shop_order_items_quantity_positive'),
    ('shop_orders', 'shop_orders_envio_con_direccion', 'shop_orders_shipping_has_address'),
    ('shop_variants', 'shop_variants_stock_no_negativo', 'shop_variants_stock_non_negative')
  ) AS v(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = r.tbl AND c.conname = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = r.tbl AND c.conname = r.new_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Default values of new rows.
ALTER TABLE shop_variants ALTER COLUMN name SET DEFAULT 'Standard';

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:ecommerce:listar-productos":"kon:ecommerce:list-products","ecommerce:listar-productos":"ecommerce:list-products","ecommerce__listar-productos":"ecommerce__list-products","kon:ecommerce:ver-producto":"kon:ecommerce:get-product","ecommerce:ver-producto":"ecommerce:get-product","ecommerce__ver-producto":"ecommerce__get-product","kon:ecommerce:crear-pedido":"kon:ecommerce:create-order","ecommerce:crear-pedido":"ecommerce:create-order","ecommerce__crear-pedido":"ecommerce__create-order","kon:ecommerce:listar-productos-del-panel":"kon:ecommerce:list-panel-products","ecommerce:listar-productos-del-panel":"ecommerce:list-panel-products","ecommerce__listar-productos-del-panel":"ecommerce__list-panel-products","kon:ecommerce:crear-producto":"kon:ecommerce:create-product","ecommerce:crear-producto":"ecommerce:create-product","ecommerce__crear-producto":"ecommerce__create-product","kon:ecommerce:editar-producto":"kon:ecommerce:update-product","ecommerce:editar-producto":"ecommerce:update-product","ecommerce__editar-producto":"ecommerce__update-product","kon:ecommerce:borrar-producto":"kon:ecommerce:delete-product","ecommerce:borrar-producto":"ecommerce:delete-product","ecommerce__borrar-producto":"ecommerce__delete-product","kon:ecommerce:crear-variante":"kon:ecommerce:create-variant","ecommerce:crear-variante":"ecommerce:create-variant","ecommerce__crear-variante":"ecommerce__create-variant","kon:ecommerce:editar-variante":"kon:ecommerce:update-variant","ecommerce:editar-variante":"ecommerce:update-variant","ecommerce__editar-variante":"ecommerce__update-variant","kon:ecommerce:listar-pedidos":"kon:ecommerce:list-orders","ecommerce:listar-pedidos":"ecommerce:list-orders","ecommerce__listar-pedidos":"ecommerce__list-orders","kon:ecommerce:ver-pedido":"kon:ecommerce:get-order","ecommerce:ver-pedido":"ecommerce:get-order","ecommerce__ver-pedido":"ecommerce__get-order","kon:ecommerce:cambiar-estado-de-pedido":"kon:ecommerce:change-order-status","ecommerce:cambiar-estado-de-pedido":"ecommerce:change-order-status","ecommerce__cambiar-estado-de-pedido":"ecommerce__change-order-status"}'::jsonb;
  ops jsonb := '{"listar-productos":"list-products","ver-producto":"get-product","crear-pedido":"create-order","listar-productos-del-panel":"list-panel-products","crear-producto":"create-product","editar-producto":"update-product","borrar-producto":"delete-product","crear-variante":"create-variant","editar-variante":"update-variant","listar-pedidos":"list-orders","ver-pedido":"get-order","cambiar-estado-de-pedido":"change-order-status"}'::jsonb;
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('agent_identities', 'scopes'), ('agent_identities', 'allowed_tools'), ('agent_proposals', 'scopes'),
    ('oauth_authorization_requests', 'requested_scopes'), ('oauth_codes', 'scopes'), ('oauth_grants', 'scopes'), ('oauth_tokens', 'scopes')
  ) AS v(tbl, col) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t.tbl AND column_name = t.col) THEN
      EXECUTE format($f$
        UPDATE %1$I SET %2$I = (
          SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e) <> 'string' THEN e
                                         WHEN left(e #>> '{}', 1) = '!' THEN to_jsonb('!' || coalesce($1 ->> substr(e #>> '{}', 2), substr(e #>> '{}', 2)))
                                         ELSE to_jsonb(coalesce($1 ->> (e #>> '{}'), e #>> '{}')) END), '[]'::jsonb)
          FROM jsonb_array_elements(%2$I) AS e)
        WHERE jsonb_typeof(%2$I) = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(%2$I) AS e
          WHERE jsonb_typeof(e) = 'string' AND $1 ? ltrim(e #>> '{}', '!'))
      $f$, t.tbl, t.col) USING m;
    END IF;
  END LOOP;
  IF to_regclass('public.agent_proposals') IS NOT NULL THEN
    UPDATE agent_proposals SET
        operation_key = coalesce(m ->> operation_key, operation_key),
        tool = coalesce(m ->> tool, tool),
        operation_id = coalesce(ops ->> operation_id, operation_id)
      WHERE status = 'pending' AND (m ? coalesce(operation_key, '') OR m ? coalesce(tool, ''));
  END IF;
END $$;
