-- kon-conta: everything a business that bills clients runs through the ledger.
--
-- Invoices with lines, partial payments, work billed as quantity times rate, recurring fees,
-- success fees, client funds, bank statement lines, period close and an audit trail. Money still
-- moves only through journals: these tables hold the documents and point at their journals.
--
-- Client funds balances have no table of their own: they are read from the ledger lines of the
-- client funds liability account, so a second copy cannot drift from the books.
--
-- Part 1 renames what 0000 created with one trade's words (matters, trust) to generic ones, in
-- place, so the data stays. Every step checks first: it works on a fresh chain, on a database at
-- 0006, and if a name was already changed by hand.
--
-- Comments here avoid semicolons: index.ts splits this file on them at startup.

-- ═══ Part 1: generic names for what already existed ═══════════════════════════════════════════

-- Tables.
DO $$
BEGIN
    IF to_regclass('public.conta_matters') IS NOT NULL AND to_regclass('public.conta_projects') IS NULL THEN
        ALTER TABLE conta_matters RENAME TO conta_projects;
    END IF;
END $$;

-- Columns.
DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('conta_projects', 'matter_number', 'number'),
        ('conta_ledger_entries', 'matter_id', 'project_id'),
        ('conta_disbursements', 'matter_id', 'project_id'),
        ('conta_accounts', 'is_trust_account', 'is_client_funds_account')
    ) AS v(tbl, old_name, new_name) LOOP
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.old_name)
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.new_name) THEN
            EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', r.tbl, r.old_name, r.new_name);
        END IF;
    END LOOP;
END $$;

-- Constraints: keys, foreign keys and, on Postgres 18, the named NOT NULL ones. A unique or
-- primary key constraint takes its index along. Whatever still says matter gets the new word.
DO $$
DECLARE
    r record;
    new_name text;
BEGIN
    FOR r IN
        SELECT c.conname, t.relname AS tbl
        FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname IN ('conta_projects', 'conta_ledger_entries', 'conta_disbursements')
          AND c.conname LIKE '%matter%'
    LOOP
        new_name := replace(replace(replace(r.conname, 'conta_matters_', 'conta_projects_'), 'matter_number', 'number'), 'matter_id', 'project_id');
        IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = r.tbl AND c.conname = new_name) THEN
            EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.conname, new_name);
        END IF;
    END LOOP;
END $$;

-- Indexes.
DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('idx_conta_matters_client', 'idx_conta_projects_client'),
        ('idx_conta_matters_status', 'idx_conta_projects_status'),
        ('idx_conta_ledger_matter', 'idx_conta_ledger_project'),
        ('idx_conta_disb_matter', 'idx_conta_disb_project'),
        ('idx_conta_accounts_trust', 'idx_conta_accounts_client_funds')
    ) AS v(old_name, new_name) LOOP
        IF to_regclass('public.' || r.old_name) IS NOT NULL AND to_regclass('public.' || r.new_name) IS NULL THEN
            EXECUTE format('ALTER INDEX %I RENAME TO %I', r.old_name, r.new_name);
        END IF;
    END LOOP;
END $$;

-- Types and enum values.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conta_matter_status')
       AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conta_project_status') THEN
        ALTER TYPE conta_matter_status RENAME TO conta_project_status;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'conta_journal_type' AND e.enumlabel = 'trust_deposit') THEN
        ALTER TYPE conta_journal_type RENAME VALUE 'trust_deposit' TO 'client_funds_deposit';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'conta_journal_type' AND e.enumlabel = 'trust_withdrawal') THEN
        ALTER TYPE conta_journal_type RENAME VALUE 'trust_withdrawal' TO 'client_funds_disbursement';
    END IF;
END $$;

-- Policies of the renamed table keep working under the old name: they get the new one.
DO $$
DECLARE p record;
BEGIN
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'conta_projects' AND policyname LIKE 'conta\_matters\_%' LOOP
        EXECUTE format('ALTER POLICY %I ON conta_projects RENAME TO %I', p.policyname, replace(p.policyname, 'conta_matters_', 'conta_projects_'));
    END LOOP;
END $$;

-- Seeded account names, only where nobody changed them.
UPDATE conta_accounts SET name = 'Bank - Client Funds' WHERE code = '1150' AND name = 'Bank - Trust';
UPDATE conta_accounts SET name = 'Client Funds Held' WHERE code = '2100' AND name = 'Client Trust Funds';
UPDATE conta_accounts SET name = 'Service Revenue' WHERE code = '4000' AND name = 'Legal Fees Revenue';

-- Stored scopes and tool names of the renamed operations: agents, OAuth grants and pending
-- approvals keep working. A denial keeps its "!". Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:conta:list-matters":"kon:conta:list-projects","conta:list-matters":"conta:list-projects","conta__list-matters":"conta__list-projects","kon:conta:get-matter":"kon:conta:get-project","conta:get-matter":"conta:get-project","conta__get-matter":"conta__get-project","kon:conta:create-matter":"kon:conta:create-project","conta:create-matter":"conta:create-project","conta__create-matter":"conta__create-project","kon:conta:update-matter":"kon:conta:update-project","conta:update-matter":"conta:update-project","conta__update-matter":"conta__update-project","kon:conta:delete-matter":"kon:conta:delete-project","conta:delete-matter":"conta:delete-project","conta__delete-matter":"conta__delete-project","kon:conta:get-trust-balance":"kon:conta:get-client-funds-balance","conta:get-trust-balance":"conta:get-client-funds-balance","conta__get-trust-balance":"conta__get-client-funds-balance"}'::jsonb;
  ops jsonb := '{"list-matters":"list-projects","get-matter":"get-project","create-matter":"create-project","update-matter":"update-project","delete-matter":"delete-project","get-trust-balance":"get-client-funds-balance"}'::jsonb;
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

-- ═══ Part 2: billing ══════════════════════════════════════════════════════════════════════════

-- New journal types. Not used by this file, so it can run inside a transaction on Postgres 12 or later.
ALTER TYPE conta_journal_type ADD VALUE IF NOT EXISTS 'invoice';
ALTER TYPE conta_journal_type ADD VALUE IF NOT EXISTS 'credit_note';
ALTER TYPE conta_journal_type ADD VALUE IF NOT EXISTS 'payment';
ALTER TYPE conta_journal_type ADD VALUE IF NOT EXISTS 'client_funds_refund';
ALTER TYPE conta_journal_type ADD VALUE IF NOT EXISTS 'client_funds_application';
ALTER TYPE conta_journal_type ADD VALUE IF NOT EXISTS 'bank_fee';

-- ── Columns on existing tables ─────────────────────────────────────────────────────────────────
ALTER TABLE conta_journals
    ADD COLUMN IF NOT EXISTS created_by text DEFAULT NULLIF(current_setting('app.current_user_id', true), '');

ALTER TABLE conta_counterparties
    ADD COLUMN IF NOT EXISTS contact_name text,
    ADD COLUMN IF NOT EXISTS payment_terms_days integer,
    ADD COLUMN IF NOT EXISTS funds_minimum numeric(19,4) DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS external_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conta_cp_external_ref ON conta_counterparties (external_ref) WHERE external_ref IS NOT NULL;

ALTER TABLE conta_projects
    ADD COLUMN IF NOT EXISTS external_ref text,
    ADD COLUMN IF NOT EXISTS billing_type text DEFAULT 'time' NOT NULL,
    ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE conta_projects DROP CONSTRAINT IF EXISTS conta_projects_billing_type_check;
ALTER TABLE conta_projects ADD CONSTRAINT conta_projects_billing_type_check
    CHECK (billing_type IN ('time', 'fixed', 'recurring', 'success'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_conta_projects_external_ref ON conta_projects (external_ref) WHERE external_ref IS NOT NULL;

-- ── Settings: one row, read by every posting ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conta_settings (
    id text PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
    base_currency text DEFAULT 'USD' NOT NULL,
    default_tax_rate numeric(7,6) DEFAULT 0 NOT NULL CHECK (default_tax_rate >= 0 AND default_tax_rate <= 1),
    tax_rates jsonb DEFAULT '[]'::jsonb NOT NULL,
    default_payment_terms_days integer DEFAULT 30 NOT NULL CHECK (default_payment_terms_days >= 0),
    invoice_prefix text DEFAULT 'INV' NOT NULL,
    credit_note_prefix text DEFAULT 'CN' NOT NULL,
    number_padding integer DEFAULT 4 NOT NULL CHECK (number_padding BETWEEN 1 AND 12),
    locked_until text,
    account_codes jsonb DEFAULT '{}'::jsonb NOT NULL,
    bank_fee_keywords jsonb DEFAULT '["FEE", "CHARGE", "COMMISSION", "MAINTENANCE"]'::jsonb NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    billing_types jsonb DEFAULT '["time", "fixed", "recurring", "success"]'::jsonb NOT NULL,
    issuer jsonb DEFAULT '{}'::jsonb NOT NULL,
    targets jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
-- Who issues the documents (name, tax id, address, bank details, logo, footer) and the targets the
-- business measures itself against. Added here too for a table created before these columns.
ALTER TABLE conta_settings
    ADD COLUMN IF NOT EXISTS issuer jsonb DEFAULT '{}'::jsonb NOT NULL,
    ADD COLUMN IF NOT EXISTS targets jsonb DEFAULT '[]'::jsonb NOT NULL;
INSERT INTO conta_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

-- Gapless document numbers: a row lock inside the posting transaction, not a Postgres sequence,
-- because a rolled-back issue must give its number back.
CREATE TABLE IF NOT EXISTS conta_number_sequences (
    key text PRIMARY KEY,
    next_value bigint NOT NULL
);

-- ── Resources and their work ───────────────────────────────────────────────────────────────────
-- A resource is a person or anything billed per unit: a machine, a room, a vehicle.
CREATE TABLE IF NOT EXISTS conta_resources (
    id text PRIMARY KEY,
    user_id text,
    external_ref text,
    name text NOT NULL,
    title text,
    unit text DEFAULT 'hour' NOT NULL,
    billing_rate numeric(19,4) DEFAULT 0 NOT NULL CHECK (billing_rate >= 0),
    cost_rate numeric(19,4) DEFAULT 0 NOT NULL CHECK (cost_rate >= 0),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conta_resources_user ON conta_resources (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conta_resources_external_ref ON conta_resources (external_ref) WHERE external_ref IS NOT NULL;

ALTER TABLE conta_projects
    ADD COLUMN IF NOT EXISTS responsible_resource_id text REFERENCES conta_resources(id);
CREATE INDEX IF NOT EXISTS idx_conta_projects_responsible ON conta_projects (responsible_resource_id);

-- ── Invoices ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conta_invoices (
    id text PRIMARY KEY,
    number text UNIQUE,
    status text DEFAULT 'draft' NOT NULL CHECK (status IN ('draft', 'issued', 'void')),
    client_id text NOT NULL REFERENCES conta_counterparties(id),
    project_id text REFERENCES conta_projects(id),
    concept text NOT NULL,
    fee_type text DEFAULT 'time' NOT NULL CHECK (fee_type IN ('time', 'fixed', 'recurring', 'success')),
    revenue_account_id text NOT NULL REFERENCES conta_accounts(id),
    currency text NOT NULL,
    issue_date text NOT NULL,
    due_date text NOT NULL,
    terms_days integer NOT NULL CHECK (terms_days >= 0),
    tax_rate numeric(7,6) DEFAULT 0 NOT NULL CHECK (tax_rate >= 0 AND tax_rate <= 1),
    discount numeric(19,4) DEFAULT 0 NOT NULL CHECK (discount >= 0),
    fees numeric(19,4) DEFAULT 0 NOT NULL,
    expenses numeric(19,4) DEFAULT 0 NOT NULL,
    fees_net numeric(19,4) DEFAULT 0 NOT NULL,
    tax numeric(19,4) DEFAULT 0 NOT NULL,
    total numeric(19,4) DEFAULT 0 NOT NULL,
    amount_paid numeric(19,4) DEFAULT 0 NOT NULL CHECK (amount_paid >= 0),
    journal_id text REFERENCES conta_journals(id),
    void_journal_id text REFERENCES conta_journals(id),
    credit_note_number text UNIQUE,
    void_reason text,
    voided_on text,
    sent_at timestamp with time zone,
    viewed_at timestamp with time zone,
    source text DEFAULT 'manual' NOT NULL,
    external_ref text,
    created_by text DEFAULT NULLIF(current_setting('app.current_user_id', true), ''),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conta_invoices_not_overpaid CHECK (amount_paid <= total)
);
CREATE INDEX IF NOT EXISTS idx_conta_invoices_status ON conta_invoices (status);
CREATE INDEX IF NOT EXISTS idx_conta_invoices_client ON conta_invoices (client_id);
CREATE INDEX IF NOT EXISTS idx_conta_invoices_project ON conta_invoices (project_id);
CREATE INDEX IF NOT EXISTS idx_conta_invoices_issue_date ON conta_invoices (issue_date);
CREATE INDEX IF NOT EXISTS idx_conta_invoices_due_date ON conta_invoices (due_date);

CREATE TABLE IF NOT EXISTS conta_invoice_lines (
    id text PRIMARY KEY,
    invoice_id text NOT NULL REFERENCES conta_invoices(id) ON DELETE CASCADE,
    position integer DEFAULT 0 NOT NULL,
    kind text DEFAULT 'fee' NOT NULL CHECK (kind IN ('fee', 'expense')),
    description text NOT NULL,
    quantity numeric(12,4) DEFAULT 1 NOT NULL CHECK (quantity >= 0),
    unit text,
    unit_price numeric(19,4) DEFAULT 0 NOT NULL CHECK (unit_price >= 0),
    amount numeric(19,4) DEFAULT 0 NOT NULL,
    resource_id text REFERENCES conta_resources(id),
    line_date text,
    work_entry_id text,
    disbursement_id text
);
CREATE INDEX IF NOT EXISTS idx_conta_invoice_lines_invoice ON conta_invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS idx_conta_invoice_lines_resource ON conta_invoice_lines (resource_id);

CREATE TABLE IF NOT EXISTS conta_invoice_payments (
    id text PRIMARY KEY,
    invoice_id text NOT NULL REFERENCES conta_invoices(id),
    date text NOT NULL,
    amount numeric(19,4) NOT NULL CHECK (amount > 0),
    source text DEFAULT 'account' NOT NULL CHECK (source IN ('account', 'client_funds')),
    account_id text NOT NULL REFERENCES conta_accounts(id),
    method text,
    reference text,
    journal_id text NOT NULL REFERENCES conta_journals(id),
    reversal_journal_id text REFERENCES conta_journals(id),
    reversed_on text,
    bank_line_id text,
    attachment_media_id text,
    created_by text DEFAULT NULLIF(current_setting('app.current_user_id', true), ''),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
-- A file kept with the payment, such as a scan of the receipt: its id in the media library.
ALTER TABLE conta_invoice_payments ADD COLUMN IF NOT EXISTS attachment_media_id text;
CREATE INDEX IF NOT EXISTS idx_conta_payments_invoice ON conta_invoice_payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_conta_payments_date ON conta_invoice_payments (date);

CREATE TABLE IF NOT EXISTS conta_invoice_reminders (
    id text PRIMARY KEY,
    invoice_id text NOT NULL REFERENCES conta_invoices(id) ON DELETE CASCADE,
    date text NOT NULL,
    channel text NOT NULL,
    note text,
    created_by text DEFAULT NULLIF(current_setting('app.current_user_id', true), ''),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conta_reminders_invoice ON conta_invoice_reminders (invoice_id);

-- Work billed as quantity times rate: hours of a person, days of a machine, sessions of a room.
CREATE TABLE IF NOT EXISTS conta_work_entries (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES conta_projects(id),
    resource_id text NOT NULL REFERENCES conta_resources(id),
    date text NOT NULL,
    description text NOT NULL,
    quantity numeric(12,4) NOT NULL CHECK (quantity > 0),
    unit text DEFAULT 'hour' NOT NULL,
    billing_rate numeric(19,4) NOT NULL CHECK (billing_rate >= 0),
    cost_rate numeric(19,4) DEFAULT 0 NOT NULL CHECK (cost_rate >= 0),
    invoice_id text REFERENCES conta_invoices(id),
    external_ref text,
    created_by text DEFAULT NULLIF(current_setting('app.current_user_id', true), ''),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conta_work_project ON conta_work_entries (project_id);
CREATE INDEX IF NOT EXISTS idx_conta_work_resource ON conta_work_entries (resource_id);
CREATE INDEX IF NOT EXISTS idx_conta_work_invoice ON conta_work_entries (invoice_id);
CREATE INDEX IF NOT EXISTS idx_conta_work_date ON conta_work_entries (date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conta_work_external_ref ON conta_work_entries (external_ref) WHERE external_ref IS NOT NULL;

-- Disbursements become billable through an invoice, besides the older bill and pay steps.
-- The date is filled from created_at only when the column is first added: a rerun keeps dates.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conta_disbursements' AND column_name = 'date') THEN
        ALTER TABLE conta_disbursements ADD COLUMN date text NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD');
        UPDATE conta_disbursements SET date = to_char(created_at, 'YYYY-MM-DD');
    END IF;
END $$;
ALTER TABLE conta_disbursements
    ADD COLUMN IF NOT EXISTS category text,
    ADD COLUMN IF NOT EXISTS invoice_id text REFERENCES conta_invoices(id),
    ADD COLUMN IF NOT EXISTS external_ref text,
    ADD COLUMN IF NOT EXISTS created_by text DEFAULT NULLIF(current_setting('app.current_user_id', true), '');
CREATE INDEX IF NOT EXISTS idx_conta_disb_invoice ON conta_disbursements (invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conta_disb_external_ref ON conta_disbursements (external_ref) WHERE external_ref IS NOT NULL;

-- ── Recurring fees and success fees ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conta_recurring_fees (
    id text PRIMARY KEY,
    client_id text NOT NULL REFERENCES conta_counterparties(id),
    project_id text REFERENCES conta_projects(id),
    concept text NOT NULL,
    amount numeric(19,4) NOT NULL CHECK (amount > 0),
    quantity_included numeric(12,4) DEFAULT 0 NOT NULL CHECK (quantity_included >= 0),
    unit text DEFAULT 'hour' NOT NULL,
    frequency text DEFAULT 'monthly' NOT NULL,
    next_date text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    since text NOT NULL,
    last_invoice_id text REFERENCES conta_invoices(id),
    external_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
-- Named and replaced, not inline: a rerun, or a table created with fewer frequencies, ends with this list.
ALTER TABLE conta_recurring_fees DROP CONSTRAINT IF EXISTS conta_recurring_fees_frequency_check;
ALTER TABLE conta_recurring_fees ADD CONSTRAINT conta_recurring_fees_frequency_check
    CHECK (frequency IN ('monthly', 'quarterly', 'semiannual', 'annual'));
CREATE INDEX IF NOT EXISTS idx_conta_recurring_fees_client ON conta_recurring_fees (client_id);
CREATE INDEX IF NOT EXISTS idx_conta_recurring_fees_due ON conta_recurring_fees (is_active, next_date);

-- A fee that depends on a result: a share of what the project achieves, billed only if it does.
CREATE TABLE IF NOT EXISTS conta_success_fees (
    id text PRIMARY KEY,
    client_id text NOT NULL REFERENCES conta_counterparties(id),
    project_id text NOT NULL REFERENCES conta_projects(id),
    base_amount numeric(19,4) NOT NULL CHECK (base_amount >= 0),
    percentage numeric(7,6) NOT NULL CHECK (percentage >= 0 AND percentage <= 1),
    probability numeric(7,6) DEFAULT 0 NOT NULL CHECK (probability >= 0 AND probability <= 1),
    stage text,
    expected_date text,
    status text DEFAULT 'open' NOT NULL CHECK (status IN ('open', 'won', 'lost')),
    achieved_amount numeric(19,4),
    settled_on text,
    invoice_id text REFERENCES conta_invoices(id),
    external_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conta_success_fees_client ON conta_success_fees (client_id);
CREATE INDEX IF NOT EXISTS idx_conta_success_fees_status ON conta_success_fees (status);

-- ── Bank statement lines ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conta_bank_lines (
    id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES conta_accounts(id),
    date text NOT NULL,
    description text NOT NULL,
    reference text,
    amount numeric(19,4) NOT NULL,
    match_kind text CHECK (match_kind IN ('invoice', 'fee', 'client_funds', 'journal', 'transfer')),
    match_label text,
    match_id text,
    journal_id text REFERENCES conta_journals(id),
    reconciled_at timestamp with time zone,
    reconciled_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conta_bank_lines_account ON conta_bank_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_conta_bank_lines_date ON conta_bank_lines (date);
CREATE INDEX IF NOT EXISTS idx_conta_bank_lines_pending ON conta_bank_lines (account_id) WHERE reconciled_at IS NULL;
-- Importing the same statement twice must not double the lines.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conta_bank_lines_identity ON conta_bank_lines (account_id, date, reference, amount) WHERE reference IS NOT NULL;

-- ── Audit trail: append-only ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conta_audit_log (
    id text PRIMARY KEY,
    at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id text DEFAULT NULLIF(current_setting('app.current_user_id', true), ''),
    action text NOT NULL,
    entity_type text,
    entity_id text,
    summary text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conta_audit_at ON conta_audit_log (at);
CREATE INDEX IF NOT EXISTS idx_conta_audit_action ON conta_audit_log (action);
CREATE INDEX IF NOT EXISTS idx_conta_audit_entity ON conta_audit_log (entity_type, entity_id);

-- ── RLS, forced, with the same rules as the other tables of the kon ────────────────────────────
DO $$
DECLARE
    t text;
    is_system text := '((COALESCE(current_setting(''app.current_user_id'', true), '''') = '''') AND (COALESCE(current_setting(''app.current_user_role'', true), '''') = ''''))';
    is_admin text := '(current_setting(''app.current_user_role'', true) = ''admin'')';
    reader text;
    writer text;
    agent_reader text := '(conta_agent_can(''view'') OR conta_agent_can(''write'') OR conta_agent_can(''administer''))';
    agent_writer text := '(conta_agent_can(''write'') OR conta_agent_can(''administer''))';
BEGIN
    reader := format('(%s OR %s OR (conta_current_role() IS NOT NULL))', is_system, is_admin);
    writer := format('(%s OR %s OR (conta_current_role() = ''accountant''))', is_system, is_admin);

    FOREACH t IN ARRAY ARRAY[
        'conta_settings', 'conta_number_sequences', 'conta_resources', 'conta_invoices',
        'conta_invoice_lines', 'conta_invoice_payments', 'conta_invoice_reminders',
        'conta_work_entries', 'conta_recurring_fees', 'conta_success_fees', 'conta_bank_lines',
        'conta_audit_log'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_select', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING %s', t || '_conta_select', t, reader);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_insert', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK %s', t || '_conta_insert', t, writer);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_agent_select', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING %s', t || '_conta_agent_select', t, agent_reader);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_agent_insert', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK %s', t || '_conta_agent_insert', t, agent_writer);

        -- The audit trail stops here: no UPDATE and no DELETE policy, so nobody rewrites it.
        IF t <> 'conta_audit_log' THEN
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_update', t);
            EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING %s WITH CHECK %s', t || '_conta_update', t, writer, writer);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_delete', t);
            EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING %s', t || '_conta_delete', t, writer);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_agent_update', t);
            EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING %s WITH CHECK %s', t || '_conta_agent_update', t, agent_writer, agent_writer);
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_agent_delete', t);
            EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING %s', t || '_conta_agent_delete', t, agent_writer);
        END IF;
    END LOOP;
END $$;
