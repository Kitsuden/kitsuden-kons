-- ═══════════════════════════════════════════════════════════════════════════
-- kon-newsletter: the tables the kon declared and no migration created
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `newsletter.schema.ts` declares eight tables and the kon did not have a
-- single `.sql` file. The kon showed as installed and enabled, and at startup
-- this appeared
--
--     [Newsletter] Could not seed the default newsletter
--     Failed query: select "id" from "nl_newsletters" limit $1
--
-- logged as a warning, not an error, so startup carried on and the kon was
-- left unusable without anything saying so.
--
-- The columns are copied from `newsletter.schema.ts`, which is what the code
-- queries. `scripts/verify-schema.ts` compares both on every startup.

-- ── Newsletters ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nl_newsletters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          varchar(64) NOT NULL,
  name          varchar(200) NOT NULL,
  description   text,
  from_name     varchar(200),
  from_email    varchar(320),
  reply_to      varchar(320),
  public_signup boolean NOT NULL DEFAULT true,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS nl_newsletters_slug_idx ON nl_newsletters(slug);

-- ── Members ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nl_members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          varchar(320) NOT NULL,
  name           varchar(200),
  status         varchar(16) NOT NULL DEFAULT 'pending',
  locale         varchar(8) NOT NULL DEFAULT 'es',
  user_id        text,

  -- Consent (GDPR). It is not red tape: if there is a complaint we must be able
  -- to prove when, from where and through which channel the address signed up.
  consent_at     timestamptz,
  consent_ip     varchar(45),
  consent_source varchar(64),

  confirm_token   varchar(128),
  confirm_sent_at timestamptz,
  -- The unsubscribe token is REQUIRED: without it, a member cannot unsubscribe
  -- and the mailing becomes unsolicited email.
  unsub_token     varchar(128) NOT NULL,

  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS nl_members_email_idx       ON nl_members(email);
CREATE UNIQUE INDEX IF NOT EXISTS nl_members_unsub_token_idx ON nl_members(unsub_token);
CREATE INDEX IF NOT EXISTS nl_members_status_idx ON nl_members(status);
CREATE INDEX IF NOT EXISTS nl_members_user_idx   ON nl_members(user_id);

-- ── Member ↔ newsletter subscription ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nl_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     uuid NOT NULL,
  newsletter_id uuid NOT NULL,
  subscribed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS nl_subs_member_newsletter_idx
  ON nl_subscriptions(member_id, newsletter_id);
CREATE INDEX IF NOT EXISTS nl_subs_newsletter_idx ON nl_subscriptions(newsletter_id);

-- ── Suppression ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nl_suppressions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      varchar(320) NOT NULL,
  reason     varchar(16) NOT NULL,
  source     varchar(32) NOT NULL DEFAULT 'local',
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS nl_suppressions_email_idx  ON nl_suppressions(email);
CREATE INDEX IF NOT EXISTS nl_suppressions_reason_idx ON nl_suppressions(reason);

-- ── Segments ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nl_segments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       varchar(64) NOT NULL,
  name       varchar(200) NOT NULL,
  filter     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS nl_segments_slug_idx ON nl_segments(slug);

-- ── Campaigns ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nl_campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  newsletter_id uuid NOT NULL,
  segment_id    uuid,
  post_id       text,

  subject      varchar(500) NOT NULL,
  preview_text varchar(300),
  html         text NOT NULL,
  text         text,

  status       varchar(16) NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz,
  started_at   timestamptz,
  completed_at timestamptz,

  stats      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nl_campaigns_newsletter_idx ON nl_campaigns(newsletter_id);
CREATE INDEX IF NOT EXISTS nl_campaigns_status_idx     ON nl_campaigns(status);
CREATE INDEX IF NOT EXISTS nl_campaigns_scheduled_idx  ON nl_campaigns(scheduled_at);

-- A post publishes ONE campaign. Without this, republishing an article —or two
-- workers seeing the same event— resends the whole newsletter to the entire list.
CREATE UNIQUE INDEX IF NOT EXISTS nl_campaigns_post_idx
  ON nl_campaigns(post_id) WHERE post_id IS NOT NULL;

-- ── Deliveries ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nl_deliveries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL,
  member_id   uuid NOT NULL,
  email       varchar(320) NOT NULL,

  status     varchar(16) NOT NULL DEFAULT 'pending',
  message_id varchar(255),
  error      text,
  attempts   integer NOT NULL DEFAULT 0,

  sent_at    timestamptz,
  opened_at  timestamptz,
  clicked_at timestamptz
);

-- THE idempotency guarantee: resuming an interrupted send does not write again
-- to anyone who already got the email.
CREATE UNIQUE INDEX IF NOT EXISTS nl_deliveries_campaign_member_idx
  ON nl_deliveries(campaign_id, member_id);
CREATE INDEX IF NOT EXISTS nl_deliveries_status_idx  ON nl_deliveries(campaign_id, status);
-- The provider's webhook arrives with its message_id and we must find the row.
CREATE INDEX IF NOT EXISTS nl_deliveries_message_idx ON nl_deliveries(message_id);
CREATE INDEX IF NOT EXISTS nl_deliveries_email_idx   ON nl_deliveries(email);

-- ── Feedback log (bounces, complaints, opens) ───────────────────────────────
CREATE TABLE IF NOT EXISTS nl_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    varchar(32) NOT NULL,
  external_id varchar(255) NOT NULL,
  type        varchar(24) NOT NULL,
  email       varchar(320) NOT NULL,
  message_id  varchar(255),
  detail      text,
  raw         jsonb,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Providers retry webhooks: without this unique index, a bounce would count
-- several times and could suppress an address by mistake.
CREATE UNIQUE INDEX IF NOT EXISTS nl_events_dedupe_idx ON nl_events(provider, external_id);
CREATE INDEX IF NOT EXISTS nl_events_email_idx ON nl_events(email);
CREATE INDEX IF NOT EXISTS nl_events_type_idx  ON nl_events(type);
