-- Blog & Content Publishing Initial Migration
-- Creates blog_posts, blog_posts_to_tags, and blog_posts_to_games tables

-- Enum for blog post status
DO $$ BEGIN CREATE TYPE blog_status AS ENUM ('draft', 'published', 'scheduled'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Blog posts table
CREATE TABLE IF NOT EXISTS blog_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(500) NOT NULL,
    slug VARCHAR(500) NOT NULL UNIQUE,
    content JSONB, -- Lexical rich text JSON
    excerpt TEXT,
    status blog_status DEFAULT 'draft' NOT NULL,
    published_at TIMESTAMP WITH TIME ZONE,
    author_id TEXT NOT NULL,
    featured_image_id UUID,
    reading_time INTEGER,
    seo_overrides JSONB,
    source JSONB,
    bluf_text TEXT,
    faq_data JSONB,
    dataset_url TEXT,
    meta_title VARCHAR(70),
    meta_description VARCHAR(170),
    blocks JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Blog posts to tags junction table
CREATE TABLE IF NOT EXISTS blog_posts_to_tags (
    post_id UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL,
    PRIMARY KEY (post_id, tag_id)
);

-- Blog posts to games junction table
CREATE TABLE IF NOT EXISTS blog_posts_to_games (
    post_id UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
    game_id UUID NOT NULL,
    PRIMARY KEY (post_id, game_id)
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS blog_posts_slug_idx ON blog_posts(slug);
CREATE INDEX IF NOT EXISTS blog_posts_status_idx ON blog_posts(status);
CREATE INDEX IF NOT EXISTS blog_posts_published_idx ON blog_posts(published_at);
CREATE INDEX IF NOT EXISTS blog_posts_author_idx ON blog_posts(author_id);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_blog_posts_updated_at ON blog_posts;
CREATE TRIGGER update_blog_posts_updated_at
    BEFORE UPDATE ON blog_posts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
