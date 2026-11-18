-- kon-dc — a server's plan: premium unlocks the modules the installation marks as premium
-- ============================================================================
-- Written by the team, an agent, or another kon that sells it (a shop calling PUT
-- /api/dc/guilds/:guildId/plan with its own key). `until` NULL = no end.

CREATE TABLE IF NOT EXISTS dc_guild_plans (
  guild_id    varchar(20) PRIMARY KEY REFERENCES dc_guilds (id) ON DELETE CASCADE,
  plan        varchar(20) NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'premium')),
  until       timestamptz,
  source      varchar(100),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

SELECT kitsuden_rls_team('dc_guild_plans', 'dc', 'dc-bot:view', 'dc-bot:update');
