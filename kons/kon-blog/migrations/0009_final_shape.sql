-- kon-blog: what the core used to add on top of the kon's own CREATE TABLE
-- ============================================================================
--
-- `0000_initial.sql` creates the tables, but search, the `blocks` default and the foreign keys came
-- from core migrations. A fresh core no longer creates or alters these tables, so the kon does.
-- A no-op on a database that already has them.

ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS search_vector tsvector;
ALTER TABLE blog_posts ALTER COLUMN blocks SET DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS blog_posts_blocks_gin ON blog_posts USING gin (blocks);
CREATE INDEX IF NOT EXISTS blog_posts_search_idx ON blog_posts USING gin (search_vector);
CREATE UNIQUE INDEX IF NOT EXISTS bg_unique ON blog_posts_to_games USING btree (post_id, game_id);
CREATE UNIQUE INDEX IF NOT EXISTS bt_unique ON blog_posts_to_tags USING btree (post_id, tag_id);

CREATE OR REPLACE FUNCTION blog_posts_search_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.title, '') || ' ' ||
    COALESCE(NEW.excerpt, '') || ' ' ||
    COALESCE(NEW.content::text, '')
  );
  RETURN NEW;
END;
$function$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'blog_posts_search_trigger' AND tgrelid = 'blog_posts'::regclass) THEN
    CREATE TRIGGER blog_posts_search_trigger BEFORE INSERT OR UPDATE ON blog_posts
      FOR EACH ROW EXECUTE FUNCTION blog_posts_search_update();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blog_posts_featured_image_id_media_id_fk') THEN
    ALTER TABLE blog_posts ADD CONSTRAINT blog_posts_featured_image_id_media_id_fk
      FOREIGN KEY (featured_image_id) REFERENCES media(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blog_posts_author_id_auth_users_id_fk') THEN
    ALTER TABLE blog_posts ADD CONSTRAINT blog_posts_author_id_auth_users_id_fk
      FOREIGN KEY (author_id) REFERENCES auth_users(id) ON DELETE SET NULL;
  END IF;

  -- `games` and `tags` are kon-games' tables and its chain runs after this one when it is installed
  -- together with the blog: whichever arrives second makes the link (kon-games/migrations/0000_base_tables.sql).
  IF to_regclass('public.games') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blog_posts_to_games_game_id_games_id_fk') THEN
    ALTER TABLE blog_posts_to_games ADD CONSTRAINT blog_posts_to_games_game_id_games_id_fk
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE;
  END IF;
  IF to_regclass('public.tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blog_posts_to_tags_tag_id_tags_id_fk') THEN
    ALTER TABLE blog_posts_to_tags ADD CONSTRAINT blog_posts_to_tags_tag_id_tags_id_fk
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE;
  END IF;
END $$;
