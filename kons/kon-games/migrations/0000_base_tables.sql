-- kon-games: its tables, in their final shape
-- ============================================================================
--
-- These tables used to come from the core's base migration, and from core alters after it
-- (blocks, search_vector, cover_focal_point). A fresh core no longer creates them, so the kon does.
--
-- It is the first file of the chain and a no-op on a database that already has them:
-- every statement checks first, and later files of this chain still apply on top of it.
--
-- `games_to_streamers` belongs to kon-streamers.

DO $$
BEGIN
  -- Only if it is this kon's table that uses it: `content_status` is also a core type, and without
  -- `games` there is nothing of ours to rename. Once ours exists, 0000_rename_enums.sql does nothing.
  IF to_regclass('public.games') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_type WHERE typname = 'content_status')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'games_content_status') THEN
    ALTER TYPE content_status RENAME TO games_content_status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'games_content_status') THEN
    CREATE TYPE games_content_status AS ENUM ('draft', 'published', 'archived');
  END IF;

  IF to_regclass('public.tags') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tag_category')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'games_tag_category') THEN
    ALTER TYPE tag_category RENAME TO games_tag_category;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'games_tag_category') THEN
    CREATE TYPE games_tag_category AS ENUM ('genre', 'feature', 'topic', 'series');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS games (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title character varying(500) NOT NULL,
    slug character varying(500) NOT NULL,
    subtitle character varying(500),
    description jsonb,
    excerpt text,
    release_date date,
    status games_content_status DEFAULT 'draft' NOT NULL,
    developer character varying(200),
    publisher character varying(200),
    metacritic_score integer,
    user_rating real,
    cover_art_id uuid CONSTRAINT games_cover_art_id_media_id_fk REFERENCES media(id) ON DELETE SET NULL,
    trailer_url text,
    external_ids jsonb,
    specs jsonb,
    screenshots jsonb,
    blocks jsonb DEFAULT '[]'::jsonb,
    is_featured_on_home boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    search_vector tsvector,
    cover_focal_point jsonb
);
COMMENT ON COLUMN games.blocks IS 'Page Builder blocks: array of {id, type, data, order}';

CREATE INDEX IF NOT EXISTS games_blocks_gin ON games USING gin (blocks);
CREATE INDEX IF NOT EXISTS games_metacritic_idx ON games USING btree (metacritic_score);
CREATE INDEX IF NOT EXISTS games_release_idx ON games USING btree (release_date);
CREATE INDEX IF NOT EXISTS games_search_idx ON games USING gin (search_vector);
CREATE UNIQUE INDEX IF NOT EXISTS games_slug_idx ON games USING btree (slug);
CREATE INDEX IF NOT EXISTS games_status_idx ON games USING btree (status);

CREATE OR REPLACE FUNCTION games_search_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.title, '') || ' ' ||
    COALESCE(NEW.description::text, '') || ' ' ||
    COALESCE(NEW.developer, '') || ' ' ||
    COALESCE(NEW.publisher, '')
  );
  RETURN NEW;
END;
$function$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'games_search_trigger' AND tgrelid = 'games'::regclass) THEN
    CREATE TRIGGER games_search_trigger BEFORE INSERT OR UPDATE ON games
      FOR EACH ROW EXECUTE FUNCTION games_search_update();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS platforms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name character varying(100) NOT NULL,
    slug character varying(100) NOT NULL,
    short_name character varying(20),
    manufacturer character varying(100),
    icon_id uuid CONSTRAINT platforms_icon_id_media_id_fk REFERENCES media(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS platforms_slug_idx ON platforms USING btree (slug);

CREATE TABLE IF NOT EXISTS tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name character varying(100) NOT NULL,
    slug character varying(100) NOT NULL,
    color character varying(7),
    category games_tag_category,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_slug_idx ON tags USING btree (slug);

CREATE TABLE IF NOT EXISTS game_collections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title character varying(200) NOT NULL,
    slug character varying(200) NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS gc_slug_idx ON game_collections USING btree (slug);

CREATE TABLE IF NOT EXISTS game_collection_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id uuid NOT NULL CONSTRAINT game_collection_entries_collection_id_game_collections_id_fk REFERENCES game_collections(id) ON DELETE CASCADE,
    game_id uuid NOT NULL CONSTRAINT game_collection_entries_game_id_games_id_fk REFERENCES games(id) ON DELETE CASCADE,
    sort_order integer DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS gce_unique ON game_collection_entries USING btree (collection_id, game_id);

CREATE TABLE IF NOT EXISTS games_to_platforms (
    game_id uuid NOT NULL CONSTRAINT games_to_platforms_game_id_games_id_fk REFERENCES games(id) ON DELETE CASCADE,
    platform_id uuid NOT NULL CONSTRAINT games_to_platforms_platform_id_platforms_id_fk REFERENCES platforms(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS gp_unique ON games_to_platforms USING btree (game_id, platform_id);

CREATE TABLE IF NOT EXISTS games_to_tags (
    game_id uuid NOT NULL CONSTRAINT games_to_tags_game_id_games_id_fk REFERENCES games(id) ON DELETE CASCADE,
    tag_id uuid NOT NULL CONSTRAINT games_to_tags_tag_id_tags_id_fk REFERENCES tags(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS gt_unique ON games_to_tags USING btree (game_id, tag_id);

-- kon-blog's junction tables point here when both kons are installed. Its chain runs first, so the
-- link is made by whichever arrives second (see kon-blog/migrations/0009_final_shape.sql).
DO $$
BEGIN
  IF to_regclass('public.blog_posts_to_games') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blog_posts_to_games_game_id_games_id_fk') THEN
    ALTER TABLE blog_posts_to_games
      ADD CONSTRAINT blog_posts_to_games_game_id_games_id_fk FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE;
  END IF;
  IF to_regclass('public.blog_posts_to_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blog_posts_to_tags_tag_id_tags_id_fk') THEN
    ALTER TABLE blog_posts_to_tags
      ADD CONSTRAINT blog_posts_to_tags_tag_id_tags_id_fk FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE;
  END IF;
END $$;
