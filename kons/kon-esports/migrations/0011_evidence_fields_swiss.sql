-- 0011 — Evidence in disputes, registration fields and Swiss
-- ============================================================================
--
-- The three things Battlefy does that were missing here, all three for the
-- same reason: its product is ONLINE, and online the TO cannot look.

-- ── 1. Evidence ─────────────────────────────────────────────────────────────
--
-- The most practical gap left. The disputes screen shows two contradictory
-- versions and NOTHING ELSE. In person the TO walks to the table and sees it;
-- online they have no way to know who is telling the truth, so they end up
-- deciding by who wrote first or wrote better.
--
-- Evidence hangs off the REPORT and not the set, and that matters: each side
-- brings its own. Hanging it off the set would lose who submitted what, which
-- is exactly what needs comparing.

CREATE TABLE IF NOT EXISTS esports_report_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  report_id UUID NOT NULL REFERENCES esports_match_reports(id) ON DELETE CASCADE,

  /*
   * Two forms, kept apart on purpose:
   *
   *   · `media_id`  — uploaded through kon-media. It is OURS: it cannot be
   *     changed afterwards, it does not leak the IP of whoever views it, and
   *     it is still there in three months.
   *   · `url`       — pasted by the player (imgur, gyazo). It is what people
   *     really do, so it is accepted, but it is THIRD-PARTY CONTENT: it can
   *     change, expire, or log whoever opens it.
   *
   * Storing both in the same field would have erased that difference, and
   * with it the only hint the TO has about how far to trust it.
   */
  media_id UUID,
  url TEXT,

  /* Whatever the player wants to explain about the screenshot. */
  caption VARCHAR(300),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A piece of evidence is one or the other, never neither and never both.
  CONSTRAINT evidence_one_source CHECK (
    (media_id IS NOT NULL AND url IS NULL) OR (media_id IS NULL AND url IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS report_evidence_report_idx
  ON esports_report_evidence (report_id);

-- The TO can REQUIRE a screenshot. Battlefy has it, and it is what turns
-- "I think I won" into something that can be resolved without knowing anyone.
ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS requires_evidence BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Registration fields ──────────────────────────────────────────────────
--
-- Online the TO cannot ask in person: they need the Riot ID, the region, the
-- decklist or the PayPal email BEFOREHAND, or they spend the tournament
-- chasing people in DMs.
--
-- The DEFINITION goes on the tournament and the ANSWERS on the participant. In
-- jsonb and not in tables because this is data only that tournament
-- understands: normalising it would force a per-field values table that
-- nobody ever queries.

ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE esports_tournament_participants
  ADD COLUMN IF NOT EXISTS custom_data JSONB NOT NULL DEFAULT '{}'::jsonb;

-- CAREFUL: each field declares its visibility. An `organizer` field (the
-- PayPal, the phone number) must NOT appear in the public list of registrants,
-- and that is why the filtering lives in a single router function. See
-- `publicParticipant`.

-- ── 3. Swiss ────────────────────────────────────────────────────────────────
--
-- The missing format, and the one used most online: everyone plays ALL the
-- rounds, nobody goes home after two matches, and log2(n) rounds produce a
-- reliable standing without playing a full round robin.
--
-- It is the format of Magic, Pokémon and Hearthstone — the same people
-- kon-cardsim and kon-tierlist already exist for.

DO $$
BEGIN
  ALTER TYPE esports_bracket_format ADD VALUE IF NOT EXISTS 'swiss';
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;

-- How many rounds. Stored instead of computed on every query because it is an
-- ANNOUNCED decision: "it is 5 rounds" appears in the tournament rules, and it
-- cannot change by itself because three more people sign up.
ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS swiss_rounds INTEGER;

-- Whoever drops KEEPS their record (see the engine): their opponents must not
-- lose tiebreakers because someone they beat left. This mark is what sets it
-- apart from being eliminated.
ALTER TABLE esports_tournament_participants
  ADD COLUMN IF NOT EXISTS dropped_at TIMESTAMPTZ;
