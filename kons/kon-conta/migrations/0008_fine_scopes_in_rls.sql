-- 0008 — The fine scope of an operation reaches the rows it needs
-- ============================================================================
-- Idempotent (CREATE OR REPLACE).
--
-- Every agent policy of the kon asks `conta_agent_can('view' | 'write' | 'administer')`, which
-- knew only the policy scopes (`conta:view`, `conta:write`, `conta:administer`) and the whole kon
-- (`conta:*`, `kon:conta:*`, `admin`). The route now also accepts an operation's fine scope
-- (`kon:conta:list-accounts`, conta.routes.ts `grantedByFineScope`), and row security must agree,
-- or the agent passes the route and then finds no rows. So `conta_agent_can(action)` is also true
-- for an agent holding the fine scope of an operation whose declared action is `action`, unless a
-- denial covers it: of the scope, of the whole kon, or of `conta:<action>`.
--
-- Row security stays per action, as it was: the fine scope of a read operation reads the ledger,
-- the fine scope of a write operation writes it (the route still allows only that operation).
--
-- `conta_operation_action` is the declared action of every operation (the last of its
-- `conta([...])` list). tests/unit/kon-conta-agents.test.ts compares it with the code.

CREATE OR REPLACE FUNCTION conta_operation_action(p_operation text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_operation IN (
        'apply-template',
        'get-account',
        'get-aging',
        'get-aging-by-client',
        'get-attention',
        'get-balance-sheet',
        'get-bank-summary',
        'get-billing-by-category',
        'get-billing-by-client',
        'get-client-funds-balance',
        'get-client-funds-reconciliation',
        'get-counterparty',
        'get-disbursement',
        'get-dso',
        'get-income-statement',
        'get-invoice',
        'get-journal',
        'get-monthly-series',
        'get-my-role',
        'get-period-status',
        'get-project',
        'get-project-profitability',
        'get-resource-performance',
        'get-resource-profitability',
        'get-settings',
        'get-t-account',
        'get-template',
        'get-trial-balance',
        'get-wip',
        'list-accounts',
        'list-audit-trail',
        'list-bank-lines',
        'list-client-funds',
        'list-client-funds-transactions',
        'list-counterparties',
        'list-currencies',
        'list-disbursements',
        'list-invoices',
        'list-journals',
        'list-projects',
        'list-recurring-fees',
        'list-resources',
        'list-success-fees',
        'list-templates',
        'list-work-entries',
        'suggest-bank-match',
        'validate-journal'
    ) THEN 'view'
    WHEN p_operation IN (
        'add-invoice-reminder',
        'add-invoice-reminders',
        'bill-disbursement',
        'bill-recurring-fee',
        'client-funds-deposit',
        'client-funds-disburse',
        'client-funds-refund',
        'close-period',
        'create-account',
        'create-counterparty',
        'create-currency',
        'create-disbursement',
        'create-invoice',
        'create-journal',
        'create-project',
        'create-recurring-fee',
        'create-resource',
        'create-success-fee',
        'create-template',
        'deactivate-account',
        'deactivate-template',
        'delete-counterparty',
        'delete-disbursement',
        'delete-journal',
        'delete-project',
        'delete-work-entry',
        'import-bank-lines',
        'issue-invoice',
        'mark-invoice-delivery',
        'pay-disbursement',
        'post-journal',
        'reconcile-bank-line',
        'reconcile-suggested-lines',
        'record-expense',
        'record-payment',
        'record-work-entry',
        'reverse-journal',
        'reverse-payment',
        'run-recurring-fees',
        'settle-success-fee',
        'update-account',
        'update-counterparty',
        'update-invoice-draft',
        'update-journal',
        'update-project',
        'update-recurring-fee',
        'update-resource',
        'update-success-fee',
        'update-template',
        'update-work-entry',
        'void-invoice'
    ) THEN 'write'
    WHEN p_operation IN (
        'grant-permission',
        'list-permissions',
        'reopen-period',
        'revoke-permission',
        'seed-chart-of-accounts',
        'update-settings'
    ) THEN 'administer'
    ELSE NULL
  END
$function$;

CREATE OR REPLACE FUNCTION conta_agent_can(p_action text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  raw_scopes text := coalesce(current_setting('app.agent_scopes', true), '');
  s text;
BEGIN
  IF raw_scopes = '' OR coalesce(current_setting('app.current_user_role', true), '') <> 'agent' THEN
    RETURN false;
  END IF;
  IF kitsuden_agent_can_in_kon('conta', 'conta:' || p_action) THEN RETURN true; END IF;
  IF kitsuden_agent_denied('conta:' || p_action) THEN RETURN false; END IF;
  FOREACH s IN ARRAY string_to_array(raw_scopes, ',') LOOP
    IF left(s, 10) = 'kon:conta:'
       AND conta_operation_action(substr(s, 11)) = p_action
       AND kitsuden_agent_can_in_kon('conta', s) THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END
$function$;
