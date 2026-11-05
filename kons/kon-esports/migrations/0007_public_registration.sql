-- 0007 — Public registration and result reports
-- ============================================================================
--
-- The two pieces that separate a bracket engine from a tournament platform:
-- people signing themselves up, and people reporting their own sets.
--
-- Without the first, the TO types in 128 people. Without the second, the TO
-- clicks 254 times while people wait. Either one, on its own, is reason
-- enough to stay on start.gg.

-- ── Registration window ─────────────────────────────────────────────────────
--
-- `closed` by default, and on purpose: turning on public registration is a
-- decision, not something that happens to a tournament just by existing.
-- Tournaments already created stay exactly as they were before this migration.

ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS registration_mode VARCHAR(20) NOT NULL DEFAULT 'closed';
ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS registration_opens_at TIMESTAMPTZ;
ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS registration_closes_at TIMESTAMPTZ;

-- The waitlist is switched on separately from the window: an in-person
-- tournament with 16 setups does NOT want a waitlist (nobody else fits), and
-- an online one does.
ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS waitlist_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE esports_tournaments ADD COLUMN IF NOT EXISTS rules_text TEXT;
ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS requires_rules_acceptance BOOLEAN NOT NULL DEFAULT false;

-- Minutes an unconfirmed report waits for the opponent before it can be
-- accepted. 0 = never; someone always signs it off. It belongs to the TO and
-- not the player: without this deadline, whoever clicks first would decide
-- any set just by waiting a while.
ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS report_grace_minutes INTEGER NOT NULL DEFAULT 0;

-- ── Participants: who signed up and their place in the queue ───────────────

-- Who CLICKED the button. Not the same as the player: a captain registers
-- their team, and the one who can withdraw is whoever signed up, not anyone
-- with that name.
ALTER TABLE esports_tournament_participants
  ADD COLUMN IF NOT EXISTS registered_by_user_id TEXT;

-- Order of ARRIVAL on the waitlist. NULL = actually registered.
--
-- It only grows and is never reused: "you are 3rd in the queue" is computed by
-- counting how many are ahead. Renumbering when someone leaves would rewrite N
-- rows on every withdrawal and, with two withdrawals at once, two concurrent
-- promotions would compute the same gap and leave DUPLICATE positions.
ALTER TABLE esports_tournament_participants
  ADD COLUMN IF NOT EXISTS waitlist_position INTEGER;

ALTER TABLE esports_tournament_participants
  ADD COLUMN IF NOT EXISTS accepted_rules_at TIMESTAMPTZ;

-- Contact handle (Discord, usually). What the TO uses to let someone know their
-- set is ready, and the reason signing in with Discord is worth it.
ALTER TABLE esports_tournament_participants
  ADD COLUMN IF NOT EXISTS contact_handle VARCHAR(120);

-- One account, one registration per tournament. This is what stops the same
-- person from entering three times under three aliases to triple their odds
-- in the draw.
CREATE UNIQUE INDEX IF NOT EXISTS tp_user_unique
  ON esports_tournament_participants (tournament_id, registered_by_user_id)
  WHERE registered_by_user_id IS NOT NULL;

-- The queue's hot query: "this tournament's waitlist, in order of arrival".
CREATE INDEX IF NOT EXISTS tp_waitlist_idx
  ON esports_tournament_participants (tournament_id, waitlist_position)
  WHERE waitlist_position IS NOT NULL;

-- ── Result reports ──────────────────────────────────────────────────────────
--
-- A report is NOT a result: it is the statement of ONE of the sides. It becomes
-- a result when it agrees with the other side, or when the TO signs it off.
-- That is why it lives in its own table instead of writing the set's winner
-- directly: if that distinction is lost, whoever clicks first decides the set.
--
-- And that is why reports are NOT overwritten: the history is the evidence
-- when there is a dispute. "I reported correctly" is checked by looking here.

CREATE TABLE IF NOT EXISTS esports_match_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  match_id UUID NOT NULL REFERENCES esports_matches(id) ON DELETE CASCADE,

  -- Who sends it, as a tournament PARTICIPANT and not as a user: that is what
  -- lets us check they play that set without resolving identities every time.
  reported_by UUID NOT NULL
    REFERENCES esports_tournament_participants(id) ON DELETE CASCADE,

  winner_id UUID NOT NULL
    REFERENCES esports_tournament_participants(id) ON DELETE CASCADE,

  -- Always in the set's [participant 1, participant 2] order. Storing them
  -- "reporter first" would force knowing who reported in order to read them.
  score_1 INTEGER,
  score_2 INTEGER,

  -- `true` if the organisers signed it off instead of a player. What tells
  -- "both agreed" apart from "the TO decided" in a dispute.
  by_staff BOOLEAN NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The usual query: this set's reports, most recent first.
CREATE INDEX IF NOT EXISTS match_reports_match_idx
  ON esports_match_reports (match_id, created_at DESC);
