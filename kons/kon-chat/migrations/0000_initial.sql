-- kon-chat: chatbots over the core's agents, with what they know and what they said
-- ============================================================================
--
-- A bot is a channel to one of the core's agent identities: the agent brings the model, its prompt, its scopes
-- and its tools; the bot adds who may talk to it (the team, some of it, or anyone on a website), which tool group
-- it may use, what it knows (documents split into chunks, with embeddings when the core has a provider), what it
-- may spend, and limits.
--
-- Conversations and messages are kept for the team to review, as parts (text, tool calls, sources, approvals),
-- with their cost and the feedback people gave. A visitor is never identified: only a hash of the random key
-- their browser keeps.
--
-- Re-runnable: every step checks first.

CREATE TABLE IF NOT EXISTS chat_bots (
    id text PRIMARY KEY,
    slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
    name text NOT NULL,
    agent_id text NOT NULL,
    audience text NOT NULL DEFAULT 'team' CHECK (audience IN ('team', 'public')),
    toolset text,
    greeting text,
    members jsonb NOT NULL DEFAULT '[]',
    allowed_origins jsonb NOT NULL DEFAULT '[]',
    daily_limit integer NOT NULL DEFAULT 500 CHECK (daily_limit BETWEEN 1 AND 100000),
    user_daily_limit integer NOT NULL DEFAULT 200 CHECK (user_daily_limit BETWEEN 1 AND 100000),
    visitor_hourly_limit integer NOT NULL DEFAULT 30 CHECK (visitor_hourly_limit BETWEEN 1 AND 1000),
    price_in_per_million numeric(12, 4) NOT NULL DEFAULT 0 CHECK (price_in_per_million >= 0),
    price_out_per_million numeric(12, 4) NOT NULL DEFAULT 0 CHECK (price_out_per_million >= 0),
    daily_budget_usd numeric(12, 2) CHECK (daily_budget_usd IS NULL OR daily_budget_usd > 0),
    active boolean NOT NULL DEFAULT true,
    created_by text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_conversations (
    id text PRIMARY KEY,
    bot_id text NOT NULL REFERENCES chat_bots(id) ON DELETE CASCADE,
    user_id text,
    visitor_key text,
    forked_from text,
    message_count integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    last_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (user_id IS NOT NULL OR visitor_key IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_bot ON chat_conversations (bot_id, last_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_visitor ON chat_conversations (visitor_key) WHERE visitor_key IS NOT NULL;

-- A document is the bot's knowledge, or, with a conversation, an attachment only that conversation searches.
CREATE TABLE IF NOT EXISTS chat_documents (
    id text PRIMARY KEY,
    bot_id text NOT NULL REFERENCES chat_bots(id) ON DELETE CASCADE,
    conversation_id text REFERENCES chat_conversations(id) ON DELETE CASCADE,
    title text NOT NULL,
    content text NOT NULL,
    chunk_count integer NOT NULL DEFAULT 0,
    embedded boolean NOT NULL DEFAULT false,
    created_by text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_documents_bot ON chat_documents (bot_id);
CREATE INDEX IF NOT EXISTS idx_chat_documents_conversation ON chat_documents (conversation_id) WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_chunks (
    id text PRIMARY KEY,
    document_id text NOT NULL REFERENCES chat_documents(id) ON DELETE CASCADE,
    bot_id text NOT NULL REFERENCES chat_bots(id) ON DELETE CASCADE,
    conversation_id text,
    ordinal integer NOT NULL,
    text text NOT NULL,
    embedding jsonb
);
CREATE INDEX IF NOT EXISTS idx_chat_chunks_bot ON chat_chunks (bot_id);

-- With pgvector in the database (the core creates it for its own memory), chunks also get a vector column and
-- the search runs in SQL. Without it, the search compares the jsonb vectors in memory. The extension is never
-- created here: that needs privileges a kon does not ask for.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE chat_chunks ADD COLUMN IF NOT EXISTS embedding_vec vector';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS chat_messages (
    id text PRIMARY KEY,
    conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    bot_id text NOT NULL REFERENCES chat_bots(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('user', 'assistant')),
    content text NOT NULL,
    parts jsonb NOT NULL DEFAULT '[]',
    sources jsonb NOT NULL DEFAULT '[]',
    tool_calls jsonb NOT NULL DEFAULT '[]',
    trace_id text,
    tokens_in integer,
    tokens_out integer,
    cost_usd numeric(12, 6),
    feedback smallint CHECK (feedback IS NULL OR feedback IN (-1, 1)),
    feedback_comment text,
    feedback_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_bot_day ON chat_messages (bot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_feedback ON chat_messages (bot_id, feedback_at DESC) WHERE feedback IS NOT NULL;

DO $$
DECLARE
  t text;
  system_only text := $q$(coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')$q$;
  admin text := $q$(current_setting('app.current_user_role', true) = 'admin')$q$;
  me text := $q$coalesce(current_setting('app.current_user_id', true), '')$q$;
  team text := $q$(current_setting('app.current_user_role', true) IN ('admin', 'editor'))$q$;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_bots', 'chat_documents', 'chat_chunks', 'chat_conversations', 'chat_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_access', t);
  END LOOP;
  -- Configuration: the system and admins write; the team reads the bots it may talk to.
  EXECUTE format('CREATE POLICY chat_bots_access ON chat_bots FOR ALL USING (%s OR %s OR %s) WITH CHECK (%s OR %s)', system_only, admin, team, system_only, admin);
  EXECUTE format('CREATE POLICY chat_documents_access ON chat_documents FOR ALL USING (%s OR %s) WITH CHECK (%s OR %s)', system_only, admin, system_only, admin);
  EXECUTE format('CREATE POLICY chat_chunks_access ON chat_chunks FOR ALL USING (%s OR %s) WITH CHECK (%s OR %s)', system_only, admin, system_only, admin);
  -- Conversations: the system writes them; an admin reads all; a person reads their own.
  EXECUTE format('CREATE POLICY chat_conversations_access ON chat_conversations FOR ALL USING (%s OR %s OR user_id = %s) WITH CHECK (%s)', system_only, admin, me, system_only);
  EXECUTE format('CREATE POLICY chat_messages_access ON chat_messages FOR ALL USING (%s OR %s OR EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = conversation_id AND c.user_id = %s)) WITH CHECK (%s)', system_only, admin, me, system_only);
END $$;
