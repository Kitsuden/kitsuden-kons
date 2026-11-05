-- Academy: the missing columns that reference kon-media
-- ============================================================================
--
-- `academy-lms.schema.ts` declares six columns that point to kon-media
-- (course covers, topic image and document, quiz image, question attachment,
-- learning path image) and `0000_initial.sql` creates none of them.
--
-- This is silent drift: the table exists, so startup does not complain and no
-- query fails until one asks for that column. Then Postgres answers
-- `column "media_id" does not exist` and the 500 shows up on screen, not at
-- deploy time.
--
-- The startup schema checker caught it after it was extended to the active
-- kons; before that it only looked at the core tables and took the schema as
-- correct.
--
-- `text` and not `uuid` with a foreign key: that is what the schema declares,
-- and on purpose: kon-media is optional, and an FK would force installing it
-- just to create a course.

ALTER TABLE cursos          ADD COLUMN IF NOT EXISTS media_id      text;
ALTER TABLE temas           ADD COLUMN IF NOT EXISTS imagen_id     text;
ALTER TABLE temas           ADD COLUMN IF NOT EXISTS documento_id  text;
ALTER TABLE quizzes         ADD COLUMN IF NOT EXISTS media_id      text;
ALTER TABLE preguntas       ADD COLUMN IF NOT EXISTS archivo_id    text;
ALTER TABLE learning_paths  ADD COLUMN IF NOT EXISTS media_id      text;
