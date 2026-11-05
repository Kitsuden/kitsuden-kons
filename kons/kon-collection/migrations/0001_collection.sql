-- 0001 — Each reader's collection
-- Idempotent.
--
-- One mark per (person, index, entry). The primary key is the trio: marking
-- twice does not store two rows, and unmarking deletes that row.
--
-- `entry_key` is the entry's SLUG within its index (`emberpup`), which is
-- what the page has at hand; see the schema comment.
CREATE TABLE IF NOT EXISTS collection_marks (
  user_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'caught',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dataset_id, entry_key)
);

-- The page's query is always "what I have from THIS index"
CREATE INDEX IF NOT EXISTS collection_marks_user_dataset_idx
  ON collection_marks (user_id, dataset_id);
