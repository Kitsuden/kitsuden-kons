-- RLS for kon-character-builder after the English rename: functions, triggers and policies come back with the new names.
--
-- The previous file dropped the old ones; between both files the tables stay closed, not open.

-- Policies, with the new names and the core's English helpers.
DROP POLICY IF EXISTS builder_builds_lectura_publica ON builder_builds;
DROP POLICY IF EXISTS builder_builds_public_select ON builder_builds;
CREATE POLICY builder_builds_public_select ON builder_builds AS PERMISSIVE FOR SELECT USING ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])));
