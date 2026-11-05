-- 0008 — The satisfaction survey's last Spanish columns, in English
-- ============================================================================
-- Idempotent: each column is renamed only if it still has its old name.
--
--   expositor     → presenter        (the presenter's rating, 1-5)
--   recomendacion → recommendation   (free text, up to 200 characters)
--
-- The API takes and returns the new names (`presenter`, `recommendation`); the stats field
-- `averageExhibitor` is now `averagePresenter`.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'satisfaction_surveys' AND column_name = 'expositor')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'satisfaction_surveys' AND column_name = 'presenter') THEN
    ALTER TABLE satisfaction_surveys RENAME COLUMN expositor TO presenter;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'satisfaction_surveys' AND column_name = 'recomendacion')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'satisfaction_surveys' AND column_name = 'recommendation') THEN
    ALTER TABLE satisfaction_surveys RENAME COLUMN recomendacion TO recommendation;
  END IF;
END $$;
