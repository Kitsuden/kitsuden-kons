-- 0010 — Registration without an account (1v1 only)
-- ============================================================================
--
-- Requiring an account to sign up for a community 1v1 is where half the
-- people are lost. Someone arriving from a tweet does not want yet another
-- account: they want to play. An email address is enough.
--
-- Not for TEAMS. There the account is mandatory, and not on a whim: a team
-- needs a captain who answers, invitations that someone accepts and a roster
-- that is still the same next week. None of that holds up on an identity that
-- is created and forgotten in the same afternoon.

-- It can be switched off per tournament. Some communities always want an
-- account — because they keep a yearly ranking, or because they had problems
-- with multiple accounts.
ALTER TABLE esports_tournaments
  ADD COLUMN IF NOT EXISTS allow_guest_registration BOOLEAN NOT NULL DEFAULT true;

-- ── The guest ───────────────────────────────────────────────────────────────

ALTER TABLE esports_tournament_participants
  ADD COLUMN IF NOT EXISTS guest_email VARCHAR(160);

/*
 * HASH of the personal link, never the link itself.
 *
 * Without an account there is no session, so the link IS the credential: it
 * is used to check in, report the set and withdraw the registration. Storing
 * it in plain text would turn a database leak into the ability to report
 * results on everyone's behalf.
 *
 * SHA-256 and not bcrypt: it has to be looked up on every request, so it must
 * be deterministic and indexable. The entropy comes from the token (32 random
 * bytes), not from a password someone picks, and against that a rainbow table
 * is useless.
 *
 * Accepted consequence: resending the link GENERATES A NEW ONE and invalidates
 * the previous one. That is correct — a link that can be sent again is a link
 * that stays alive in the inbox of someone who no longer plays.
 */
ALTER TABLE esports_tournament_participants
  ADD COLUMN IF NOT EXISTS access_token_hash VARCHAR(64);

-- One email, one registration per tournament. The same as the per-account
-- index: without it, the same person signs up five times under five aliases
-- and multiplies their odds in the draw.
--
-- Lower-cased because `Ana@x.com` and `ana@x.com` are the same mailbox, and
-- only someone trying to sneak in would care about the difference.
CREATE UNIQUE INDEX IF NOT EXISTS tp_guest_email_unique
  ON esports_tournament_participants (tournament_id, lower(guest_email))
  WHERE guest_email IS NOT NULL;

-- The query behind every guest request: "whose link is this?".
CREATE INDEX IF NOT EXISTS tp_access_token_idx
  ON esports_tournament_participants (access_token_hash)
  WHERE access_token_hash IS NOT NULL;
