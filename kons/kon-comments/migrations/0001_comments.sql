-- 0001 — Comments: polymorphic comments with threads, votes and moderation
-- ============================================================================
-- Idempotent.
--
-- TWO tables. The second exists for a reason that is rarely noticed until it fails:
-- without it, the vote counter can be raised a thousand times from the same account.
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,

  -- Polymorphic and WITHOUT a foreign key, on purpose: a comments table for
  -- each commentable thing would repeat threads, votes and moderation five times.
  -- The price is orphaned comments if the subject is deleted, which break
  -- nothing because nobody asks for the comments of something that no longer exists.
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,

  parent_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
  -- Computed on WRITE. Deriving it on read by walking up the parents costs N
  -- queries per comment: a thread of 200 becomes 200 queries.
  depth INTEGER NOT NULL DEFAULT 0,

  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',

  -- DENORMALIZED for speed. comment_votes is the source of truth and
  -- lets it be recomputed: a counter with no way to rebuild it would be a mistake.
  score INTEGER NOT NULL DEFAULT 0,

  author_id TEXT,
  -- Copy of the name at posting time: if the user is deleted, the thread still reads the same.
  author_name TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The index that matters: "give me the comments of this page".
CREATE INDEX IF NOT EXISTS comments_subject_idx ON comments (subject_type, subject_id, status);
CREATE INDEX IF NOT EXISTS comments_parent_idx ON comments (parent_id);
CREATE INDEX IF NOT EXISTS comments_author_idx ON comments (author_id);

CREATE TABLE IF NOT EXISTS comment_votes (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  -- +1 or -1. There is no 0: withdrawing the vote deletes the row.
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ONE vote per user and comment. It is the reason this table exists.
CREATE UNIQUE INDEX IF NOT EXISTS comment_votes_unique_idx ON comment_votes (comment_id, user_id);
CREATE INDEX IF NOT EXISTS comment_votes_comment_idx ON comment_votes (comment_id);
