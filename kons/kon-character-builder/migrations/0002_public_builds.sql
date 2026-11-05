-- 0002 — Published builds: gallery by subject and votes
-- Idempotent.
--
-- Saving a build was already possible; SHOWING it was not. Three things were
-- missing for a published build to be of any use to someone who did not make it:
--
--   · `subject` — who the build is for. The gallery is read by subject ("all
--     the Infergon builds"), and without a column we would have to look inside
--     the JSON of every row on every visit.
--   · `votes` — the summary of the votes table, because the list is SORTED by
--     votes and counting rows to sort does not scale. The table stays the source of truth.
--   · `published_at` — when it was made public, which is not when it was created:
--     a build can stay private for months before going out.
--
-- A vote is ONE per person and build: the primary key is the pair. Without a
-- session there is no voting, or anyone could raise the counter by reloading.
ALTER TABLE builder_builds ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE builder_builds ADD COLUMN IF NOT EXISTS votes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE builder_builds ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- The index covers the gallery query: builder + subject, most voted
-- first. Partial, because only public builds are listed.
CREATE INDEX IF NOT EXISTS builder_builds_publicas_idx
  ON builder_builds (builder_id, subject, votes DESC, published_at DESC)
  WHERE visibility = 'public';

CREATE TABLE IF NOT EXISTS builder_build_votes (
  build_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (build_id, voter_id)
);

CREATE INDEX IF NOT EXISTS builder_build_votes_build_idx ON builder_build_votes (build_id);
