-- 0004 — Ownerless decks, in the database (2026-10-23)
-- ============================================================================
-- Idempotent: DROP POLICY IF EXISTS before each CREATE.
--
-- `cardsim_decks` is isolated by owner (`cardsim_decks_owner_isolation`, in
-- rls-owned-tables.sql). But the kon lets people build decks WITHOUT a session:
-- they are saved with `owner_id` NULL and belong to whoever has the id (the
-- routes treat them as public: `deck.ownerId && ...` only protects owned ones).
--
-- While kon routes ran without an RLS context, that worked by accident (no
-- context = system). With the per-request RLS transaction, an anonymous user
-- could not even save their deck: `owner_id = ''` does not match NULL and the
-- INSERT failed the policy check.
--
-- Decks WITH an owner are not opened up: the share link (`?share=`) is checked
-- by the route, which only then reads the deck as the system.

DO $$
BEGIN
  IF to_regclass('public.cardsim_decks') IS NOT NULL THEN
    DROP POLICY IF EXISTS cardsim_decks_sin_dueno ON cardsim_decks;
    CREATE POLICY cardsim_decks_sin_dueno ON cardsim_decks
      FOR ALL TO PUBLIC
      USING (owner_id IS NULL)
      WITH CHECK (owner_id IS NULL);
  END IF;
END $$;
