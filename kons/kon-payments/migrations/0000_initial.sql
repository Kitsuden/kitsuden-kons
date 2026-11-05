-- ═══════════════════════════════════════════════════════════════════════════
-- kon-payments: the tables the kon declared and no migration created
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `payments.schema.ts` declares three tables and the kon did not have a single
-- `.sql` file. The kon showed as installed and enabled, and its tables did not
-- exist: the first real query failed with `relation "pay_customers" does not exist`.
--
-- It went unnoticed because the kon starts without touching the database (it only
-- warns that no providers are configured) and nobody reaches payments until someone
-- is paying. In other words, it would have been found with the first customer.
--
-- The columns are copied from `payments.schema.ts`, which is what the code
-- queries. `scripts/verify-schema.ts` compares both on every startup.

-- ── Customers ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pay_customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The app's user. It is what lets us answer "does this user pay?".
  user_id     text NOT NULL,
  provider    varchar(32) NOT NULL,
  -- Customer id AT the provider.
  external_id varchar(128) NOT NULL,
  email       varchar(320),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A user has ONE customer per provider: they can pay with Stripe and with
-- PayPal, but cannot have two accounts at the same one.
CREATE UNIQUE INDEX IF NOT EXISTS pay_customers_user_provider_idx
  ON pay_customers(user_id, provider);
CREATE UNIQUE INDEX IF NOT EXISTS pay_customers_external_idx
  ON pay_customers(provider, external_id);

-- ── Subscriptions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pay_subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              text NOT NULL,
  provider             varchar(32) NOT NULL,
  external_id          varchar(128) NOT NULL,
  plan_id              varchar(128),
  -- trialing | active | past_due | canceled | paused | expired
  status               varchar(24) NOT NULL,
  -- Paid until when. It is the field that decides access: it is compared with
  -- now(), and `status` alone is NOT trusted: a `canceled` subscription can keep
  -- access until the period already charged ends.
  current_period_end   timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  metadata             jsonb DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pay_subs_external_idx
  ON pay_subscriptions(provider, external_id);
CREATE INDEX IF NOT EXISTS pay_subs_user_idx   ON pay_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS pay_subs_status_idx ON pay_subscriptions(status);

-- ── Events (log + idempotency) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pay_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        varchar(32) NOT NULL,
  -- Event id at the provider.
  external_id     varchar(191) NOT NULL,
  type            varchar(48) NOT NULL,
  user_id         text,
  subscription_id varchar(128),
  -- Amount in the smallest unit (cents).
  amount          integer,
  currency        varchar(3),
  -- Id of the journal entry generated in kon-conta, if the bridge is active.
  journal_id      uuid,
  payload         jsonb NOT NULL,
  processed_at    timestamptz NOT NULL DEFAULT now()
);

-- This UNIQUE index IS the idempotency, not an optimization: providers
-- retry webhooks, and without it journal entries and granted access would be
-- duplicated. If it ever gets in the way, the problem is elsewhere.
CREATE UNIQUE INDEX IF NOT EXISTS pay_events_dedupe_idx
  ON pay_events(provider, external_id);
CREATE INDEX IF NOT EXISTS pay_events_type_idx ON pay_events(type);
CREATE INDEX IF NOT EXISTS pay_events_user_idx ON pay_events(user_id);
