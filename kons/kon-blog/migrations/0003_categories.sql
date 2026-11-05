-- Blog categories: the hierarchical taxonomy that was missing
-- ============================================================================
--
-- The blog only had TAGS (`blog_posts_to_tags`) and games. Tags are flat and
-- open-vocabulary: they work for "elden-ring", "patch-1.2", not for organizing
-- a growing blog. This adds the other half of the classic taxonomy
-- —categories, hierarchical and closed-vocabulary—, which is what is used for
-- navigation and for the site's sections.
--
-- Note: the `tags` table lives in kon-games, not here. Categories DO belong to
-- the blog, so they live in the blog. Each kon owns its data.

CREATE TABLE IF NOT EXISTS blog_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(200) NOT NULL UNIQUE,
    description TEXT,

    -- Hierarchy. `ON DELETE SET NULL` and not `CASCADE` on purpose: deleting a
    -- parent category must not take its children with it and, with them, the
    -- `blog_posts_to_categories` rows hanging from them. Once orphaned they
    -- move up to the root, which is visible and fixable; a cascading delete is not.
    parent_id UUID REFERENCES blog_categories(id) ON DELETE SET NULL,

    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS blog_categories_parent_idx ON blog_categories(parent_id);
CREATE INDEX IF NOT EXISTS blog_categories_order_idx ON blog_categories(display_order);

CREATE TABLE IF NOT EXISTS blog_posts_to_categories (
    post_id UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES blog_categories(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, category_id)
);

CREATE INDEX IF NOT EXISTS bptc_category_idx ON blog_posts_to_categories(category_id);
