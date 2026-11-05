-- 0001 — Memberships: tiers, members, access grants and reader sessions
-- ============================================================================
-- Idempotent: it can be reapplied without breaking anything.

DO $$ BEGIN
  CREATE TYPE member_status AS ENUM ('free', 'paid', 'comped', 'canceled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE member_access_source AS ENUM ('subscription', 'comp', 'manual', 'import');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE content_visibility AS ENUM ('public', 'members', 'paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Plans ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS member_tiers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- Hierarchical: level N sees everything at level <= N. Without this, upgrading
  -- would remove access to the content of the lower plans.
  level INTEGER NOT NULL DEFAULT 0,
  monthly_price_cents INTEGER,
  yearly_price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'EUR',
  benefits JSONB NOT NULL DEFAULT '[]',
  visible BOOLEAN NOT NULL DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS member_tiers_slug_idx ON member_tiers (slug);
CREATE INDEX IF NOT EXISTS member_tiers_level_idx ON member_tiers (level);

-- ── Members ─────────────────────────────────────────────────────────────────
-- NOTE: a member is NOT a CMS user. They have no role and no password.
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  status member_status NOT NULL DEFAULT 'free',
  auth_user_id TEXT,
  newsletter_subscribed BOOLEAN NOT NULL DEFAULT true,
  source TEXT NOT NULL DEFAULT 'portal',
  labels JSONB NOT NULL DEFAULT '[]',
  note TEXT,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The email is the real key: duplicating it would split a person's history.
CREATE UNIQUE INDEX IF NOT EXISTS members_email_idx ON members (email);
CREATE INDEX IF NOT EXISTS members_status_idx ON members (status);

-- ── Access grants ───────────────────────────────────────────────────────────
-- A grants table and not a tier_id field: one person can hold a paid
-- subscription and gifted access at the same time, and when one expires they must not lose the other.
CREATE TABLE IF NOT EXISTS member_access (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL REFERENCES member_tiers(id) ON DELETE CASCADE,
  source member_access_source NOT NULL DEFAULT 'manual',
  subscription_id TEXT,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = indefinite. From a subscription, this is set to the END OF THE PAID PERIOD,
  -- not the cancellation date: whoever cancels keeps what they already paid for.
  ends_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_access_member_idx ON member_access (member_id);
-- Webhook idempotency: payment providers retry aggressively.
CREATE UNIQUE INDEX IF NOT EXISTS member_access_subscription_idx
  ON member_access (subscription_id) WHERE subscription_id IS NOT NULL;

-- ── Magic links ─────────────────────────────────────────────────────────────
-- The HASH is stored, never the token: a leak of this table cannot allow
-- impersonating anyone.
CREATE TABLE IF NOT EXISTS member_signins (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS member_signins_token_idx ON member_signins (token_hash);
CREATE INDEX IF NOT EXISTS member_signins_member_idx ON member_signins (member_id);

-- ── Reader sessions ─────────────────────────────────────────────────────────
-- Kept apart from the CMS sessions on purpose: a subscriber must not brush
-- against the back office, not even by accident.
CREATE TABLE IF NOT EXISTS member_sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS member_sessions_token_idx ON member_sessions (token_hash);
CREATE INDEX IF NOT EXISTS member_sessions_member_idx ON member_sessions (member_id);

-- Free plan by default: level 0 has to exist so that
-- visibility='members' works from day one.
INSERT INTO member_tiers (id, slug, name, level, visible)
VALUES ('tier_free', 'free', 'Gratis', 0, true)
ON CONFLICT (slug) DO NOTHING;
