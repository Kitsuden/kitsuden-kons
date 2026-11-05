-- RLS for kon-tierlist after the English rename: functions, triggers and policies come back with the new names.
--
-- The previous file dropped the old ones; between both files the tables stay closed, not open.

-- Policies, with the new names and the core's English helpers.
DROP POLICY IF EXISTS tier_lists_plantillas_lectura ON tier_lists;
DROP POLICY IF EXISTS tier_lists_templates_select ON tier_lists;
CREATE POLICY tier_lists_templates_select ON tier_lists AS PERMISSIVE FOR SELECT USING ((kind <> 'personal'::text));
DROP POLICY IF EXISTS tier_lists_plantillas_edicion ON tier_lists;
DROP POLICY IF EXISTS tier_lists_templates_edit ON tier_lists;
CREATE POLICY tier_lists_templates_edit ON tier_lists AS PERMISSIVE FOR ALL USING (((kind <> 'personal'::text) AND (current_setting('app.current_user_role'::text, true) = ANY (ARRAY['admin'::text, 'editor'::text, 'agent'::text])))) WITH CHECK (((kind <> 'personal'::text) AND (current_setting('app.current_user_role'::text, true) = ANY (ARRAY['admin'::text, 'editor'::text, 'agent'::text]))));
