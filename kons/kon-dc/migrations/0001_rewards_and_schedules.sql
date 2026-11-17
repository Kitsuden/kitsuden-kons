-- kon-dc — rewards (currencies, items, member lists) and schedules
-- ============================================================================
-- The economy is per server and SHARED by every module on purpose: coins a blueprint gives can be
-- spent in the Economy module's shop, and XP is the currency the Levels module counts.

CREATE TABLE IF NOT EXISTS dc_wallets (
  guild_id    varchar(20) NOT NULL REFERENCES dc_guilds (id) ON DELETE CASCADE,
  user_id     varchar(20) NOT NULL CHECK (user_id ~ '^[0-9]{15,20}$'),
  currency    varchar(32) NOT NULL CHECK (currency ~ '^[a-z0-9_-]{1,32}$'),
  balance     bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, currency, user_id)
);

-- Leaderboards: the top balances of one currency in one server.
CREATE INDEX IF NOT EXISTS dc_wallets_top_idx ON dc_wallets (guild_id, currency, balance DESC);

CREATE TABLE IF NOT EXISTS dc_inventory (
  guild_id    varchar(20) NOT NULL REFERENCES dc_guilds (id) ON DELETE CASCADE,
  user_id     varchar(20) NOT NULL CHECK (user_id ~ '^[0-9]{15,20}$'),
  item        varchar(64) NOT NULL CHECK (item ~ '^[a-z0-9_-]{1,64}$'),
  quantity    integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id, item)
);

-- Lists of members: giveaway entries, raffles, queues, teams. One row per member, so a thousand
-- people pressing "Enter" at once never overwrite each other.
CREATE TABLE IF NOT EXISTS dc_list_members (
  guild_id    varchar(20) NOT NULL REFERENCES dc_guilds (id) ON DELETE CASCADE,
  namespace   varchar(60) NOT NULL,
  list        varchar(64) NOT NULL,
  user_id     varchar(20) NOT NULL CHECK (user_id ~ '^[0-9]{15,20}$'),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, namespace, list, user_id)
);

-- Work for later: `later` steps, giveaway ends, reminders (one-off), and `schedule` triggers and
-- scheduled messages (recurring: `spec` set, `run_at` moves forward each time). Several API
-- replicas may tick: a row is claimed by deleting it (one-off) or by moving `run_at` from the value
-- it read (recurring), so only one of them runs it.
CREATE TABLE IF NOT EXISTS dc_schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    varchar(20) NOT NULL REFERENCES dc_guilds (id) ON DELETE CASCADE,
  module_id   varchar(60) NOT NULL,
  key         varchar(120) NOT NULL,
  run_at      timestamptz NOT NULL,
  spec        jsonb,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, module_id, key)
);

CREATE INDEX IF NOT EXISTS dc_schedules_due_idx ON dc_schedules (run_at);

SELECT kitsuden_rls_team('dc_wallets', 'dc', 'dc-bot:view', 'dc-bot:update');
SELECT kitsuden_rls_team('dc_inventory', 'dc', 'dc-bot:view', 'dc-bot:update');
SELECT kitsuden_rls_team('dc_list_members', 'dc', 'dc-bot:view', 'dc-bot:update');
SELECT kitsuden_rls_team('dc_schedules', 'dc', 'dc-bot:view', 'dc-bot:update');
