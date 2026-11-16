-- 0001 — A person's mailbox and calendar, synced from a connected account (kon-connections)
-- Idempotent.
--
-- Only what a CRM timeline needs: who wrote to whom, the subject, a short preview, when. Never a full
-- body or an attachment. A mailbox is read only after its owner adds it, and everything synced from it
-- is deleted with it (and when its connection is revoked).

CREATE TABLE IF NOT EXISTS inbox_mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id TEXT NOT NULL,
  -- The kon-connections connection it reads through. No foreign key: that table is another kon's.
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  address TEXT NOT NULL,
  sync_mail BOOLEAN NOT NULL DEFAULT true,
  sync_calendar BOOLEAN NOT NULL DEFAULT true,
  -- Who sees what it brings: `private` (its owner) or `team` (also admins and editors). Each thread
  -- can be changed afterwards.
  default_visibility TEXT NOT NULL DEFAULT 'private' CHECK (default_visibility IN ('private', 'team')),
  -- How far back the first sync reads.
  backfill_days INTEGER NOT NULL DEFAULT 30 CHECK (backfill_days BETWEEN 0 AND 365),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  mail_cursor JSONB,
  calendar_cursor JSONB,
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, connection_id)
);

CREATE TABLE IF NOT EXISTS inbox_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id UUID NOT NULL REFERENCES inbox_mailboxes(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team')),
  last_message_at TIMESTAMPTZ,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, external_id)
);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id UUID NOT NULL REFERENCES inbox_mailboxes(id) ON DELETE CASCADE,
  thread_id UUID REFERENCES inbox_threads(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  from_address TEXT,
  from_name TEXT,
  to_addresses JSONB NOT NULL DEFAULT '[]',
  cc_addresses JSONB NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  -- Copied from the thread, so a policy never has to join.
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team')),
  sent_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, external_id)
);
CREATE INDEX IF NOT EXISTS inbox_messages_thread_idx ON inbox_messages (thread_id, sent_at);
CREATE INDEX IF NOT EXISTS inbox_messages_from_idx ON inbox_messages (from_address);

CREATE TABLE IF NOT EXISTS inbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id UUID NOT NULL REFERENCES inbox_mailboxes(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  location TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  attendees JSONB NOT NULL DEFAULT '[]',
  organizer TEXT,
  cancelled BOOLEAN NOT NULL DEFAULT false,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, external_id)
);
CREATE INDEX IF NOT EXISTS inbox_events_starts_idx ON inbox_events (owner_id, starts_at);

-- ── Row security ─────────────────────────────────────────────────────────────
--
--   system (no user in the context)   everything: the sync worker
--   the owner                         their mailboxes and everything synced from them
--   admins and editors                READ threads, messages and events marked `team`; never a
--                                     mailbox's settings, never a `private` thread
--
-- Nobody but the owner writes.

DO $$
DECLARE
  t text;
  sys CONSTANT text := '(COALESCE(current_setting(''app.current_user_id'', true), '''') = '''' '
    || 'AND COALESCE(current_setting(''app.current_user_role'', true), '''') = '''')';
  own CONSTANT text := '(COALESCE(current_setting(''app.current_user_id'', true), '''') <> '''' '
    || 'AND owner_id = current_setting(''app.current_user_id'', true))';
  team CONSTANT text := '(visibility = ''team'' AND current_setting(''app.current_user_role'', true) IN (''admin'', ''editor''))';
BEGIN
  FOREACH t IN ARRAY ARRAY['inbox_mailboxes', 'inbox_threads', 'inbox_messages', 'inbox_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_system', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)', t || '_system', t, sys, sys);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_owner', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)', t || '_owner', t, own, own);
    IF t <> 'inbox_mailboxes' THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_team_read', t);
      EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO PUBLIC USING (%s)', t || '_team_read', t, team);
    END IF;
  END LOOP;
END $$;
