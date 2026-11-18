-- kon-dc — who is in which voice channel, and since when
-- ============================================================================
-- One row per member in voice (the gateway's VOICE_STATE_UPDATE keeps it): voice XP is paid from
-- `credited_at`, temporary channels are deleted when no row points at them any more.

CREATE TABLE IF NOT EXISTS dc_voice_sessions (
  guild_id     varchar(20) NOT NULL REFERENCES dc_guilds (id) ON DELETE CASCADE,
  user_id      varchar(20) NOT NULL CHECK (user_id ~ '^[0-9]{15,20}$'),
  channel_id   varchar(20) NOT NULL CHECK (channel_id ~ '^[0-9]{15,20}$'),
  -- Muted or deafened (by themself or a moderator): no voice XP while so.
  muted        boolean NOT NULL DEFAULT false,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  credited_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS dc_voice_sessions_channel_idx ON dc_voice_sessions (guild_id, channel_id);

SELECT kitsuden_rls_team('dc_voice_sessions', 'dc', 'dc-bot:view', 'dc-bot:update');
