-- kon-dc — initial schema
-- ============================================================================
-- A kon's tables are created HERE, never from code: the API connects with a role without the
-- CREATE privilege (which is what makes row security effective). Applied by `pnpm db:migrate`,
-- by `kitsuden kon add`, or by the panel when the kon is switched on.
--
-- A migration that was applied is history: to change a table, add 0001_<what>.sql.

CREATE TABLE IF NOT EXISTS dc_guilds (
  id          varchar(20) PRIMARY KEY CHECK (id ~ '^[0-9]{15,20}$'),
  name        varchar(100) NOT NULL,
  left_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dc_blueprints (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         varchar(100) NOT NULL,
  description  text,
  definition   jsonb NOT NULL,
  status       varchar(20) NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'published')),
  revision     integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dc_blueprints_status_idx
  ON dc_blueprints (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS dc_guild_modules (
  guild_id    varchar(20) NOT NULL REFERENCES dc_guilds (id) ON DELETE CASCADE,
  module_id   varchar(60) NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, module_id)
);

-- The gateway worker asks "which modules are on anywhere?" to choose its intents.
CREATE INDEX IF NOT EXISTS dc_guild_modules_enabled_idx
  ON dc_guild_modules (module_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS dc_kv (
  guild_id    varchar(20) NOT NULL REFERENCES dc_guilds (id) ON DELETE CASCADE,
  namespace   varchar(60) NOT NULL,
  key         varchar(120) NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, namespace, key)
);

-- Live panels: messages the bot posted and keeps redrawing. The message id is the one Discord gave.
CREATE TABLE IF NOT EXISTS dc_panels (
  message_id    varchar(20) PRIMARY KEY CHECK (message_id ~ '^[0-9]{15,20}$'),
  guild_id      varchar(20) NOT NULL REFERENCES dc_guilds (id) ON DELETE CASCADE,
  channel_id    varchar(20) NOT NULL,
  module_id     varchar(60) NOT NULL,
  panel_id      varchar(32) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  refreshed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS dc_panels_module_idx ON dc_panels (guild_id, module_id, panel_id);

-- Row security, with the core's helpers (agent-functions.sql), so the database says the same as
-- dc.policy.ts even if a query forgets a filter. Nothing here is public: the team (admin,
-- editor), the system, and an agent with `dc-bot:view` (read) or `dc-bot:update`
-- (write), or the whole kon (`dc:*`, `kon:dc:*`).
--
-- Discord itself (interactions) and the gateway worker never reach these tables with their own
-- identity: the route authorizes them first (a valid signature, the worker's fine scope) and then
-- works as the system.
SELECT kitsuden_rls_team('dc_guilds', 'dc', 'dc-bot:view', 'dc-bot:update');
SELECT kitsuden_rls_team('dc_blueprints', 'dc', 'dc-bot:view', 'dc-bot:update');
SELECT kitsuden_rls_team('dc_guild_modules', 'dc', 'dc-bot:view', 'dc-bot:update');
SELECT kitsuden_rls_team('dc_kv', 'dc', 'dc-bot:view', 'dc-bot:update');
SELECT kitsuden_rls_team('dc_panels', 'dc', 'dc-bot:view', 'dc-bot:update');
