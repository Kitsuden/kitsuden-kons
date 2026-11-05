-- ============================================================================
-- kon-dms — user ids as text + RLS on documents
-- ============================================================================
--
-- 1. USER IDS ARE NOT UUIDS.
--    `auth_users.id` is `text` (better-auth generates 32-character strings),
--    but the DMS schema stored owner, author, reviewer, reader… in
--    `uuid` columns. With a real account, creating a document failed with
--    "invalid input syntax for type uuid": the kon had only ever worked with
--    test ids. They are changed to `text`.
--
--    The `rls-owned-tables.sql` policies on acks and notifications use
--    `user_id`, and Postgres does not allow changing the type of a column that appears
--    in a policy: they are dropped first and restored IDENTICAL afterwards (the
--    RLS applier rewrites them on every startup anyway).
--
-- 2. RLS ON THE DOCUMENT TABLES.
--    Until now there was none: any account with a session (public sign-up) read
--    private documents, drafts, files, comments and the audit
--    log. The read rule for a document is the same one the kon's
--    "dms_document" policy applies (dms.access.ts):
--      admin · owner · author · reviewer · approver · authorized user
--      or, if it is not `private`: authorized group (role) · folder whose
--      authorized role they have · published `public` · published `internal` for the
--      team (admin/editor).
--    UNPUBLISHED versions are only seen by owner, author, reviewers and
--    approvers. Files and diagrams follow their version; comments, their
--    document (and their version if they have one).
--
-- Kitsuden convention: with an empty context (migrations, seeds) they fail
-- OPEN; the kon sets the context on every request (contexto-rls.ts).
-- Idempotent.
-- ============================================================================

-- ── 1. uuid → text ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS dms_document_acknowledgments_owner_isolation ON dms_document_acknowledgments;
DROP POLICY IF EXISTS dms_workflow_notifications_owner_isolation ON dms_workflow_notifications;

DO $$
DECLARE
    c record;
BEGIN
    FOR c IN
        SELECT * FROM (VALUES
            ('dms_categories',               'created_by_id'),
            ('dms_documents',                'owner_id'),
            ('dms_documents',                'created_by_id'),
            ('dms_document_versions',        'created_by_id'),
            ('dms_document_versions',        'reviewed_by_id'),
            ('dms_document_versions',        'approved_by_id'),
            ('dms_document_versions',        'published_by_id'),
            ('dms_document_files',           'created_by_id'),
            ('dms_document_acknowledgments', 'user_id'),
            ('dms_access_log',               'user_id'),
            ('dms_workflow_notifications',   'user_id'),
            ('dms_document_comments',        'user_id')
        ) AS v(tabla, columna)
    LOOP
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = c.tabla
                     AND column_name = c.columna AND data_type = 'uuid') THEN
            EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE text USING %I::text',
                c.tabla, c.columna, c.columna);
        END IF;
    END LOOP;
END $$;

-- Restored identical to rls-owned-tables.sql (each person's trail stays isolated).
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['dms_document_acknowledgments', 'dms_workflow_notifications'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_owner_isolation', t);
        EXECUTE format($POLICY$
            CREATE POLICY %I ON %I FOR ALL TO PUBLIC
            USING (
                current_setting('app.current_user_id', true) = ''
                OR current_setting('app.current_user_id', true) IS NULL
                OR current_setting('app.current_user_role', true) = 'admin'
                OR user_id::text = current_setting('app.current_user_id', true)
            )
            WITH CHECK (
                current_setting('app.current_user_id', true) = ''
                OR current_setting('app.current_user_id', true) IS NULL
                OR current_setting('app.current_user_role', true) = 'admin'
                OR user_id::text = current_setting('app.current_user_id', true)
            )
        $POLICY$, t || '_owner_isolation', t);
    END LOOP;
END $$;

-- ── 2. Context functions ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION dms_uid() RETURNS text
    LANGUAGE sql STABLE
AS $$ SELECT current_setting('app.current_user_id', true) $$;

CREATE OR REPLACE FUNCTION dms_rol() RETURNS text
    LANGUAGE sql STABLE
AS $$ SELECT coalesce(current_setting('app.current_user_role', true), '') $$;

-- Empty context (system: migrations, seeds) or admin.
CREATE OR REPLACE FUNCTION dms_sistema() RETURNS boolean
    LANGUAGE sql STABLE
AS $$
    SELECT current_setting('app.current_user_id', true) IS NULL
        OR current_setting('app.current_user_id', true) = ''
        OR current_setting('app.current_user_role', true) = 'admin'
$$;

-- ── 3. Policies ────────────────────────────────────────────────────────────

DO $$
DECLARE
    -- On the dms_documents row (unqualified columns).
    participa text := 'owner_id = dms_uid() OR created_by_id = dms_uid() '
        || 'OR reviewer_ids @> jsonb_build_array(dms_uid()) '
        || 'OR approver_ids @> jsonb_build_array(dms_uid())';
    edita text := 'owner_id = dms_uid() OR created_by_id = dms_uid()';
    lee text;
    t text;
BEGIN
    lee := participa
        || ' OR allowed_user_ids @> jsonb_build_array(dms_uid())'
        || ' OR (visibility <> ''private'' AND ('
        || '      allowed_role_ids @> jsonb_build_array(dms_rol())'
        || '   OR (category_id IS NOT NULL AND EXISTS (SELECT 1 FROM dms_categories c'
        || '         WHERE c.id = category_id AND c.allowed_roles @> jsonb_build_array(dms_rol())))'
        || '   OR (status = ''published'' AND visibility = ''public'')'
        || '   OR (status = ''published'' AND visibility = ''internal'' AND dms_rol() IN (''admin'', ''editor''))'
        || ' ))';

    FOREACH t IN ARRAY ARRAY[
        'dms_documents', 'dms_document_versions', 'dms_document_files',
        'dms_document_comments', 'dms_document_diagrams', 'dms_document_relations',
        'dms_access_log', 'dms_document_slug_history'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_dms_lee', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_dms_alta', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_dms_cambia', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_dms_borra', t);
    END LOOP;

    -- Documents
    EXECUTE format('CREATE POLICY dms_documents_dms_lee ON dms_documents FOR SELECT USING (dms_sistema() OR %s)', lee);
    EXECUTE format('CREATE POLICY dms_documents_dms_alta ON dms_documents FOR INSERT WITH CHECK (dms_sistema() OR %s)', edita);
    -- Update: whoever edits it or publishes it (approver). The view/download
    -- counters are incremented by the kon as the system.
    EXECUTE format('CREATE POLICY dms_documents_dms_cambia ON dms_documents FOR UPDATE USING (dms_sistema() OR %s OR approver_ids @> jsonb_build_array(dms_uid())) WITH CHECK (dms_sistema() OR %s OR approver_ids @> jsonb_build_array(dms_uid()))', edita, edita);
    EXECUTE 'CREATE POLICY dms_documents_dms_borra ON dms_documents FOR DELETE USING (dms_sistema())';

    -- Versions: published → whoever sees the document; the rest → whoever takes part.
    EXECUTE format($P$CREATE POLICY dms_document_versions_dms_lee ON dms_document_versions FOR SELECT USING (
        dms_sistema()
        OR (dms_document_versions.status = 'published'
            AND EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_versions.document_id))
        OR EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_versions.document_id
                   AND (d.%s))
    )$P$, replace(participa, ' OR ', ' OR d.'));
    EXECUTE format($P$CREATE POLICY dms_document_versions_dms_alta ON dms_document_versions FOR INSERT WITH CHECK (
        dms_sistema() OR EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_versions.document_id AND (d.%s))
    )$P$, replace(edita, ' OR ', ' OR d.'));
    EXECUTE format($P$CREATE POLICY dms_document_versions_dms_cambia ON dms_document_versions FOR UPDATE
        USING (dms_sistema() OR EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_versions.document_id AND (d.%s)))
        WITH CHECK (dms_sistema() OR EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_versions.document_id AND (d.%s)))
    $P$, replace(participa, ' OR ', ' OR d.'), replace(participa, ' OR ', ' OR d.'));
    EXECUTE 'CREATE POLICY dms_document_versions_dms_borra ON dms_document_versions FOR DELETE USING (dms_sistema())';

    -- Files and diagrams: seen by whoever sees their version; changed by whoever edits the document.
    EXECUTE $P$CREATE POLICY dms_document_files_dms_lee ON dms_document_files FOR SELECT USING (
        dms_sistema() OR EXISTS (SELECT 1 FROM dms_document_versions v WHERE v.id = dms_document_files.version_id)
    )$P$;
    EXECUTE format($P$CREATE POLICY dms_document_files_dms_alta ON dms_document_files FOR INSERT WITH CHECK (
        dms_sistema() OR EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_files.document_id AND (d.%s))
    )$P$, replace(edita, ' OR ', ' OR d.'));
    EXECUTE format($P$CREATE POLICY dms_document_files_dms_cambia ON dms_document_files FOR UPDATE
        USING (dms_sistema() OR EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_files.document_id AND (d.%s)))
    $P$, replace(edita, ' OR ', ' OR d.'));
    EXECUTE format($P$CREATE POLICY dms_document_files_dms_borra ON dms_document_files FOR DELETE
        USING (dms_sistema() OR EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_files.document_id AND (d.%s)))
    $P$, replace(edita, ' OR ', ' OR d.'));

    EXECUTE $P$CREATE POLICY dms_document_diagrams_dms_lee ON dms_document_diagrams FOR SELECT USING (
        dms_sistema() OR EXISTS (SELECT 1 FROM dms_document_versions v WHERE v.id = dms_document_diagrams.version_id)
    )$P$;
    EXECUTE format($P$CREATE POLICY dms_document_diagrams_dms_alta ON dms_document_diagrams FOR INSERT WITH CHECK (
        dms_sistema() OR EXISTS (SELECT 1 FROM dms_document_versions v JOIN dms_documents d ON d.id = v.document_id
                                 WHERE v.id = dms_document_diagrams.version_id AND (d.%s))
    )$P$, replace(edita, ' OR ', ' OR d.'));
    EXECUTE format($P$CREATE POLICY dms_document_diagrams_dms_cambia ON dms_document_diagrams FOR UPDATE
        USING (dms_sistema() OR EXISTS (SELECT 1 FROM dms_document_versions v JOIN dms_documents d ON d.id = v.document_id
                                        WHERE v.id = dms_document_diagrams.version_id AND (d.%s)))
    $P$, replace(edita, ' OR ', ' OR d.'));
    EXECUTE format($P$CREATE POLICY dms_document_diagrams_dms_borra ON dms_document_diagrams FOR DELETE
        USING (dms_sistema() OR EXISTS (SELECT 1 FROM dms_document_versions v JOIN dms_documents d ON d.id = v.document_id
                                        WHERE v.id = dms_document_diagrams.version_id AND (d.%s)))
    $P$, replace(edita, ' OR ', ' OR d.'));

    -- Comments: visible document (and visible version, if they have one).
    EXECUTE $P$CREATE POLICY dms_document_comments_dms_lee ON dms_document_comments FOR SELECT USING (
        dms_sistema() OR (
            EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_comments.document_id)
            AND (dms_document_comments.version_id IS NULL
                 OR EXISTS (SELECT 1 FROM dms_document_versions v WHERE v.id = dms_document_comments.version_id))
        )
    )$P$;
    EXECUTE $P$CREATE POLICY dms_document_comments_dms_alta ON dms_document_comments FOR INSERT WITH CHECK (
        dms_sistema() OR (
            dms_document_comments.user_id = dms_uid()
            AND EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_comments.document_id)
        )
    )$P$;
    EXECUTE format($P$CREATE POLICY dms_document_comments_dms_cambia ON dms_document_comments FOR UPDATE USING (
        dms_sistema() OR dms_document_comments.user_id = dms_uid()
        OR EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_comments.document_id AND (d.%s))
    )$P$, replace(edita, ' OR ', ' OR d.'));
    EXECUTE format($P$CREATE POLICY dms_document_comments_dms_borra ON dms_document_comments FOR DELETE USING (
        dms_sistema() OR dms_document_comments.user_id = dms_uid()
        OR EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_comments.document_id AND (d.%s))
    )$P$, replace(edita, ' OR ', ' OR d.'));

    -- Relations: visible if BOTH documents are visible; created by whoever edits the source.
    EXECUTE $P$CREATE POLICY dms_document_relations_dms_lee ON dms_document_relations FOR SELECT USING (
        dms_sistema() OR (
            EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_relations.source_document_id)
            AND EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_relations.target_document_id)
        )
    )$P$;
    EXECUTE format($P$CREATE POLICY dms_document_relations_dms_alta ON dms_document_relations FOR INSERT WITH CHECK (
        dms_sistema() OR (
            EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_relations.source_document_id AND (d.%s))
            AND EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_relations.target_document_id)
        )
    )$P$, replace(edita, ' OR ', ' OR d.'));
    EXECUTE format($P$CREATE POLICY dms_document_relations_dms_borra ON dms_document_relations FOR DELETE USING (
        dms_sistema() OR EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_relations.source_document_id AND (d.%s))
    )$P$, replace(edita, ' OR ', ' OR d.'));

    -- Audit: everyone sees their own trail; reading another's document audit is admin only
    -- (the kon shows it to the document's owner after authorizing them).
    EXECUTE $P$CREATE POLICY dms_access_log_dms_lee ON dms_access_log FOR SELECT USING (
        dms_sistema() OR dms_access_log.user_id = dms_uid()
    )$P$;
    EXECUTE $P$CREATE POLICY dms_access_log_dms_alta ON dms_access_log FOR INSERT WITH CHECK (
        dms_sistema() OR dms_access_log.user_id = dms_uid()
    )$P$;

    -- Slug history: resolved by whoever sees the document; written by whoever edits it.
    EXECUTE $P$CREATE POLICY dms_document_slug_history_dms_lee ON dms_document_slug_history FOR SELECT USING (
        dms_sistema() OR EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_slug_history.document_id)
    )$P$;
    EXECUTE format($P$CREATE POLICY dms_document_slug_history_dms_alta ON dms_document_slug_history FOR INSERT WITH CHECK (
        dms_sistema() OR EXISTS (SELECT 1 FROM dms_documents d WHERE d.id = dms_document_slug_history.document_id AND (d.%s))
    )$P$, replace(edita, ' OR ', ' OR d.'));
END $$;
