-- 0013 — The invitation binds ONE player to whoever accepts it (audit 2026-10-25)
-- ============================================================================
-- `aliasOwnership` treated as "yours" any player of the team you were invited
-- to, so an invitee could register for tournaments under the captain's alias.
-- Now only the player the invitation was accepted with (`accepted_player_id`).
-- Invitations already accepted are left without it: their owner keeps the
-- alias through their registrations (the `byRegistration` branch).
ALTER TABLE esports_team_invites ADD COLUMN IF NOT EXISTS accepted_player_id uuid;
