-- kon-dc — activity per member and day: messages written and minutes in voice
-- ============================================================================
-- What weekly or monthly leaderboards and /stats read. Only counts: never message text.

CREATE TABLE IF NOT EXISTS dc_activity (
  guild_id       varchar(20) NOT NULL REFERENCES dc_guilds (id) ON DELETE CASCADE,
  user_id        varchar(20) NOT NULL CHECK (user_id ~ '^[0-9]{15,20}$'),
  -- Days since 1970-01-01, UTC.
  day            integer NOT NULL,
  messages       integer NOT NULL DEFAULT 0 CHECK (messages >= 0),
  voice_minutes  integer NOT NULL DEFAULT 0 CHECK (voice_minutes >= 0),
  PRIMARY KEY (guild_id, user_id, day)
);

CREATE INDEX IF NOT EXISTS dc_activity_day_idx ON dc_activity (guild_id, day);

SELECT kitsuden_rls_team('dc_activity', 'dc', 'dc-bot:view', 'dc-bot:update');
