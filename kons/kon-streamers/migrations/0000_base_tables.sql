-- kon-streamers: its tables, in their final shape
-- ============================================================================
--
-- These tables used to come from the core's base migration. A fresh core no longer creates them,
-- so the kon does. It is the first file of the chain and a no-op on a database that already has them.
--
-- kon-streamers depends on kon-games (kon.json) and its chain runs after it, so `games` exists when
-- the kon was installed the usual way. The foreign key checks anyway: `--kon streamers` alone
-- must not stop at this file; the link comes when the table is there.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'streamers_platform') THEN
    CREATE TYPE streamers_platform AS ENUM ('twitch', 'youtube', 'kick');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS streamers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name character varying(200) NOT NULL,
    slug character varying(200) NOT NULL,
    platform streamers_platform NOT NULL,
    channel_id character varying(200) NOT NULL,
    channel_url text,
    is_live boolean DEFAULT false,
    current_stream_title text,
    viewer_count integer DEFAULT 0,
    follower_count integer DEFAULT 0,
    avatar_id uuid CONSTRAINT streamers_avatar_id_media_id_fk REFERENCES media(id) ON DELETE SET NULL,
    thumbnail_url text,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    bio text,
    current_game_id uuid,
    thumbnail_id uuid,
    social_links text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS streamers_platform_idx ON streamers USING btree (platform);
CREATE UNIQUE INDEX IF NOT EXISTS streamers_slug_idx ON streamers USING btree (slug);

CREATE TABLE IF NOT EXISTS games_to_streamers (
    game_id uuid NOT NULL,
    streamer_id uuid NOT NULL CONSTRAINT games_to_streamers_streamer_id_streamers_id_fk REFERENCES streamers(id) ON DELETE CASCADE,
    is_primary boolean DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS gs_unique ON games_to_streamers USING btree (game_id, streamer_id);

DO $$
BEGIN
  IF to_regclass('public.games') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'games_to_streamers_game_id_games_id_fk') THEN
    ALTER TABLE games_to_streamers
      ADD CONSTRAINT games_to_streamers_game_id_games_id_fk FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE;
  END IF;
END $$;
