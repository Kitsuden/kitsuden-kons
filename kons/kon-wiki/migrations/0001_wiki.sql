-- 0001 — Wiki: pages, immutable revisions and links
-- Idempotent.
-- The page is a POINTER; the content lives in the revisions, which only
-- grow. author_id is collaborative authorship, NOT personal ownership.
CREATE TABLE IF NOT EXISTS wiki_pages (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 0,
  protection TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_pages_slug_idx ON wiki_pages (slug);

CREATE TABLE IF NOT EXISTS wiki_revisions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  author_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_revisions_page_number_idx ON wiki_revisions (page_id, number);

-- Index of [[links]]: makes backlinks and "wanted pages" O(1).
CREATE TABLE IF NOT EXISTS wiki_links (
  id TEXT PRIMARY KEY,
  from_slug TEXT NOT NULL,
  to_slug TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wiki_links_to_idx ON wiki_links (to_slug);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_links_pair_idx ON wiki_links (from_slug, to_slug);
