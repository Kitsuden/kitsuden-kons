-- RLS for kon-dms after the English rename: functions, triggers and policies come back with the new names.
--
-- The previous file dropped the old ones; between both files the tables stay closed, not open.

-- Functions: their bodies are text, so a rename does not reach them.
CREATE OR REPLACE FUNCTION dms_role()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$ SELECT coalesce(current_setting('app.current_user_role', true), '') $function$;

CREATE OR REPLACE FUNCTION dms_is_system()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
    SELECT (COALESCE(current_setting('app.current_user_id', true), '') = ''
            AND COALESCE(current_setting('app.current_user_role', true), '') = '')
        OR kitsuden_effective_admin('dms')
$function$;

-- Policies, with the new names and the core's English helpers.
DROP POLICY IF EXISTS dms_access_log_dms_insert ON dms_access_log;
CREATE POLICY dms_access_log_dms_insert ON dms_access_log AS PERMISSIVE FOR INSERT WITH CHECK ((dms_is_system() OR (user_id = dms_uid())));
DROP POLICY IF EXISTS dms_access_log_dms_lee ON dms_access_log;
DROP POLICY IF EXISTS dms_access_log_dms_select ON dms_access_log;
CREATE POLICY dms_access_log_dms_select ON dms_access_log AS PERMISSIVE FOR SELECT USING ((dms_is_system() OR (user_id = dms_uid())));
DROP POLICY IF EXISTS dms_document_comments_dms_insert ON dms_document_comments;
CREATE POLICY dms_document_comments_dms_insert ON dms_document_comments AS PERMISSIVE FOR INSERT WITH CHECK ((dms_is_system() OR ((user_id = dms_uid()) AND (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE (d.id = dms_document_comments.document_id))))));
DROP POLICY IF EXISTS dms_document_comments_dms_delete ON dms_document_comments;
CREATE POLICY dms_document_comments_dms_delete ON dms_document_comments AS PERMISSIVE FOR DELETE USING ((dms_is_system() OR (user_id = dms_uid()) OR (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE ((d.id = dms_document_comments.document_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid())))))));
DROP POLICY IF EXISTS dms_document_comments_dms_update ON dms_document_comments;
CREATE POLICY dms_document_comments_dms_update ON dms_document_comments AS PERMISSIVE FOR UPDATE USING ((dms_is_system() OR (user_id = dms_uid()) OR (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE ((d.id = dms_document_comments.document_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid())))))));
DROP POLICY IF EXISTS dms_document_comments_dms_lee ON dms_document_comments;
DROP POLICY IF EXISTS dms_document_comments_dms_select ON dms_document_comments;
CREATE POLICY dms_document_comments_dms_select ON dms_document_comments AS PERMISSIVE FOR SELECT USING ((dms_is_system() OR ((EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE (d.id = dms_document_comments.document_id))) AND ((version_id IS NULL) OR (EXISTS ( SELECT 1
   FROM dms_document_versions v
  WHERE (v.id = dms_document_comments.version_id)))))));
DROP POLICY IF EXISTS dms_document_diagrams_dms_insert ON dms_document_diagrams;
CREATE POLICY dms_document_diagrams_dms_insert ON dms_document_diagrams AS PERMISSIVE FOR INSERT WITH CHECK ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM (dms_document_versions v
     JOIN dms_documents d ON ((d.id = v.document_id)))
  WHERE ((v.id = dms_document_diagrams.version_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid())))))));
DROP POLICY IF EXISTS dms_document_diagrams_dms_delete ON dms_document_diagrams;
CREATE POLICY dms_document_diagrams_dms_delete ON dms_document_diagrams AS PERMISSIVE FOR DELETE USING ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM (dms_document_versions v
     JOIN dms_documents d ON ((d.id = v.document_id)))
  WHERE ((v.id = dms_document_diagrams.version_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid())))))));
DROP POLICY IF EXISTS dms_document_diagrams_dms_update ON dms_document_diagrams;
CREATE POLICY dms_document_diagrams_dms_update ON dms_document_diagrams AS PERMISSIVE FOR UPDATE USING ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM (dms_document_versions v
     JOIN dms_documents d ON ((d.id = v.document_id)))
  WHERE ((v.id = dms_document_diagrams.version_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid())))))));
DROP POLICY IF EXISTS dms_document_diagrams_dms_lee ON dms_document_diagrams;
DROP POLICY IF EXISTS dms_document_diagrams_dms_select ON dms_document_diagrams;
CREATE POLICY dms_document_diagrams_dms_select ON dms_document_diagrams AS PERMISSIVE FOR SELECT USING ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM dms_document_versions v
  WHERE (v.id = dms_document_diagrams.version_id)))));
DROP POLICY IF EXISTS dms_document_files_dms_insert ON dms_document_files;
CREATE POLICY dms_document_files_dms_insert ON dms_document_files AS PERMISSIVE FOR INSERT WITH CHECK ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE ((d.id = dms_document_files.document_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid())))))));
DROP POLICY IF EXISTS dms_document_files_dms_delete ON dms_document_files;
CREATE POLICY dms_document_files_dms_delete ON dms_document_files AS PERMISSIVE FOR DELETE USING ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE ((d.id = dms_document_files.document_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid())))))));
DROP POLICY IF EXISTS dms_document_files_dms_update ON dms_document_files;
CREATE POLICY dms_document_files_dms_update ON dms_document_files AS PERMISSIVE FOR UPDATE USING ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE ((d.id = dms_document_files.document_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid())))))));
DROP POLICY IF EXISTS dms_document_files_dms_lee ON dms_document_files;
DROP POLICY IF EXISTS dms_document_files_dms_select ON dms_document_files;
CREATE POLICY dms_document_files_dms_select ON dms_document_files AS PERMISSIVE FOR SELECT USING ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM dms_document_versions v
  WHERE (v.id = dms_document_files.version_id)))));
DROP POLICY IF EXISTS dms_document_relations_dms_insert ON dms_document_relations;
CREATE POLICY dms_document_relations_dms_insert ON dms_document_relations AS PERMISSIVE FOR INSERT WITH CHECK ((dms_is_system() OR ((EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE ((d.id = dms_document_relations.source_document_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid()))))) AND (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE (d.id = dms_document_relations.target_document_id))))));
DROP POLICY IF EXISTS dms_document_relations_dms_delete ON dms_document_relations;
CREATE POLICY dms_document_relations_dms_delete ON dms_document_relations AS PERMISSIVE FOR DELETE USING ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE ((d.id = dms_document_relations.source_document_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid())))))));
DROP POLICY IF EXISTS dms_document_relations_dms_lee ON dms_document_relations;
DROP POLICY IF EXISTS dms_document_relations_dms_select ON dms_document_relations;
CREATE POLICY dms_document_relations_dms_select ON dms_document_relations AS PERMISSIVE FOR SELECT USING ((dms_is_system() OR ((EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE (d.id = dms_document_relations.source_document_id))) AND (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE (d.id = dms_document_relations.target_document_id))))));
DROP POLICY IF EXISTS dms_document_slug_history_dms_insert ON dms_document_slug_history;
CREATE POLICY dms_document_slug_history_dms_insert ON dms_document_slug_history AS PERMISSIVE FOR INSERT WITH CHECK ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE ((d.id = dms_document_slug_history.document_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid())))))));
DROP POLICY IF EXISTS dms_document_slug_history_dms_lee ON dms_document_slug_history;
DROP POLICY IF EXISTS dms_document_slug_history_dms_select ON dms_document_slug_history;
CREATE POLICY dms_document_slug_history_dms_select ON dms_document_slug_history AS PERMISSIVE FOR SELECT USING ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE (d.id = dms_document_slug_history.document_id)))));
DROP POLICY IF EXISTS dms_document_versions_dms_insert ON dms_document_versions;
CREATE POLICY dms_document_versions_dms_insert ON dms_document_versions AS PERMISSIVE FOR INSERT WITH CHECK ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE ((d.id = dms_document_versions.document_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid())))))));
DROP POLICY IF EXISTS dms_document_versions_dms_delete ON dms_document_versions;
CREATE POLICY dms_document_versions_dms_delete ON dms_document_versions AS PERMISSIVE FOR DELETE USING (dms_is_system());
DROP POLICY IF EXISTS dms_document_versions_dms_update ON dms_document_versions;
CREATE POLICY dms_document_versions_dms_update ON dms_document_versions AS PERMISSIVE FOR UPDATE USING ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE ((d.id = dms_document_versions.document_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid()) OR (d.reviewer_ids @> jsonb_build_array(dms_uid())) OR (d.approver_ids @> jsonb_build_array(dms_uid())))))))) WITH CHECK ((dms_is_system() OR (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE ((d.id = dms_document_versions.document_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid()) OR (d.reviewer_ids @> jsonb_build_array(dms_uid())) OR (d.approver_ids @> jsonb_build_array(dms_uid()))))))));
DROP POLICY IF EXISTS dms_document_versions_dms_lee ON dms_document_versions;
DROP POLICY IF EXISTS dms_document_versions_dms_select ON dms_document_versions;
CREATE POLICY dms_document_versions_dms_select ON dms_document_versions AS PERMISSIVE FOR SELECT USING ((dms_is_system() OR ((status = 'published'::dms_version_status) AND (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE (d.id = dms_document_versions.document_id)))) OR (EXISTS ( SELECT 1
   FROM dms_documents d
  WHERE ((d.id = dms_document_versions.document_id) AND ((d.owner_id = dms_uid()) OR (d.created_by_id = dms_uid()) OR (d.reviewer_ids @> jsonb_build_array(dms_uid())) OR (d.approver_ids @> jsonb_build_array(dms_uid()))))))));
DROP POLICY IF EXISTS dms_documents_dms_insert ON dms_documents;
CREATE POLICY dms_documents_dms_insert ON dms_documents AS PERMISSIVE FOR INSERT WITH CHECK ((dms_is_system() OR (owner_id = dms_uid()) OR (created_by_id = dms_uid())));
DROP POLICY IF EXISTS dms_documents_dms_delete ON dms_documents;
CREATE POLICY dms_documents_dms_delete ON dms_documents AS PERMISSIVE FOR DELETE USING (dms_is_system());
DROP POLICY IF EXISTS dms_documents_dms_update ON dms_documents;
CREATE POLICY dms_documents_dms_update ON dms_documents AS PERMISSIVE FOR UPDATE USING ((dms_is_system() OR (owner_id = dms_uid()) OR (created_by_id = dms_uid()) OR (approver_ids @> jsonb_build_array(dms_uid())))) WITH CHECK ((dms_is_system() OR (owner_id = dms_uid()) OR (created_by_id = dms_uid()) OR (approver_ids @> jsonb_build_array(dms_uid()))));
DROP POLICY IF EXISTS dms_documents_dms_lee ON dms_documents;
DROP POLICY IF EXISTS dms_documents_dms_select ON dms_documents;
CREATE POLICY dms_documents_dms_select ON dms_documents AS PERMISSIVE FOR SELECT USING ((dms_is_system() OR (owner_id = dms_uid()) OR (created_by_id = dms_uid()) OR (reviewer_ids @> jsonb_build_array(dms_uid())) OR (approver_ids @> jsonb_build_array(dms_uid())) OR (allowed_user_ids @> jsonb_build_array(dms_uid())) OR (((visibility)::text <> 'private'::text) AND ((allowed_role_ids @> jsonb_build_array(dms_role())) OR ((category_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM dms_categories c
  WHERE ((c.id = dms_documents.category_id) AND (c.allowed_roles @> jsonb_build_array(dms_role())))))) OR ((status = 'published'::dms_document_status) AND ((visibility)::text = 'public'::text)) OR ((status = 'published'::dms_document_status) AND ((visibility)::text = 'internal'::text) AND (dms_role() = ANY (ARRAY['admin'::text, 'editor'::text])))))));
