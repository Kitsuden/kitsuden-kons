-- 0012 — Scene matches: those of OTHER teams
-- ============================================================================
--
-- `esports_matches` are the sets of one of OUR tournaments: they hang off a
-- bracket, have a round, and their participants are registered here. What the
-- esports blog shows is something else —"G2 plays Fnatic today"—: there is no
-- bracket, no registration, and those teams do not exist in our database.
--
-- Putting them in the same table would have meant inventing a tournament and
-- two participants for every LEC match. They live apart, and that is why this
-- table DOES have a TIME: it is the first thing anyone looks at in a match
-- calendar, and exactly what `esports_matches` cannot give (it only has round
-- and order).

CREATE TABLE IF NOT EXISTS esports_pro_matches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The game from our catalogue, if we have it; otherwise the name is enough.
  game_id       uuid,
  game_name     varchar(120) NOT NULL,
  event         varchar(200),

  team_one      varchar(160) NOT NULL,
  team_two      varchar(160) NOT NULL,
  -- Logos LINKED to their source: nobody's images are copied here.
  logo_one      text,
  logo_two      text,

  scheduled_at  timestamptz,
  status        varchar(20) NOT NULL DEFAULT 'scheduled',
  score_one     integer,
  score_two     integer,
  best_of       integer,

  stream_url    text,

  -- Where the row came from. Empty = a person wrote it in the panel.
  source        varchar(60),
  external_id   varchar(120),
  external_url  text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Re-importing UPDATES instead of duplicating. Partial on purpose: rows written
-- by hand carry no `external_id` and must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS esports_pro_matches_fuente_idx
  ON esports_pro_matches (source, external_id)
  WHERE external_id IS NOT NULL;

-- The blog panel's query: "what is coming up", by time.
CREATE INDEX IF NOT EXISTS esports_pro_matches_agenda_idx
  ON esports_pro_matches (status, scheduled_at);
