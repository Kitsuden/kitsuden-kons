-- English names for kon-conta: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS conta_accounts_conta_agente_alta ON conta_accounts;
DROP POLICY IF EXISTS conta_accounts_conta_agente_borra ON conta_accounts;
DROP POLICY IF EXISTS conta_accounts_conta_agente_cambia ON conta_accounts;
DROP POLICY IF EXISTS conta_accounts_conta_agente_lee ON conta_accounts;
DROP POLICY IF EXISTS conta_accounts_conta_alta ON conta_accounts;
DROP POLICY IF EXISTS conta_accounts_conta_borra ON conta_accounts;
DROP POLICY IF EXISTS conta_accounts_conta_cambia ON conta_accounts;
DROP POLICY IF EXISTS conta_accounts_conta_lee ON conta_accounts;
DROP POLICY IF EXISTS conta_counterparties_conta_agente_alta ON conta_counterparties;
DROP POLICY IF EXISTS conta_counterparties_conta_agente_borra ON conta_counterparties;
DROP POLICY IF EXISTS conta_counterparties_conta_agente_cambia ON conta_counterparties;
DROP POLICY IF EXISTS conta_counterparties_conta_agente_lee ON conta_counterparties;
DROP POLICY IF EXISTS conta_counterparties_conta_alta ON conta_counterparties;
DROP POLICY IF EXISTS conta_counterparties_conta_borra ON conta_counterparties;
DROP POLICY IF EXISTS conta_counterparties_conta_cambia ON conta_counterparties;
DROP POLICY IF EXISTS conta_counterparties_conta_lee ON conta_counterparties;
DROP POLICY IF EXISTS conta_currencies_conta_agente_alta ON conta_currencies;
DROP POLICY IF EXISTS conta_currencies_conta_agente_borra ON conta_currencies;
DROP POLICY IF EXISTS conta_currencies_conta_agente_cambia ON conta_currencies;
DROP POLICY IF EXISTS conta_currencies_conta_agente_lee ON conta_currencies;
DROP POLICY IF EXISTS conta_currencies_conta_alta ON conta_currencies;
DROP POLICY IF EXISTS conta_currencies_conta_borra ON conta_currencies;
DROP POLICY IF EXISTS conta_currencies_conta_cambia ON conta_currencies;
DROP POLICY IF EXISTS conta_currencies_conta_lee ON conta_currencies;
DROP POLICY IF EXISTS conta_disbursements_conta_agente_alta ON conta_disbursements;
DROP POLICY IF EXISTS conta_disbursements_conta_agente_borra ON conta_disbursements;
DROP POLICY IF EXISTS conta_disbursements_conta_agente_cambia ON conta_disbursements;
DROP POLICY IF EXISTS conta_disbursements_conta_agente_lee ON conta_disbursements;
DROP POLICY IF EXISTS conta_disbursements_conta_alta ON conta_disbursements;
DROP POLICY IF EXISTS conta_disbursements_conta_borra ON conta_disbursements;
DROP POLICY IF EXISTS conta_disbursements_conta_cambia ON conta_disbursements;
DROP POLICY IF EXISTS conta_disbursements_conta_lee ON conta_disbursements;
DROP POLICY IF EXISTS conta_journal_templates_conta_agente_alta ON conta_journal_templates;
DROP POLICY IF EXISTS conta_journal_templates_conta_agente_borra ON conta_journal_templates;
DROP POLICY IF EXISTS conta_journal_templates_conta_agente_cambia ON conta_journal_templates;
DROP POLICY IF EXISTS conta_journal_templates_conta_agente_lee ON conta_journal_templates;
DROP POLICY IF EXISTS conta_journal_templates_conta_alta ON conta_journal_templates;
DROP POLICY IF EXISTS conta_journal_templates_conta_borra ON conta_journal_templates;
DROP POLICY IF EXISTS conta_journal_templates_conta_cambia ON conta_journal_templates;
DROP POLICY IF EXISTS conta_journal_templates_conta_lee ON conta_journal_templates;
DROP POLICY IF EXISTS conta_journals_conta_agente_alta ON conta_journals;
DROP POLICY IF EXISTS conta_journals_conta_agente_borra ON conta_journals;
DROP POLICY IF EXISTS conta_journals_conta_agente_cambia ON conta_journals;
DROP POLICY IF EXISTS conta_journals_conta_agente_lee ON conta_journals;
DROP POLICY IF EXISTS conta_journals_conta_alta ON conta_journals;
DROP POLICY IF EXISTS conta_journals_conta_borra ON conta_journals;
DROP POLICY IF EXISTS conta_journals_conta_cambia ON conta_journals;
DROP POLICY IF EXISTS conta_journals_conta_lee ON conta_journals;
DROP POLICY IF EXISTS conta_ledger_entries_conta_agente_alta ON conta_ledger_entries;
DROP POLICY IF EXISTS conta_ledger_entries_conta_agente_borra ON conta_ledger_entries;
DROP POLICY IF EXISTS conta_ledger_entries_conta_agente_cambia ON conta_ledger_entries;
DROP POLICY IF EXISTS conta_ledger_entries_conta_agente_lee ON conta_ledger_entries;
DROP POLICY IF EXISTS conta_ledger_entries_conta_alta ON conta_ledger_entries;
DROP POLICY IF EXISTS conta_ledger_entries_conta_borra ON conta_ledger_entries;
DROP POLICY IF EXISTS conta_ledger_entries_conta_cambia ON conta_ledger_entries;
DROP POLICY IF EXISTS conta_ledger_entries_conta_lee ON conta_ledger_entries;
DROP POLICY IF EXISTS conta_matters_conta_agente_alta ON conta_matters;
DROP POLICY IF EXISTS conta_matters_conta_agente_borra ON conta_matters;
DROP POLICY IF EXISTS conta_matters_conta_agente_cambia ON conta_matters;
DROP POLICY IF EXISTS conta_matters_conta_agente_lee ON conta_matters;
DROP POLICY IF EXISTS conta_matters_conta_alta ON conta_matters;
DROP POLICY IF EXISTS conta_matters_conta_borra ON conta_matters;
DROP POLICY IF EXISTS conta_matters_conta_cambia ON conta_matters;
DROP POLICY IF EXISTS conta_matters_conta_lee ON conta_matters;
DROP POLICY IF EXISTS conta_permisos_agente ON conta_permisos;
DROP POLICY IF EXISTS conta_permisos_agente ON conta_permissions;
DROP POLICY IF EXISTS conta_permisos_gestiona ON conta_permisos;
DROP POLICY IF EXISTS conta_permisos_gestiona ON conta_permissions;
DROP POLICY IF EXISTS conta_permisos_lee ON conta_permisos;
DROP POLICY IF EXISTS conta_permisos_lee ON conta_permissions;

-- Functions whose name or parameters change.
DROP FUNCTION IF EXISTS conta_agente_puede(text);
DROP FUNCTION IF EXISTS conta_rol_actual();

-- Tables.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('conta_permisos', 'conta_permissions')
  ) AS v(old_name, new_name) LOOP
    IF to_regclass('public.' || quote_ident(r.old_name)) IS NOT NULL AND to_regclass('public.' || quote_ident(r.new_name)) IS NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Columns.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('conta_permissions', 'rol', 'role'),
    ('conta_permissions', 'concedido_por', 'granted_by')
  ) AS v(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.new_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Constraints.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('conta_permissions', 'conta_permisos_pkey', 'conta_permissions_pkey'),
    ('conta_permissions', 'conta_permisos_rol_check', 'conta_permissions_role_check')
  ) AS v(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = r.tbl AND c.conname = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = r.tbl AND c.conname = r.new_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Stored role values: the CHECK goes first, the values change, the CHECK comes back.
ALTER TABLE conta_permissions DROP CONSTRAINT IF EXISTS conta_permisos_rol_check;
ALTER TABLE conta_permissions DROP CONSTRAINT IF EXISTS conta_permissions_role_check;
UPDATE conta_permissions SET role = CASE role WHEN 'contable' THEN 'accountant' WHEN 'consulta' THEN 'viewer' ELSE role END WHERE role IN ('contable', 'consulta');
ALTER TABLE conta_permissions ADD CONSTRAINT conta_permissions_role_check CHECK (role IN ('accountant', 'viewer'));

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"conta:ver":"conta:view","conta:escribir":"conta:write","conta:administrar":"conta:administer","kon:conta:ver-info":"kon:conta:get-info","conta:ver-info":"conta:get-info","conta__ver-info":"conta__get-info","kon:conta:listar-permisos":"kon:conta:list-permissions","conta:listar-permisos":"conta:list-permissions","conta__listar-permisos":"conta__list-permissions","kon:conta:conceder-permiso":"kon:conta:grant-permission","conta:conceder-permiso":"conta:grant-permission","conta__conceder-permiso":"conta__grant-permission","kon:conta:retirar-permiso":"kon:conta:revoke-permission","conta:retirar-permiso":"conta:revoke-permission","conta__retirar-permiso":"conta__revoke-permission","kon:conta:ver-mi-rol":"kon:conta:get-my-role","conta:ver-mi-rol":"conta:get-my-role","conta__ver-mi-rol":"conta__get-my-role","kon:conta:listar-monedas":"kon:conta:list-currencies","conta:listar-monedas":"conta:list-currencies","conta__listar-monedas":"conta__list-currencies","kon:conta:crear-moneda":"kon:conta:create-currency","conta:crear-moneda":"conta:create-currency","conta__crear-moneda":"conta__create-currency","kon:conta:listar-cuentas":"kon:conta:list-accounts","conta:listar-cuentas":"conta:list-accounts","conta__listar-cuentas":"conta__list-accounts","kon:conta:ver-cuenta":"kon:conta:get-account","conta:ver-cuenta":"conta:get-account","conta__ver-cuenta":"conta__get-account","kon:conta:crear-cuenta":"kon:conta:create-account","conta:crear-cuenta":"conta:create-account","conta__crear-cuenta":"conta__create-account","kon:conta:editar-cuenta":"kon:conta:update-account","conta:editar-cuenta":"conta:update-account","conta__editar-cuenta":"conta__update-account","kon:conta:desactivar-cuenta":"kon:conta:deactivate-account","conta:desactivar-cuenta":"conta:deactivate-account","conta__desactivar-cuenta":"conta__deactivate-account","kon:conta:listar-terceros":"kon:conta:list-counterparties","conta:listar-terceros":"conta:list-counterparties","conta__listar-terceros":"conta__list-counterparties","kon:conta:ver-tercero":"kon:conta:get-counterparty","conta:ver-tercero":"conta:get-counterparty","conta__ver-tercero":"conta__get-counterparty","kon:conta:crear-tercero":"kon:conta:create-counterparty","conta:crear-tercero":"conta:create-counterparty","conta__crear-tercero":"conta__create-counterparty","kon:conta:editar-tercero":"kon:conta:update-counterparty","conta:editar-tercero":"conta:update-counterparty","conta__editar-tercero":"conta__update-counterparty","kon:conta:borrar-tercero":"kon:conta:delete-counterparty","conta:borrar-tercero":"conta:delete-counterparty","conta__borrar-tercero":"conta__delete-counterparty","kon:conta:listar-expedientes":"kon:conta:list-matters","conta:listar-expedientes":"conta:list-matters","conta__listar-expedientes":"conta__list-matters","kon:conta:ver-expediente":"kon:conta:get-matter","conta:ver-expediente":"conta:get-matter","conta__ver-expediente":"conta__get-matter","kon:conta:crear-expediente":"kon:conta:create-matter","conta:crear-expediente":"conta:create-matter","conta__crear-expediente":"conta__create-matter","kon:conta:editar-expediente":"kon:conta:update-matter","conta:editar-expediente":"conta:update-matter","conta__editar-expediente":"conta__update-matter","kon:conta:borrar-expediente":"kon:conta:delete-matter","conta:borrar-expediente":"conta:delete-matter","conta__borrar-expediente":"conta__delete-matter","kon:conta:listar-plantillas":"kon:conta:list-templates","conta:listar-plantillas":"conta:list-templates","conta__listar-plantillas":"conta__list-templates","kon:conta:ver-plantilla":"kon:conta:get-template","conta:ver-plantilla":"conta:get-template","conta__ver-plantilla":"conta__get-template","kon:conta:crear-plantilla":"kon:conta:create-template","conta:crear-plantilla":"conta:create-template","conta__crear-plantilla":"conta__create-template","kon:conta:editar-plantilla":"kon:conta:update-template","conta:editar-plantilla":"conta:update-template","conta__editar-plantilla":"conta__update-template","kon:conta:desactivar-plantilla":"kon:conta:deactivate-template","conta:desactivar-plantilla":"conta:deactivate-template","conta__desactivar-plantilla":"conta__deactivate-template","kon:conta:aplicar-plantilla":"kon:conta:apply-template","conta:aplicar-plantilla":"conta:apply-template","conta__aplicar-plantilla":"conta__apply-template","kon:conta:listar-asientos":"kon:conta:list-journals","conta:listar-asientos":"conta:list-journals","conta__listar-asientos":"conta__list-journals","kon:conta:ver-asiento":"kon:conta:get-journal","conta:ver-asiento":"conta:get-journal","conta__ver-asiento":"conta__get-journal","kon:conta:validar-asiento":"kon:conta:validate-journal","conta:validar-asiento":"conta:validate-journal","conta__validar-asiento":"conta__validate-journal","kon:conta:crear-asiento":"kon:conta:create-journal","conta:crear-asiento":"conta:create-journal","conta__crear-asiento":"conta__create-journal","kon:conta:editar-asiento":"kon:conta:update-journal","conta:editar-asiento":"conta:update-journal","conta__editar-asiento":"conta__update-journal","kon:conta:borrar-asiento":"kon:conta:delete-journal","conta:borrar-asiento":"conta:delete-journal","conta__borrar-asiento":"conta__delete-journal","kon:conta:contabilizar-asiento":"kon:conta:post-journal","conta:contabilizar-asiento":"conta:post-journal","conta__contabilizar-asiento":"conta__post-journal","kon:conta:revertir-asiento":"kon:conta:reverse-journal","conta:revertir-asiento":"conta:reverse-journal","conta__revertir-asiento":"conta__reverse-journal","kon:conta:ver-cuenta-t":"kon:conta:get-t-account","conta:ver-cuenta-t":"conta:get-t-account","conta__ver-cuenta-t":"conta__get-t-account","kon:conta:ver-saldo-fiduciario":"kon:conta:get-trust-balance","conta:ver-saldo-fiduciario":"conta:get-trust-balance","conta__ver-saldo-fiduciario":"conta__get-trust-balance","kon:conta:listar-gastos":"kon:conta:list-disbursements","conta:listar-gastos":"conta:list-disbursements","conta__listar-gastos":"conta__list-disbursements","kon:conta:ver-gasto":"kon:conta:get-disbursement","conta:ver-gasto":"conta:get-disbursement","conta__ver-gasto":"conta__get-disbursement","kon:conta:crear-gasto":"kon:conta:create-disbursement","conta:crear-gasto":"conta:create-disbursement","conta__crear-gasto":"conta__create-disbursement","kon:conta:facturar-gasto":"kon:conta:bill-disbursement","conta:facturar-gasto":"conta:bill-disbursement","conta__facturar-gasto":"conta__bill-disbursement","kon:conta:pagar-gasto":"kon:conta:pay-disbursement","conta:pagar-gasto":"conta:pay-disbursement","conta__pagar-gasto":"conta__pay-disbursement","kon:conta:borrar-gasto":"kon:conta:delete-disbursement","conta:borrar-gasto":"conta:delete-disbursement","conta__borrar-gasto":"conta__delete-disbursement","kon:conta:ver-balance-de-comprobacion":"kon:conta:get-trial-balance","conta:ver-balance-de-comprobacion":"conta:get-trial-balance","conta__ver-balance-de-comprobacion":"conta__get-trial-balance","kon:conta:ver-balance-general":"kon:conta:get-balance-sheet","conta:ver-balance-general":"conta:get-balance-sheet","conta__ver-balance-general":"conta__get-balance-sheet","kon:conta:ver-cuenta-de-resultados":"kon:conta:get-income-statement","conta:ver-cuenta-de-resultados":"conta:get-income-statement","conta__ver-cuenta-de-resultados":"conta__get-income-statement","kon:conta:sembrar-plan-de-cuentas":"kon:conta:seed-chart-of-accounts","conta:sembrar-plan-de-cuentas":"conta:seed-chart-of-accounts","conta__sembrar-plan-de-cuentas":"conta__seed-chart-of-accounts"}'::jsonb;
  ops jsonb := '{"ver-info":"get-info","listar-permisos":"list-permissions","conceder-permiso":"grant-permission","retirar-permiso":"revoke-permission","ver-mi-rol":"get-my-role","listar-monedas":"list-currencies","crear-moneda":"create-currency","listar-cuentas":"list-accounts","ver-cuenta":"get-account","crear-cuenta":"create-account","editar-cuenta":"update-account","desactivar-cuenta":"deactivate-account","listar-terceros":"list-counterparties","ver-tercero":"get-counterparty","crear-tercero":"create-counterparty","editar-tercero":"update-counterparty","borrar-tercero":"delete-counterparty","listar-expedientes":"list-matters","ver-expediente":"get-matter","crear-expediente":"create-matter","editar-expediente":"update-matter","borrar-expediente":"delete-matter","listar-plantillas":"list-templates","ver-plantilla":"get-template","crear-plantilla":"create-template","editar-plantilla":"update-template","desactivar-plantilla":"deactivate-template","aplicar-plantilla":"apply-template","listar-asientos":"list-journals","ver-asiento":"get-journal","validar-asiento":"validate-journal","crear-asiento":"create-journal","editar-asiento":"update-journal","borrar-asiento":"delete-journal","contabilizar-asiento":"post-journal","revertir-asiento":"reverse-journal","ver-cuenta-t":"get-t-account","ver-saldo-fiduciario":"get-trust-balance","listar-gastos":"list-disbursements","ver-gasto":"get-disbursement","crear-gasto":"create-disbursement","facturar-gasto":"bill-disbursement","pagar-gasto":"pay-disbursement","borrar-gasto":"delete-disbursement","ver-balance-de-comprobacion":"get-trial-balance","ver-balance-general":"get-balance-sheet","ver-cuenta-de-resultados":"get-income-statement","sembrar-plan-de-cuentas":"seed-chart-of-accounts"}'::jsonb;
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
