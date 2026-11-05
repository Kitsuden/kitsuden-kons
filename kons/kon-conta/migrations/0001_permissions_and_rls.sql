-- ============================================================================
-- kon-conta — accounting role and RLS for the general ledger
-- ============================================================================
--
-- Until now the whole accounting (accounts, journal entries, counterparties
-- with their tax ID, matters, trust accounts) could be read and written by ANY
-- account with a session, and sign-up is public. The only barrier was an
-- "admin only" prefix in auth-guard.ts, outside the kon.
--
-- Two pieces:
--   1. `conta_permisos`: the "accounting role" (contable = reads and writes;
--      consulta = read only). An admin manages it.
--   2. Forced RLS on every table of the kon: reading requires admin or a row in
--      `conta_permisos`; writing requires admin or the `contable` role.
--
-- Same convention as the rest of Kitsuden's policies: with an empty context
-- (migrations, seeds, startup) they fail OPEN. The kon sets the context on
-- every request with a user (contexto-rls.ts), so over HTTP they do filter.
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS conta_permisos (
    user_id text PRIMARY KEY,
    rol text NOT NULL CHECK (rol IN ('contable', 'consulta')),
    concedido_por text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- SECURITY DEFINER: the query runs as the function's owner, so the RLS of
-- `conta_permisos` does not filter it (avoiding recursion), and it only returns
-- the role of WHOEVER ASKS, never someone else's.
CREATE OR REPLACE FUNCTION conta_rol_actual() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public
AS $$
    SELECT rol FROM conta_permisos
    WHERE user_id = current_setting('app.current_user_id', true)
$$;

DO $$
DECLARE
    t text;
    sistema text := '(current_setting(''app.current_user_id'', true) IS NULL '
        || 'OR current_setting(''app.current_user_id'', true) = '''' '
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
