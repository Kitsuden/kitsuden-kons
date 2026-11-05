-- 0004 — An article's comment thread can be closed
-- ============================================================================
-- Idempotent.
--
-- `kon-comments` is polymorphic and cannot know what "closed" means for each
-- commentable thing, so the decision lives where the article lives.
--
-- OPEN by default: existing posts do not change behavior when this is applied,
-- and closing is the deliberate act.
ALTER TABLE blog_posts
  ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT true;
