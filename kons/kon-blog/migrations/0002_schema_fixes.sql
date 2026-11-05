-- Migration: Schema fixes for kon-blog
-- Fixes drift between drizzle schema and actual database columns

-- 1. Add missing 'archived' value to blog_status enum
DO $$
BEGIN
  ALTER TYPE blog_status ADD VALUE 'archived';
EXCEPTION WHEN duplicate_object THEN
  -- Value already exists, ignore
END $$;

-- 2. Add missing GEO/SEO columns to blog_posts
ALTER TABLE blog_posts
  ADD COLUMN IF NOT EXISTS bluf_text TEXT,
  ADD COLUMN IF NOT EXISTS faq_data JSONB,
  ADD COLUMN IF NOT EXISTS dataset_url TEXT,
  ADD COLUMN IF NOT EXISTS meta_title VARCHAR(70),
  ADD COLUMN IF NOT EXISTS meta_description VARCHAR(170),
  ADD COLUMN IF NOT EXISTS blocks JSONB;

-- 3. Add index on meta_title for SEO lookups
CREATE INDEX IF NOT EXISTS blog_posts_meta_title_idx ON blog_posts(meta_title);

-- 4. Add index on status + published_at for efficient listing queries
CREATE INDEX IF NOT EXISTS blog_posts_status_published_idx ON blog_posts(status, published_at DESC);
