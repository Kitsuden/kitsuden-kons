-- English names for kon-dms: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS dms_access_log_dms_alta ON dms_access_log;
DROP POLICY IF EXISTS dms_access_log_dms_lee ON dms_access_log;
DROP POLICY IF EXISTS dms_document_comments_dms_alta ON dms_document_comments;
DROP POLICY IF EXISTS dms_document_comments_dms_borra ON dms_document_comments;
DROP POLICY IF EXISTS dms_document_comments_dms_cambia ON dms_document_comments;
DROP POLICY IF EXISTS dms_document_comments_dms_lee ON dms_document_comments;
DROP POLICY IF EXISTS dms_document_diagrams_dms_alta ON dms_document_diagrams;
DROP POLICY IF EXISTS dms_document_diagrams_dms_borra ON dms_document_diagrams;
DROP POLICY IF EXISTS dms_document_diagrams_dms_cambia ON dms_document_diagrams;
DROP POLICY IF EXISTS dms_document_diagrams_dms_lee ON dms_document_diagrams;
DROP POLICY IF EXISTS dms_document_files_dms_alta ON dms_document_files;
DROP POLICY IF EXISTS dms_document_files_dms_borra ON dms_document_files;
DROP POLICY IF EXISTS dms_document_files_dms_cambia ON dms_document_files;
DROP POLICY IF EXISTS dms_document_files_dms_lee ON dms_document_files;
DROP POLICY IF EXISTS dms_document_relations_dms_alta ON dms_document_relations;
DROP POLICY IF EXISTS dms_document_relations_dms_borra ON dms_document_relations;
DROP POLICY IF EXISTS dms_document_relations_dms_lee ON dms_document_relations;
DROP POLICY IF EXISTS dms_document_slug_history_dms_alta ON dms_document_slug_history;
DROP POLICY IF EXISTS dms_document_slug_history_dms_lee ON dms_document_slug_history;
DROP POLICY IF EXISTS dms_document_versions_dms_alta ON dms_document_versions;
DROP POLICY IF EXISTS dms_document_versions_dms_borra ON dms_document_versions;
DROP POLICY IF EXISTS dms_document_versions_dms_cambia ON dms_document_versions;
DROP POLICY IF EXISTS dms_document_versions_dms_lee ON dms_document_versions;
DROP POLICY IF EXISTS dms_documents_dms_alta ON dms_documents;
DROP POLICY IF EXISTS dms_documents_dms_borra ON dms_documents;
DROP POLICY IF EXISTS dms_documents_dms_cambia ON dms_documents;
DROP POLICY IF EXISTS dms_documents_dms_lee ON dms_documents;

-- Functions whose name or parameters change.
DROP FUNCTION IF EXISTS dms_rol();
DROP FUNCTION IF EXISTS dms_sistema();

-- Indexes.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('dms_doc_versions_doc_ver_idx', 'dms_doc_versions_doc_version_idx')
  ) AS v(old_name, new_name) LOOP
    IF to_regclass('public.' || quote_ident(r.old_name)) IS NOT NULL AND to_regclass('public.' || quote_ident(r.new_name)) IS NULL THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"dms:crear":"dms:create","dms:carpetas":"dms:folders","kon:dms:listar-carpetas":"kon:dms:list-folders","dms:listar-carpetas":"dms:list-folders","dms__listar-carpetas":"dms__list-folders","kon:dms:crear-carpeta":"kon:dms:create-folder","dms:crear-carpeta":"dms:create-folder","dms__crear-carpeta":"dms__create-folder","kon:dms:ver-arbol-de-carpetas":"kon:dms:get-folder-tree","dms:ver-arbol-de-carpetas":"dms:get-folder-tree","dms__ver-arbol-de-carpetas":"dms__get-folder-tree","kon:dms:listar-documentos":"kon:dms:list-documents","dms:listar-documentos":"dms:list-documents","dms__listar-documentos":"dms__list-documents","kon:dms:crear-documento":"kon:dms:create-document","dms:crear-documento":"dms:create-document","dms__crear-documento":"dms__create-document","kon:dms:ver-documento":"kon:dms:get-document","dms:ver-documento":"dms:get-document","dms__ver-documento":"dms__get-document","kon:dms:editar-documento":"kon:dms:update-document","dms:editar-documento":"dms:update-document","dms__editar-documento":"dms__update-document","kon:dms:archivar-documento":"kon:dms:archive-document","dms:archivar-documento":"dms:archive-document","dms__archivar-documento":"dms__archive-document","kon:dms:crear-documento-desde-plantilla":"kon:dms:create-document-from-template","dms:crear-documento-desde-plantilla":"dms:create-document-from-template","dms__crear-documento-desde-plantilla":"dms__create-document-from-template","kon:dms:listar-versiones":"kon:dms:list-versions","dms:listar-versiones":"dms:list-versions","dms__listar-versiones":"dms__list-versions","kon:dms:crear-version":"kon:dms:create-version","dms:crear-version":"dms:create-version","dms__crear-version":"dms__create-version","kon:dms:ver-version":"kon:dms:get-version","dms:ver-version":"dms:get-version","dms__ver-version":"dms__get-version","kon:dms:editar-version":"kon:dms:update-version","dms:editar-version":"dms:update-version","dms__editar-version":"dms__update-version","kon:dms:enviar-version-a-revision":"kon:dms:submit-version-for-review","dms:enviar-version-a-revision":"dms:submit-version-for-review","dms__enviar-version-a-revision":"dms__submit-version-for-review","kon:dms:revisar-version":"kon:dms:review-version","dms:revisar-version":"dms:review-version","dms__revisar-version":"dms__review-version","kon:dms:publicar-version":"kon:dms:publish-version","dms:publicar-version":"dms:publish-version","dms__publicar-version":"dms__publish-version","kon:dms:subir-fichero":"kon:dms:upload-file","dms:subir-fichero":"dms:upload-file","dms__subir-fichero":"dms__upload-file","kon:dms:descargar-fichero":"kon:dms:download-file","dms:descargar-fichero":"dms:download-file","dms__descargar-fichero":"dms__download-file","kon:dms:crear-relacion":"kon:dms:create-relation","dms:crear-relacion":"dms:create-relation","dms__crear-relacion":"dms__create-relation","kon:dms:confirmar-lectura":"kon:dms:acknowledge-read","dms:confirmar-lectura":"dms:acknowledge-read","dms__confirmar-lectura":"dms__acknowledge-read","kon:dms:listar-confirmaciones-de-lectura":"kon:dms:list-read-acknowledgments","dms:listar-confirmaciones-de-lectura":"dms:list-read-acknowledgments","dms__listar-confirmaciones-de-lectura":"dms__list-read-acknowledgments","kon:dms:listar-comentarios":"kon:dms:list-comments","dms:listar-comentarios":"dms:list-comments","dms__listar-comentarios":"dms__list-comments","kon:dms:crear-comentario":"kon:dms:create-comment","dms:crear-comentario":"dms:create-comment","dms__crear-comentario":"dms__create-comment","kon:dms:editar-comentario":"kon:dms:update-comment","dms:editar-comentario":"dms:update-comment","dms__editar-comentario":"dms__update-comment","kon:dms:borrar-comentario":"kon:dms:delete-comment","dms:borrar-comentario":"dms:delete-comment","dms__borrar-comentario":"dms__delete-comment","kon:dms:resolver-comentario":"kon:dms:resolve-comment","dms:resolver-comentario":"dms:resolve-comment","dms__resolver-comentario":"dms__resolve-comment","kon:dms:listar-enlaces-entrantes":"kon:dms:list-incoming-links","dms:listar-enlaces-entrantes":"dms:list-incoming-links","dms__listar-enlaces-entrantes":"dms__list-incoming-links","kon:dms:exportar-version-html":"kon:dms:export-version-html","dms:exportar-version-html":"dms:export-version-html","dms__exportar-version-html":"dms__export-version-html","kon:dms:exportar-version-markdown":"kon:dms:export-version-markdown","dms:exportar-version-markdown":"dms:export-version-markdown","dms__exportar-version-markdown":"dms__export-version-markdown","kon:dms:exportar-carpeta":"kon:dms:export-folder","dms:exportar-carpeta":"dms:export-folder","dms__exportar-carpeta":"dms__export-folder","kon:dms:listar-diagramas":"kon:dms:list-diagrams","dms:listar-diagramas":"dms:list-diagrams","dms__listar-diagramas":"dms__list-diagrams","kon:dms:crear-diagrama":"kon:dms:create-diagram","dms:crear-diagrama":"dms:create-diagram","dms__crear-diagrama":"dms__create-diagram","kon:dms:editar-diagrama":"kon:dms:update-diagram","dms:editar-diagrama":"dms:update-diagram","dms__editar-diagrama":"dms__update-diagram","kon:dms:borrar-diagrama":"kon:dms:delete-diagram","dms:borrar-diagrama":"dms:delete-diagram","dms__borrar-diagrama":"dms__delete-diagram","kon:dms:importar-documentos":"kon:dms:import-documents","dms:importar-documentos":"dms:import-documents","dms__importar-documentos":"dms__import-documents","kon:dms:ver-auditoria":"kon:dms:get-audit","dms:ver-auditoria":"dms:get-audit","dms__ver-auditoria":"dms__get-audit","kon:dms:listar-avisos":"kon:dms:list-notices","dms:listar-avisos":"dms:list-notices","dms__listar-avisos":"dms__list-notices","kon:dms:marcar-aviso-leido":"kon:dms:mark-notice-read","dms:marcar-aviso-leido":"dms:mark-notice-read","dms__marcar-aviso-leido":"dms__mark-notice-read","kon:dms:marcar-avisos-leidos":"kon:dms:mark-notices-read","dms:marcar-avisos-leidos":"dms:mark-notices-read","dms__marcar-avisos-leidos":"dms__mark-notices-read","kon:dms:leer-documento":"kon:dms:read-document","dms:leer-documento":"dms:read-document","dms__leer-documento":"dms__read-document","kon:dms:abrir-documento-por-codigo":"kon:dms:open-document-by-code","dms:abrir-documento-por-codigo":"dms:open-document-by-code","dms__abrir-documento-por-codigo":"dms__open-document-by-code","kon:dms:ver-estadisticas":"kon:dms:get-stats","dms:ver-estadisticas":"dms:get-stats","dms__ver-estadisticas":"dms__get-stats","kon:dms:buscar-documentos":"kon:dms:search-documents","dms:buscar-documentos":"dms:search-documents","dms__buscar-documentos":"dms__search-documents"}'::jsonb;
  ops jsonb := '{"listar-carpetas":"list-folders","crear-carpeta":"create-folder","ver-arbol-de-carpetas":"get-folder-tree","listar-documentos":"list-documents","crear-documento":"create-document","ver-documento":"get-document","editar-documento":"update-document","archivar-documento":"archive-document","crear-documento-desde-plantilla":"create-document-from-template","listar-versiones":"list-versions","crear-version":"create-version","ver-version":"get-version","editar-version":"update-version","enviar-version-a-revision":"submit-version-for-review","revisar-version":"review-version","publicar-version":"publish-version","subir-fichero":"upload-file","descargar-fichero":"download-file","crear-relacion":"create-relation","confirmar-lectura":"acknowledge-read","listar-confirmaciones-de-lectura":"list-read-acknowledgments","listar-comentarios":"list-comments","crear-comentario":"create-comment","editar-comentario":"update-comment","borrar-comentario":"delete-comment","resolver-comentario":"resolve-comment","listar-enlaces-entrantes":"list-incoming-links","exportar-version-html":"export-version-html","exportar-version-markdown":"export-version-markdown","exportar-carpeta":"export-folder","listar-diagramas":"list-diagrams","crear-diagrama":"create-diagram","editar-diagrama":"update-diagram","borrar-diagrama":"delete-diagram","importar-documentos":"import-documents","ver-auditoria":"get-audit","listar-avisos":"list-notices","marcar-aviso-leido":"mark-notice-read","marcar-avisos-leidos":"mark-notices-read","leer-documento":"read-document","abrir-documento-por-codigo":"open-document-by-code","ver-estadisticas":"get-stats","buscar-documentos":"search-documents"}'::jsonb;
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
