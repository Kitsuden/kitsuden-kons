-- 0013 — Bring your own card images (2026-11-20)
-- ============================================================================
-- Idempotent: every step checks first, so it runs on a fresh chain and twice.
--
-- 1. `cardsim_games.image_mode`: `hosted` (responses carry `imageUrl`, as before) or `byod`
--    (no response names an image; each player brings their own in the browser). Existing games
--    stay `hosted`: nothing changes until someone switches a game.
--
-- 2. `cardsim_image_prefs`: where a person's images come from, per game — the order of their
--    sources and the links they typed. Never an image, a path or a file. PERSONAL: it says which
--    sites someone reads, so it is isolated by owner here, with the same template as the core's
--    `rls-owned-tables.sql` (system hatch only with an EMPTY role, so an anonymous request with
--    RLS context sees nothing).

ALTER TABLE cardsim_games ADD COLUMN IF NOT EXISTS image_mode text NOT NULL DEFAULT 'hosted';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cardsim_games_image_mode_check'
  ) THEN
    ALTER TABLE cardsim_games
      ADD CONSTRAINT cardsim_games_image_mode_check CHECK (image_mode IN ('hosted', 'byod'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS cardsim_image_prefs (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  game_key text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The same shape the API validates; the database refuses anything bigger than the API allows.
  CONSTRAINT cardsim_image_prefs_game_key_check CHECK (game_key ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  CONSTRAINT cardsim_image_prefs_sources_check CHECK (
    jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 20
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS cardsim_image_prefs_owner_game_idx
  ON cardsim_image_prefs (owner_id, game_key);

ALTER TABLE cardsim_image_prefs ENABLE ROW LEVEL SECURITY;
-- Without FORCE the table owner (the app's role) is exempt and the policy filters nothing.
ALTER TABLE cardsim_image_prefs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cardsim_image_prefs_owner_isolation ON cardsim_image_prefs;
CREATE POLICY cardsim_image_prefs_owner_isolation ON cardsim_image_prefs
  FOR ALL
  TO PUBLIC
  USING (
    ((current_setting('app.current_user_id', true) = ''
      OR current_setting('app.current_user_id', true) IS NULL)
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) = 'admin'
    OR owner_id = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    ((current_setting('app.current_user_id', true) = ''
      OR current_setting('app.current_user_id', true) IS NULL)
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) = 'admin'
    OR owner_id = current_setting('app.current_user_id', true)
  );
