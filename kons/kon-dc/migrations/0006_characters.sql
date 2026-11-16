-- kon-dc — characters: names and avatars members speak through (proxied by a webhook)
-- ============================================================================
-- A member's own, the same in every server of this bot (like their profile).

CREATE TABLE IF NOT EXISTS dc_characters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     varchar(20) NOT NULL CHECK (user_id ~ '^[0-9]{15,20}$'),
  name        varchar(80) NOT NULL,
  -- What marks a message as theirs: `k:` before it, `]` after it, or both.
  prefix      varchar(20) NOT NULL DEFAULT '',
  suffix      varchar(20) NOT NULL DEFAULT '',
  avatar_url  varchar(500),
  messages    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (prefix <> '' OR suffix <> ''),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS dc_characters_user_idx ON dc_characters (user_id);

SELECT kitsuden_rls_team('dc_characters', 'dc', 'dc-bot:view', 'dc-bot:update');
