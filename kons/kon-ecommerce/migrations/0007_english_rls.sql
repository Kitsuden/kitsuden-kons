-- RLS for kon-ecommerce after the English rename: functions, triggers and policies come back with the new names.
--
-- The previous file dropped the old ones; between both files the tables stay closed, not open.

-- Functions: their bodies are text, so a rename does not reach them.
CREATE OR REPLACE FUNCTION shop_agent_can(p_req text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT kitsuden_agent_can_in_kon('ecommerce', p_req)
$function$;

-- Policies, with the new names and the core's English helpers.
DROP POLICY IF EXISTS shop_order_items_agent_cambia ON shop_order_items;
DROP POLICY IF EXISTS shop_order_items_agent_changes ON shop_order_items;
CREATE POLICY shop_order_items_agent_changes ON shop_order_items AS PERMISSIVE FOR UPDATE USING (shop_agent_can('shop-order:update'::text)) WITH CHECK (shop_agent_can('shop-order:update'::text));
DROP POLICY IF EXISTS shop_order_items_agent_lee ON shop_order_items;
DROP POLICY IF EXISTS shop_order_items_agent_reads ON shop_order_items;
CREATE POLICY shop_order_items_agent_reads ON shop_order_items AS PERMISSIVE FOR SELECT USING ((shop_agent_can('shop-order:view'::text) OR shop_agent_can('shop-order:update'::text)));
DROP POLICY IF EXISTS shop_order_items_team ON shop_order_items;
CREATE POLICY shop_order_items_team ON shop_order_items AS PERMISSIVE FOR ALL USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = ANY (ARRAY['admin'::text, 'editor'::text])))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = ANY (ARRAY['admin'::text, 'editor'::text]))));
DROP POLICY IF EXISTS shop_orders_agent_cambia ON shop_orders;
DROP POLICY IF EXISTS shop_orders_agent_changes ON shop_orders;
CREATE POLICY shop_orders_agent_changes ON shop_orders AS PERMISSIVE FOR UPDATE USING (shop_agent_can('shop-order:update'::text)) WITH CHECK (shop_agent_can('shop-order:update'::text));
DROP POLICY IF EXISTS shop_orders_agent_lee ON shop_orders;
DROP POLICY IF EXISTS shop_orders_agent_reads ON shop_orders;
CREATE POLICY shop_orders_agent_reads ON shop_orders AS PERMISSIVE FOR SELECT USING ((shop_agent_can('shop-order:view'::text) OR shop_agent_can('shop-order:update'::text)));
DROP POLICY IF EXISTS shop_orders_team ON shop_orders;
CREATE POLICY shop_orders_team ON shop_orders AS PERMISSIVE FOR ALL USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = ANY (ARRAY['admin'::text, 'editor'::text])))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = ANY (ARRAY['admin'::text, 'editor'::text]))));
