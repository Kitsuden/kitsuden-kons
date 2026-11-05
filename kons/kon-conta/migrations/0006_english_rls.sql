-- RLS for kon-conta after the English rename: functions, triggers and policies come back with the new names.
--
-- The previous file dropped the old ones; between both files the tables stay closed, not open.

-- Functions: their bodies are text, so a rename does not reach them.
CREATE OR REPLACE FUNCTION conta_agent_can(p_action text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT kitsuden_agent_can_in_kon('conta', 'conta:' || p_action)
$function$;

CREATE OR REPLACE FUNCTION conta_current_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT role FROM conta_permissions
    WHERE user_id = current_setting('app.current_user_id', true)
$function$;

-- Policies, with the new names and the core's English helpers.
DROP POLICY IF EXISTS conta_accounts_conta_agent_insert ON conta_accounts;
CREATE POLICY conta_accounts_conta_agent_insert ON conta_accounts AS PERMISSIVE FOR INSERT WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_accounts_conta_agent_delete ON conta_accounts;
CREATE POLICY conta_accounts_conta_agent_delete ON conta_accounts AS PERMISSIVE FOR DELETE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_accounts_conta_agent_update ON conta_accounts;
CREATE POLICY conta_accounts_conta_agent_update ON conta_accounts AS PERMISSIVE FOR UPDATE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text))) WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_accounts_conta_agent_select ON conta_accounts;
CREATE POLICY conta_accounts_conta_agent_select ON conta_accounts AS PERMISSIVE FOR SELECT USING ((conta_agent_can('view'::text) OR conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_accounts_conta_insert ON conta_accounts;
CREATE POLICY conta_accounts_conta_insert ON conta_accounts AS PERMISSIVE FOR INSERT WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_accounts_conta_delete ON conta_accounts;
CREATE POLICY conta_accounts_conta_delete ON conta_accounts AS PERMISSIVE FOR DELETE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_accounts_conta_update ON conta_accounts;
CREATE POLICY conta_accounts_conta_update ON conta_accounts AS PERMISSIVE FOR UPDATE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_accounts_conta_select ON conta_accounts;
CREATE POLICY conta_accounts_conta_select ON conta_accounts AS PERMISSIVE FOR SELECT USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() IS NOT NULL)));
DROP POLICY IF EXISTS conta_counterparties_conta_agent_insert ON conta_counterparties;
CREATE POLICY conta_counterparties_conta_agent_insert ON conta_counterparties AS PERMISSIVE FOR INSERT WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_counterparties_conta_agent_delete ON conta_counterparties;
CREATE POLICY conta_counterparties_conta_agent_delete ON conta_counterparties AS PERMISSIVE FOR DELETE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_counterparties_conta_agent_update ON conta_counterparties;
CREATE POLICY conta_counterparties_conta_agent_update ON conta_counterparties AS PERMISSIVE FOR UPDATE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text))) WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_counterparties_conta_agent_select ON conta_counterparties;
CREATE POLICY conta_counterparties_conta_agent_select ON conta_counterparties AS PERMISSIVE FOR SELECT USING ((conta_agent_can('view'::text) OR conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_counterparties_conta_insert ON conta_counterparties;
CREATE POLICY conta_counterparties_conta_insert ON conta_counterparties AS PERMISSIVE FOR INSERT WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_counterparties_conta_delete ON conta_counterparties;
CREATE POLICY conta_counterparties_conta_delete ON conta_counterparties AS PERMISSIVE FOR DELETE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_counterparties_conta_update ON conta_counterparties;
CREATE POLICY conta_counterparties_conta_update ON conta_counterparties AS PERMISSIVE FOR UPDATE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_counterparties_conta_select ON conta_counterparties;
CREATE POLICY conta_counterparties_conta_select ON conta_counterparties AS PERMISSIVE FOR SELECT USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() IS NOT NULL)));
DROP POLICY IF EXISTS conta_currencies_conta_agent_insert ON conta_currencies;
CREATE POLICY conta_currencies_conta_agent_insert ON conta_currencies AS PERMISSIVE FOR INSERT WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_currencies_conta_agent_delete ON conta_currencies;
CREATE POLICY conta_currencies_conta_agent_delete ON conta_currencies AS PERMISSIVE FOR DELETE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_currencies_conta_agent_update ON conta_currencies;
CREATE POLICY conta_currencies_conta_agent_update ON conta_currencies AS PERMISSIVE FOR UPDATE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text))) WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_currencies_conta_agent_select ON conta_currencies;
CREATE POLICY conta_currencies_conta_agent_select ON conta_currencies AS PERMISSIVE FOR SELECT USING ((conta_agent_can('view'::text) OR conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_currencies_conta_insert ON conta_currencies;
CREATE POLICY conta_currencies_conta_insert ON conta_currencies AS PERMISSIVE FOR INSERT WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_currencies_conta_delete ON conta_currencies;
CREATE POLICY conta_currencies_conta_delete ON conta_currencies AS PERMISSIVE FOR DELETE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_currencies_conta_update ON conta_currencies;
CREATE POLICY conta_currencies_conta_update ON conta_currencies AS PERMISSIVE FOR UPDATE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_currencies_conta_select ON conta_currencies;
CREATE POLICY conta_currencies_conta_select ON conta_currencies AS PERMISSIVE FOR SELECT USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() IS NOT NULL)));
DROP POLICY IF EXISTS conta_disbursements_conta_agent_insert ON conta_disbursements;
CREATE POLICY conta_disbursements_conta_agent_insert ON conta_disbursements AS PERMISSIVE FOR INSERT WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_disbursements_conta_agent_delete ON conta_disbursements;
CREATE POLICY conta_disbursements_conta_agent_delete ON conta_disbursements AS PERMISSIVE FOR DELETE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_disbursements_conta_agent_update ON conta_disbursements;
CREATE POLICY conta_disbursements_conta_agent_update ON conta_disbursements AS PERMISSIVE FOR UPDATE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text))) WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_disbursements_conta_agent_select ON conta_disbursements;
CREATE POLICY conta_disbursements_conta_agent_select ON conta_disbursements AS PERMISSIVE FOR SELECT USING ((conta_agent_can('view'::text) OR conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_disbursements_conta_insert ON conta_disbursements;
CREATE POLICY conta_disbursements_conta_insert ON conta_disbursements AS PERMISSIVE FOR INSERT WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_disbursements_conta_delete ON conta_disbursements;
CREATE POLICY conta_disbursements_conta_delete ON conta_disbursements AS PERMISSIVE FOR DELETE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_disbursements_conta_update ON conta_disbursements;
CREATE POLICY conta_disbursements_conta_update ON conta_disbursements AS PERMISSIVE FOR UPDATE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_disbursements_conta_select ON conta_disbursements;
CREATE POLICY conta_disbursements_conta_select ON conta_disbursements AS PERMISSIVE FOR SELECT USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() IS NOT NULL)));
DROP POLICY IF EXISTS conta_journal_templates_conta_agent_insert ON conta_journal_templates;
CREATE POLICY conta_journal_templates_conta_agent_insert ON conta_journal_templates AS PERMISSIVE FOR INSERT WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_journal_templates_conta_agent_delete ON conta_journal_templates;
CREATE POLICY conta_journal_templates_conta_agent_delete ON conta_journal_templates AS PERMISSIVE FOR DELETE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_journal_templates_conta_agent_update ON conta_journal_templates;
CREATE POLICY conta_journal_templates_conta_agent_update ON conta_journal_templates AS PERMISSIVE FOR UPDATE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text))) WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_journal_templates_conta_agent_select ON conta_journal_templates;
CREATE POLICY conta_journal_templates_conta_agent_select ON conta_journal_templates AS PERMISSIVE FOR SELECT USING ((conta_agent_can('view'::text) OR conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_journal_templates_conta_insert ON conta_journal_templates;
CREATE POLICY conta_journal_templates_conta_insert ON conta_journal_templates AS PERMISSIVE FOR INSERT WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_journal_templates_conta_delete ON conta_journal_templates;
CREATE POLICY conta_journal_templates_conta_delete ON conta_journal_templates AS PERMISSIVE FOR DELETE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_journal_templates_conta_update ON conta_journal_templates;
CREATE POLICY conta_journal_templates_conta_update ON conta_journal_templates AS PERMISSIVE FOR UPDATE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_journal_templates_conta_select ON conta_journal_templates;
CREATE POLICY conta_journal_templates_conta_select ON conta_journal_templates AS PERMISSIVE FOR SELECT USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() IS NOT NULL)));
DROP POLICY IF EXISTS conta_journals_conta_agent_insert ON conta_journals;
CREATE POLICY conta_journals_conta_agent_insert ON conta_journals AS PERMISSIVE FOR INSERT WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_journals_conta_agent_delete ON conta_journals;
CREATE POLICY conta_journals_conta_agent_delete ON conta_journals AS PERMISSIVE FOR DELETE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_journals_conta_agent_update ON conta_journals;
CREATE POLICY conta_journals_conta_agent_update ON conta_journals AS PERMISSIVE FOR UPDATE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text))) WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_journals_conta_agent_select ON conta_journals;
CREATE POLICY conta_journals_conta_agent_select ON conta_journals AS PERMISSIVE FOR SELECT USING ((conta_agent_can('view'::text) OR conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_journals_conta_insert ON conta_journals;
CREATE POLICY conta_journals_conta_insert ON conta_journals AS PERMISSIVE FOR INSERT WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_journals_conta_delete ON conta_journals;
CREATE POLICY conta_journals_conta_delete ON conta_journals AS PERMISSIVE FOR DELETE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_journals_conta_update ON conta_journals;
CREATE POLICY conta_journals_conta_update ON conta_journals AS PERMISSIVE FOR UPDATE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_journals_conta_select ON conta_journals;
CREATE POLICY conta_journals_conta_select ON conta_journals AS PERMISSIVE FOR SELECT USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() IS NOT NULL)));
DROP POLICY IF EXISTS conta_ledger_entries_conta_agent_insert ON conta_ledger_entries;
CREATE POLICY conta_ledger_entries_conta_agent_insert ON conta_ledger_entries AS PERMISSIVE FOR INSERT WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_ledger_entries_conta_agent_delete ON conta_ledger_entries;
CREATE POLICY conta_ledger_entries_conta_agent_delete ON conta_ledger_entries AS PERMISSIVE FOR DELETE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_ledger_entries_conta_agent_update ON conta_ledger_entries;
CREATE POLICY conta_ledger_entries_conta_agent_update ON conta_ledger_entries AS PERMISSIVE FOR UPDATE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text))) WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_ledger_entries_conta_agent_select ON conta_ledger_entries;
CREATE POLICY conta_ledger_entries_conta_agent_select ON conta_ledger_entries AS PERMISSIVE FOR SELECT USING ((conta_agent_can('view'::text) OR conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_ledger_entries_conta_insert ON conta_ledger_entries;
CREATE POLICY conta_ledger_entries_conta_insert ON conta_ledger_entries AS PERMISSIVE FOR INSERT WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_ledger_entries_conta_delete ON conta_ledger_entries;
CREATE POLICY conta_ledger_entries_conta_delete ON conta_ledger_entries AS PERMISSIVE FOR DELETE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_ledger_entries_conta_update ON conta_ledger_entries;
CREATE POLICY conta_ledger_entries_conta_update ON conta_ledger_entries AS PERMISSIVE FOR UPDATE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_ledger_entries_conta_select ON conta_ledger_entries;
CREATE POLICY conta_ledger_entries_conta_select ON conta_ledger_entries AS PERMISSIVE FOR SELECT USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() IS NOT NULL)));
DROP POLICY IF EXISTS conta_matters_conta_agent_insert ON conta_matters;
CREATE POLICY conta_matters_conta_agent_insert ON conta_matters AS PERMISSIVE FOR INSERT WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_matters_conta_agent_delete ON conta_matters;
CREATE POLICY conta_matters_conta_agent_delete ON conta_matters AS PERMISSIVE FOR DELETE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_matters_conta_agent_update ON conta_matters;
CREATE POLICY conta_matters_conta_agent_update ON conta_matters AS PERMISSIVE FOR UPDATE USING ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text))) WITH CHECK ((conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_matters_conta_agent_select ON conta_matters;
CREATE POLICY conta_matters_conta_agent_select ON conta_matters AS PERMISSIVE FOR SELECT USING ((conta_agent_can('view'::text) OR conta_agent_can('write'::text) OR conta_agent_can('administer'::text)));
DROP POLICY IF EXISTS conta_matters_conta_insert ON conta_matters;
CREATE POLICY conta_matters_conta_insert ON conta_matters AS PERMISSIVE FOR INSERT WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_matters_conta_delete ON conta_matters;
CREATE POLICY conta_matters_conta_delete ON conta_matters AS PERMISSIVE FOR DELETE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_matters_conta_update ON conta_matters;
CREATE POLICY conta_matters_conta_update ON conta_matters AS PERMISSIVE FOR UPDATE USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() = 'accountant'::text)));
DROP POLICY IF EXISTS conta_matters_conta_select ON conta_matters;
CREATE POLICY conta_matters_conta_select ON conta_matters AS PERMISSIVE FOR SELECT USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (conta_current_role() IS NOT NULL)));
DROP POLICY IF EXISTS conta_permissions_agent ON conta_permissions;
CREATE POLICY conta_permissions_agent ON conta_permissions AS PERMISSIVE FOR ALL USING (conta_agent_can('administer'::text)) WITH CHECK (conta_agent_can('administer'::text));
DROP POLICY IF EXISTS conta_permissions_manage ON conta_permissions;
CREATE POLICY conta_permissions_manage ON conta_permissions AS PERMISSIVE FOR ALL USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text))) WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text)));
DROP POLICY IF EXISTS conta_permissions_select ON conta_permissions;
CREATE POLICY conta_permissions_select ON conta_permissions AS PERMISSIVE FOR SELECT USING ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (user_id = current_setting('app.current_user_id'::text, true))));
