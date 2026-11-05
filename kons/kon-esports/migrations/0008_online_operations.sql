-- 0008 — Running community ONLINE tournaments
-- ============================================================================
--
-- Everything before assumed a venue: the TO sees people, calls out the next
-- set, and whoever does not show up is visibly not there.
--
-- Online there is no venue. The TO sees nobody, nobody is watching the site,
-- and the only place the community really is, is Discord. That moves three
-- things:
--
--   · **Notifying stops being a courtesy and becomes the critical path.** A
--     set nobody knows exists does not get played.
--   · **The stream IS the venue.** What in person is "the main table", online
--     is the channel where the match is watched.
--   · **A team is not formed in person.** It takes invitations that someone
--     accepts, or on tournament day empty rosters show up.

-- ── Notification outbox ─────────────────────────────────────────────────────
--
-- It is a TABLE and not a direct call to Discord, and that is the decision
-- that holds everything else up:
--
--   1. The row is written in the SAME transaction as the event that causes it.
--      With an HTTP call, a failure between "advance the bracket" and "notify"
--      loses the notification forever, and nobody notices until two people
--      have spent twenty minutes waiting for a set that was already ready.
--   2. The bot POLLS and acknowledges. A community bot restarts, gets
--      redeployed and loses its network; with webhooks, everything that
--      happens while it is down is lost. With an outbox, it finds it on return.
--   3. Discord rate-limits. The one setting the pace has to be the bot.

CREATE TABLE IF NOT EXISTS esports_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tournament_id UUID NOT NULL REFERENCES esports_tournaments(id) ON DELETE CASCADE,
  -- Who it goes to. NULL = announcement for the whole tournament (check-in
  -- opens, etc.).
  participant_id UUID REFERENCES esports_tournament_participants(id) ON DELETE CASCADE,

  type VARCHAR(40) NOT NULL,

  /*
   * Deduplication key.
   *
   * The bot retries, the TO clicks again, and the same event must not send
   * two DMs. It is built from the EVENT, not the moment:
   * `match.ready:<matchId>:<participantId>`.
   */
  dedupe_key VARCHAR(160) NOT NULL,

  /*
   * Everything needed to write the message, ALREADY RESOLVED.
   *
   * A bot that has to make five more calls to learn the opponent's name is a
   * bot that falls over halfway and sends messages without names. Names are
   * copied here at write time: that way, too, the notification says what was
   * true when it happened, even if someone renames later.
   */
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = pending. It is the only status needed.
  delivered_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_unique
  ON esports_notifications (dedupe_key);

-- The bot's query, and the only one that runs often: "what is left to send".
-- Partial over pending rows: delivered rows grow without limit and are never
-- queried.
CREATE INDEX IF NOT EXISTS notifications_pending_idx
  ON esports_notifications (tournament_id, created_at)
  WHERE delivered_at IS NULL;

-- ── Teams: captain, invitations and acceptance ──────────────────────────────
--
-- A team is NOT a name with people written next to it. It is people who have
-- said yes. Without acceptance, anyone registers whoever they like and on
-- tournament day half the rosters do not know they are playing.

ALTER TABLE esports_teams ADD COLUMN IF NOT EXISTS created_by_user_id TEXT;

CREATE TABLE IF NOT EXISTS esports_team_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  team_id UUID NOT NULL REFERENCES esports_teams(id) ON DELETE CASCADE,

  /*
   * Who is invited. One of the two, not both:
   *   · `invited_user_id` — already has an account; it shows in their panel.
   *   · `invited_handle`  — their Discord; they get the link and sign up later.
   *
   * Without the second form, inviting would require the person to ALREADY
   * have registered, which is exactly the reverse of what happens in a
   * community.
   */
  invited_user_id TEXT,
  invited_handle VARCHAR(120),

  /*
   * Invitation link token. Random and unique: it is the credential that
   * travels over Discord, so it must be neither guessable nor reusable.
   */
  token VARCHAR(64) NOT NULL,

  role VARCHAR(20) NOT NULL DEFAULT 'player',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',

  invited_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  -- An expiring invitation stops a year-old link from putting someone into a
  -- team they no longer recognise.
  expires_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS team_invites_token_unique
  ON esports_team_invites (token);

-- One PENDING invitation per person and team. Without the status filter,
-- declining and inviting again would be impossible.
CREATE UNIQUE INDEX IF NOT EXISTS team_invites_pending_user
  ON esports_team_invites (team_id, invited_user_id)
  WHERE invited_user_id IS NOT NULL AND status = 'pending';

CREATE INDEX IF NOT EXISTS team_invites_team_idx ON esports_team_invites (team_id, status);

-- Role within the team. `esports_players_to_teams` already stores who is in;
-- what was missing is in what capacity — a substitute does not count towards
-- the minimum roster, and without telling them apart a team of 3 with 2
-- substitutes looks complete.
ALTER TABLE esports_players_to_teams ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'player';
ALTER TABLE esports_players_to_teams ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ DEFAULT now();

-- The tournament's minimum and maximum roster size. A 5v5 with teams of 3
-- cannot be played, and finding out when generating the bracket is too late.
ALTER TABLE esports_tournaments ADD COLUMN IF NOT EXISTS min_roster_size INTEGER;
ALTER TABLE esports_tournaments ADD COLUMN IF NOT EXISTS max_roster_size INTEGER;

-- ── Where it is played ──────────────────────────────────────────────────────
--
-- In person it is a setup with a number: "your set is on 12".
-- Online it is a room code, a lobby or a server.
--
-- It is THE SAME field —"where the two of you go"— so it is the same table
-- with a `kind`. Splitting them would have duplicated the assignment, the
-- free/busy status and the notification, only to end up diverging.

CREATE TABLE IF NOT EXISTS esports_stations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES esports_tournaments(id) ON DELETE CASCADE,

  name VARCHAR(60) NOT NULL,
  -- `physical` = a setup at a venue. `lobby` = an in-game room.
  kind VARCHAR(20) NOT NULL DEFAULT 'physical',

  /*
   * The room code or password, when there is one.
   *
   * It is given ONLY to those playing that set and to the organisers:
   * publishing it invites anyone to join and wreck the match, which is the
   * classic problem of online tournaments.
   */
  access_details TEXT,

  status VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stations_tournament_idx ON esports_stations (tournament_id, status);

ALTER TABLE esports_matches ADD COLUMN IF NOT EXISTS station_id UUID;

-- ── Stream ──────────────────────────────────────────────────────────────────
--
-- Online, the stream is not an extra: it is the venue. It is where the
-- community watches the tournament together, and that is why it is stored as
-- part of the tournament and not as a loose link in the description.

CREATE TABLE IF NOT EXISTS esports_streams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES esports_tournaments(id) ON DELETE CASCADE,

  -- `twitch` | `youtube` | `kick`. Determines how the embed is built.
  platform VARCHAR(20) NOT NULL,
  -- The channel, NOT the full URL: the URL is built, and storing a hand-pasted
  -- one ends up with links to a specific video that is gone tomorrow.
  channel VARCHAR(120) NOT NULL,
  title VARCHAR(160),

  /*
   * Who can watch the stream from the site: `public` or `registered`.
   *
   * **`public` by default**: the stream is the tournament's shop window, and
   * requiring an account to watch it shuts the door on exactly those who are
   * not part of the community yet. `registered` is there for whoever wants it
   * on purpose.
   *
   * And mind what this field can do: it blocks Kitsuden's page and embed, but
   * the Twitch channel is still public ON Twitch. It is a door, not a lock.
   */
  viewer_access VARCHAR(20) NOT NULL DEFAULT 'public',

  -- The tournament's main channel. The others are secondary stages.
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS streams_tournament_idx ON esports_streams (tournament_id);

-- ── Broadcast queue ─────────────────────────────────────────────────────────
--
-- Which sets go on camera and in what order. It is what the production team
-- needs to know and what viewers want to see announced.
--
-- The position lives on the SET and not in a separate table because a set is
-- in one queue or none, and a join table for a 1-to-1 relationship only adds
-- a way for them to fall out of sync.

ALTER TABLE esports_matches ADD COLUMN IF NOT EXISTS stream_id UUID;
ALTER TABLE esports_matches ADD COLUMN IF NOT EXISTS stream_queue_position INTEGER;

CREATE INDEX IF NOT EXISTS matches_stream_queue_idx
  ON esports_matches (stream_id, stream_queue_position)
  WHERE stream_queue_position IS NOT NULL;
