-- kon-dc — recent message text, kept for a few hours so logs can say what was deleted or edited
-- ============================================================================
-- Opt-in per server (the Logs module's "keep messages" setting, at most 7 days) and pruned by the
-- engine when `expires_at` passes. Nothing else reads it.

CREATE TABLE IF NOT EXISTS dc_message_cache (
  message_id   varchar(20) PRIMARY KEY CHECK (message_id ~ '^[0-9]{15,20}$'),
  guild_id     varchar(20) NOT NULL REFERENCES dc_guilds (id) ON DELETE CASCADE,
  channel_id   varchar(20) NOT NULL,
  author_id    varchar(20) NOT NULL,
  content      varchar(4000) NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS dc_message_cache_expires_idx ON dc_message_cache (expires_at);

SELECT kitsuden_rls_team('dc_message_cache', 'dc', 'dc-bot:view', 'dc-bot:update');
