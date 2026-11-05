-- Conta Kon - Initial Migration
-- General Ledger Engine for Kitsuden

-- ═══════════════════════════════════════════════════════════════════════════
-- ENUMS (Idempotent)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conta_account_type') THEN
        CREATE TYPE conta_account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conta_entry_status') THEN
        CREATE TYPE conta_entry_status AS ENUM ('draft', 'posted', 'reversed');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conta_counterparty_type') THEN
        CREATE TYPE conta_counterparty_type AS ENUM ('client', 'vendor', 'bank', 'other');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conta_matter_status') THEN
        CREATE TYPE conta_matter_status AS ENUM ('open', 'closed', 'on_hold');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conta_disbursement_status') THEN
        CREATE TYPE conta_disbursement_status AS ENUM ('pending', 'billed', 'paid');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conta_journal_type') THEN
        CREATE TYPE conta_journal_type AS ENUM ('standard', 'trust_deposit', 'trust_withdrawal', 'disbursement', 'disbursement_billed');
    END IF;
END
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- CURRENCIES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conta_currencies (
    code text PRIMARY KEY,
    name text NOT NULL,
    symbol text NOT NULL,
    decimal_places integer DEFAULT 2 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════════
-- COUNTERPARTIES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conta_counterparties (
    id text PRIMARY KEY,
    name text NOT NULL,
    email text,
    tax_id text,
    type conta_counterparty_type NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conta_cp_type ON conta_counterparties(type);
CREATE INDEX IF NOT EXISTS idx_conta_cp_tax ON conta_counterparties(tax_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- MATTERS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conta_matters (
    id text PRIMARY KEY,
    client_id text NOT NULL REFERENCES conta_counterparties(id),
    matter_number text NOT NULL UNIQUE,
    name text NOT NULL,
    description text,
    status conta_matter_status DEFAULT 'open' NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conta_matters_client ON conta_matters(client_id);
CREATE INDEX IF NOT EXISTS idx_conta_matters_status ON conta_matters(status);

-- ═══════════════════════════════════════════════════════════════════════════
-- ACCOUNTS (Chart of Accounts)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conta_accounts (
    id text PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    description text,
    type conta_account_type NOT NULL,
    parent_account_id text REFERENCES conta_accounts(id),
    opening_balance numeric(19, 4) DEFAULT 0 NOT NULL,
    current_balance numeric(19, 4) DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_trust_account boolean DEFAULT false NOT NULL,
    level integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conta_accounts_type ON conta_accounts(type);
CREATE INDEX IF NOT EXISTS idx_conta_accounts_parent ON conta_accounts(parent_account_id);
CREATE INDEX IF NOT EXISTS idx_conta_accounts_active ON conta_accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_conta_accounts_trust ON conta_accounts(is_trust_account);

-- ═══════════════════════════════════════════════════════════════════════════
-- JOURNAL TEMPLATES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conta_journal_templates (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text,
    template_type text NOT NULL,
    rules jsonb NOT NULL,
    required_metadata jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conta_templates_type ON conta_journal_templates(template_type);
CREATE INDEX IF NOT EXISTS idx_conta_templates_active ON conta_journal_templates(is_active);

-- ═══════════════════════════════════════════════════════════════════════════
-- JOURNALS (Entry Headers)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conta_journals (
    id text PRIMARY KEY,
    date text NOT NULL,
    description text NOT NULL,
    reference text,
    counterparty_id text REFERENCES conta_counterparties(id),
    total_amount numeric(19, 4) DEFAULT 0 NOT NULL,
    status conta_entry_status DEFAULT 'draft' NOT NULL,
    journal_type conta_journal_type DEFAULT 'standard' NOT NULL,
    template_id text REFERENCES conta_journal_templates(id),
    metadata jsonb DEFAULT '{}'::jsonb,
    reversal_of_id text REFERENCES conta_journals(id),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conta_journals_date ON conta_journals(date);
CREATE INDEX IF NOT EXISTS idx_conta_journals_status ON conta_journals(status);
CREATE INDEX IF NOT EXISTS idx_conta_journals_type ON conta_journals(journal_type);
CREATE INDEX IF NOT EXISTS idx_conta_journals_counterparty ON conta_journals(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_conta_journals_template ON conta_journals(template_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- LEDGER ENTRIES (Double-Entry Lines)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conta_ledger_entries (
    id text PRIMARY KEY,
    journal_id text NOT NULL REFERENCES conta_journals(id) ON DELETE CASCADE,
    account_id text NOT NULL REFERENCES conta_accounts(id),
    matter_id text REFERENCES conta_matters(id),
    description text,
    debit numeric(19, 4) DEFAULT 0 NOT NULL,
    credit numeric(19, 4) DEFAULT 0 NOT NULL,
    currency text NOT NULL REFERENCES conta_currencies(code) DEFAULT 'USD',
    exchange_rate numeric(19, 8) DEFAULT 1 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conta_ledger_journal ON conta_ledger_entries(journal_id);
CREATE INDEX IF NOT EXISTS idx_conta_ledger_account ON conta_ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_conta_ledger_matter ON conta_ledger_entries(matter_id);
CREATE INDEX IF NOT EXISTS idx_conta_ledger_currency ON conta_ledger_entries(currency);
CREATE INDEX IF NOT EXISTS idx_conta_ledger_created ON conta_ledger_entries(created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- DISBURSEMENTS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conta_disbursements (
    id text PRIMARY KEY,
    matter_id text NOT NULL REFERENCES conta_matters(id),
    journal_id text REFERENCES conta_journals(id),
    description text NOT NULL,
    amount numeric(19, 4) NOT NULL,
    status conta_disbursement_status DEFAULT 'pending' NOT NULL,
    billed_at timestamp with time zone,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conta_disb_matter ON conta_disbursements(matter_id);
CREATE INDEX IF NOT EXISTS idx_conta_disb_status ON conta_disbursements(status);
CREATE INDEX IF NOT EXISTS idx_conta_disb_journal ON conta_disbursements(journal_id);
