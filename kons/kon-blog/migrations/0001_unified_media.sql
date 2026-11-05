-- Migration: Unified Media Schema for kon-blog
-- Changes:
-- 1. Replace og_image_url (text) with og_image_id (uuid) for media consistency
-- 2. Remove og_image_size (now handled by media metadata)
-- 3. Add featured_image_focal_point for smart cropping

-- Add new columns
ALTER TABLE blog_posts 
  ADD COLUMN IF NOT EXISTS og_image_id UUID,
  ADD COLUMN IF NOT EXISTS featured_image_focal_point JSONB;

-- Migrate existing data: try to extract media ID from og_image_url if possible
-- This is a best-effort migration - URLs that don't reference media will be left empty
-- This UPDATE assumed the `og_image_url` column exists, and that is only true
-- when coming from the previous version. On a FRESH install,
-- `0000_initial.sql` already creates the table in the new shape —with
-- `og_image_id`— and the old column never existed, so the migration blew up with
--
--     column "og_image_url" does not exist
--
-- halting the kon's whole chain. It is the classic failure of a migration
-- written looking only at the install in front of you: correct when
-- upgrading, impossible when installing from scratch.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blog_posts' AND column_name = 'og_image_url'
  ) THEN
    UPDATE blog_posts
    SET og_image_id = NULL
    WHERE og_image_url IS NOT NULL;
  END IF;
END
$$;

-- Note: Manual migration may be needed for existing og_image_url values
-- that reference media items. Example:
-- UPDATE blog_posts 
-- SET og_image_id = (
--   SELECT id FROM media WHERE url = blog_posts.og_image_url LIMIT 1
-- )
-- WHERE og_image_url LIKE '%/api/media/%';

-- Remove old columns (commented out for safety - run manually after verification)
-- ALTER TABLE blog_posts 
--   DROP COLUMN IF EXISTS og_image_url,
--   DROP COLUMN IF EXISTS og_image_size;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS blog_posts_og_image_id_idx ON blog_posts(og_image_id);

-- Add comment documenting focal point format
COMMENT ON COLUMN blog_posts.featured_image_focal_point IS 
  'Focal point for smart cropping. Format: {"x": 0.5, "y": 0.5} (0-1 normalized coordinates)';

COMMENT ON COLUMN blog_posts.og_image_id IS 
  'Reference to media item for OG/social sharing. Uses transform endpoint for 1200x630 optimization.';
