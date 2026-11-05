-- RLS for kon-cardsim after the English rename: functions, triggers and policies come back with the new names.
--
-- The previous file dropped the old ones; between both files the tables stay closed, not open.

-- Policies, with the new names and the core's English helpers.
DROP POLICY IF EXISTS cardsim_decks_sin_owner ON cardsim_decks;
DROP POLICY IF EXISTS cardsim_decks_ownerless ON cardsim_decks;
CREATE POLICY cardsim_decks_ownerless ON cardsim_decks AS PERMISSIVE FOR ALL USING ((owner_id IS NULL)) WITH CHECK ((owner_id IS NULL));
