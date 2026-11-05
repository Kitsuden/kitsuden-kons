-- 0002 — Conta: "system" means empty id AND role (2026-10-23)
-- ============================================================================
-- Idempotent: recreates ALL the policies of 0001_permissions_and_rls with the
-- strict condition. The body is the same block as 0001_permissions_and_rls; only
-- `sistema` changes.
--
-- 0001_permissions_and_rls treated any context with an empty `app.current_user_id`
-- as the system. While the kon opened its own RLS transaction only for requests
-- WITH a user, it made no difference: anonymous users never reached the
-- database. Since 2026-10-23 the HOST opens the RLS transaction for every request
-- to a kon, and an anonymous user carries id '' and role `anonymous`: with
-- 0001_permissions_and_rls they would go through these policies as if they were
-- the system. It is the same loophole the core closed in rls-owned-tables.sql.

DO $$
DECLARE
    t text;
    -- System = empty id AND role (a request's anonymous user carries role
    -- `anonymous` and no longer gets through here), or admin.
    sistema text := '((COALESCE(current_setting(''app.current_user_id'', true), '''') = '''' '
        || 'AND COALESCE(current_setting(''app.current_user_role'', true), '''') = '''') '
        || 'OR current_setting(''app.current_user_role'', true) = ''admin'')';
    lee text;
    escribe text;
BEGIN
    lee := sistema || ' OR conta_rol_actual() IS NOT NULL';
    escribe := sistema || ' OR conta_rol_actual() = ''contable''';

    FOREACH t IN ARRAY ARRAY[
        'conta_currencies', 'conta_accounts', 'conta_counterparties', 'conta_matters',
        'conta_journal_templates', 'conta_journals', 'conta_ledger_entries',
        'conta_disbursements'
    ] LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = t) THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
            EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_lee', t);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_alta', t);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_cambia', t);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_borra', t);

            EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)',
                t || '_conta_lee', t, lee);
            EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)',
                t || '_conta_alta', t, escribe);
            EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',
                t || '_conta_cambia', t, escribe, escribe);
            EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)',
                t || '_conta_borra', t, escribe);
        END IF;
    END LOOP;

    -- Permissions: each user sees their own; only admin/system manages them.
    EXECUTE 'ALTER TABLE conta_permisos ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE conta_permisos FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS conta_permisos_lee ON conta_permisos';
    EXECUTE 'DROP POLICY IF EXISTS conta_permisos_gestiona ON conta_permisos';
    EXECUTE format('CREATE POLICY conta_permisos_lee ON conta_permisos FOR SELECT USING (%s OR user_id = current_setting(''app.current_user_id'', true))', sistema);
    EXECUTE format('CREATE POLICY conta_permisos_gestiona ON conta_permisos FOR ALL USING (%s) WITH CHECK (%s)', sistema, sistema);
END $$;
