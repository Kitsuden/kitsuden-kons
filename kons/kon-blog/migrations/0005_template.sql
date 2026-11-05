-- 0005 — Each article picks its template
-- ============================================================================
-- Idempotent.
--
-- `article` is what already existed, so existing posts do not change their
-- look when this is applied. `tips` is the numbered list with a side index,
-- the "12 tips to get started" format.
ALTER TABLE blog_posts
  ADD COLUMN IF NOT EXISTS layout VARCHAR(20) NOT NULL DEFAULT 'article';
