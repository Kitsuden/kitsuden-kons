-- 0002 — A wiki is a SPACE with its own subdomain
-- Idempotent.
--
-- Until now `wiki_pages` was flat and the slug was unique across the WHOLE install:
-- there was no way to have a «weapons» page in two games, nor to serve each
-- wiki on its own subdomain (`throne-and-liberty.domain`). A slug prefix
-- was not enough: the `throne` wiki would have taken the pages of
-- `throne-and-liberty`, because they all start with `throne-`.
--
-- Now a page belongs to a wiki, and the slug is unique WITHIN it.

CREATE TABLE IF NOT EXISTS wikis (
  id TEXT PRIMARY KEY,
  -- The subdomain label. It is the wiki's identity.
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- No foreign key on purpose: `games` belongs to kon-games, and a kon does not tie
  -- its schema to another kon's.
  game_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wikis_slug_idx ON wikis (slug);
CREATE INDEX IF NOT EXISTS wikis_game_idx ON wikis (game_id);

ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS wiki_id TEXT;
ALTER TABLE wiki_links ADD COLUMN IF NOT EXISTS wiki_id TEXT;

-- Pages created before this migration are not lost: they go to a
-- «general» wiki, which is ONLY created if there is something to put in it.
INSERT INTO wikis (id, slug, title, description)
SELECT 'wiki-general', 'general', 'General',
       'Páginas creadas antes de que cada wiki tuviera su propio espacio.'
WHERE EXISTS (SELECT 1 FROM wiki_pages WHERE wiki_id IS NULL)
ON CONFLICT (slug) DO NOTHING;

UPDATE wiki_pages
   SET wiki_id = (SELECT id FROM wikis WHERE slug = 'general')
 WHERE wiki_id IS NULL;

-- Before this migration the page slug was globally unique, so each
-- link is attributed unambiguously to the wiki of its source page.
UPDATE wiki_links l
   SET wiki_id = p.wiki_id
  FROM wiki_pages p
 WHERE l.wiki_id IS NULL
   AND p.slug = l.from_slug;

-- A link whose source page no longer exists belongs to no space
-- and would only produce ghost backlinks.
DELETE FROM wiki_links WHERE wiki_id IS NULL;

ALTER TABLE wiki_pages ALTER COLUMN wiki_id SET NOT NULL;
ALTER TABLE wiki_links ALTER COLUMN wiki_id SET NOT NULL;

-- The slug stops being globally unique and becomes unique per wiki.
DROP INDEX IF EXISTS wiki_pages_slug_idx;
CREATE UNIQUE INDEX IF NOT EXISTS wiki_pages_wiki_slug_idx ON wiki_pages (wiki_id, slug);

DROP INDEX IF EXISTS wiki_links_to_idx;
DROP INDEX IF EXISTS wiki_links_pair_idx;
CREATE INDEX IF NOT EXISTS wiki_links_wiki_to_idx ON wiki_links (wiki_id, to_slug);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_links_wiki_pair_idx ON wiki_links (wiki_id, from_slug, to_slug);
