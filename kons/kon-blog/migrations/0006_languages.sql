-- ════════════════════════════════════════════════════════════════════════════
-- Posts in several languages
-- ════════════════════════════════════════════════════════════════════════════
--
-- One ROW per language, tied together by `translation_group_id`. It is the
-- YouTube model: one post with several versions, and everyone reads their own.
--
-- `es` by default for what already exists: everything published until today
-- is in Spanish, and leaving the column null would force a check in every query.
--
-- The group stays NULL on purpose. Null means "this post has no
-- translations", and queries resolve it with
-- `coalesce(translation_group_id, id)`: each standalone post is its own
-- group, with nothing to fill in when publishing.

ALTER TABLE blog_posts
  ADD COLUMN IF NOT EXISTS locale varchar(5) NOT NULL DEFAULT 'es',
  ADD COLUMN IF NOT EXISTS translation_group_id uuid;

-- The front page query: "the latest published in this language"
CREATE INDEX IF NOT EXISTS blog_posts_idioma_idx
  ON blog_posts (locale, status, published_at DESC);

-- And the post page query: "which other languages is this in?"
CREATE INDEX IF NOT EXISTS blog_posts_grupo_idx
  ON blog_posts (translation_group_id)
  WHERE translation_group_id IS NOT NULL;

-- Two versions of the SAME group in the SAME language make no sense: they are
-- the same post twice, and which of the two gets shown would be down to luck.
-- Partial index because standalone posts (null group) may share a language:
-- they are different posts, not versions.
CREATE UNIQUE INDEX IF NOT EXISTS blog_posts_grupo_idioma_idx
  ON blog_posts (translation_group_id, locale)
  WHERE translation_group_id IS NOT NULL;
