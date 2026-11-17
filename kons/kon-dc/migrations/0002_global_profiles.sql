-- kon-dc — what follows a member across every server of this bot
-- ============================================================================
-- A profile (bio, colour, reputation, badges) and global balances (credits, global XP), keyed by
-- the Discord user only. A server's own coins and XP stay in dc_wallets.

CREATE TABLE IF NOT EXISTS dc_profiles (
  user_id        varchar(20) PRIMARY KEY CHECK (user_id ~ '^[0-9]{15,20}$'),
  -- Last name and avatar seen: global leaderboards show people who are not in this server.
  name           varchar(100),
  avatar         varchar(64),
  bio            varchar(300),
  accent         varchar(7) CHECK (accent IS NULL OR accent ~ '^#[0-9a-fA-F]{6}$'),
  rep            integer NOT NULL DEFAULT 0 CHECK (rep >= 0),
  rep_given_at   timestamptz,
  -- Ids of catalog items shown on the profile (badges) and its background item.
  badges         jsonb NOT NULL DEFAULT '[]'::jsonb,
  background     varchar(64),
  -- The global daily: the last day (days since 1970, UTC) it was claimed, and the streak.
  daily_day      integer,
  daily_streak   integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dc_global_wallets (
  user_id     varchar(20) NOT NULL CHECK (user_id ~ '^[0-9]{15,20}$'),
  currency    varchar(32) NOT NULL CHECK (currency ~ '^[a-z0-9_-]{1,32}$'),
  balance     bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (currency, user_id)
);

CREATE INDEX IF NOT EXISTS dc_global_wallets_top_idx ON dc_global_wallets (currency, balance DESC);

SELECT kitsuden_rls_team('dc_profiles', 'dc', 'dc-bot:view', 'dc-bot:update');
SELECT kitsuden_rls_team('dc_global_wallets', 'dc', 'dc-bot:view', 'dc-bot:update');
