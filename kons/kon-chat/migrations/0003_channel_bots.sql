-- 0003 — Channel bots: kon-chat answers another kon's customer conversations (koe), through a queue
-- ============================================================================
-- Idempotent: every step checks first, and the policies are dropped and created again.
--
-- A third audience, `channel`: the bot is not talked to through this kon's routes but through the
-- `chat-channel-turns` queue, by a kon that owns the conversation (koe's WhatsApp, Messenger, Instagram
-- and web chat inbox). That kon keeps the messages; this one keeps only what each turn cost, so the bot's
-- daily limit, its budget and its usage count channel turns as well. No text of the customer's is stored
-- here.
--
-- `chat_channel_turns` is unique per reply queue and the other kon's message id: the queue delivers at
-- least once, and a repeated job finds its row and does not run (or pay for) the turn again.
--
-- Row security as for messages: written by the system only (the queue handler), read by admins and by an
-- agent with `chat:configure` or `kon:chat:get-chatbot-usage` (the usage report reads it).

ALTER TABLE chat_bots DROP CONSTRAINT IF EXISTS chat_bots_audience_check;
ALTER TABLE chat_bots ADD CONSTRAINT chat_bots_audience_check CHECK (audience IN ('team', 'public', 'channel'));

CREATE TABLE IF NOT EXISTS chat_channel_turns (
    id text PRIMARY KEY,
    bot_id text NOT NULL REFERENCES chat_bots(id) ON DELETE CASCADE,
    reply_queue text NOT NULL,
    ref_conversation_id text NOT NULL,
    ref_message_id text NOT NULL,
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'answered', 'handoff', 'failed', 'refused')),
    error text,
    sources jsonb NOT NULL DEFAULT '[]',
    tool_calls jsonb NOT NULL DEFAULT '[]',
    trace_id text,
    tokens_in integer,
    tokens_out integer,
    cost_usd numeric(12, 6),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    finished_at timestamp with time zone,
    UNIQUE (reply_queue, ref_message_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_channel_turns_bot_day ON chat_channel_turns (bot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_channel_turns_conversation ON chat_channel_turns (ref_conversation_id, created_at);

DO $$
DECLARE
  system_only text := $q$(coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')$q$;
  admin text := $q$kitsuden_effective_admin('chat')$q$;
BEGIN
  ALTER TABLE chat_channel_turns ENABLE ROW LEVEL SECURITY;
  ALTER TABLE chat_channel_turns FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS chat_channel_turns_access ON chat_channel_turns;
  DROP POLICY IF EXISTS chat_channel_turns_agent_reads ON chat_channel_turns;
  EXECUTE format('CREATE POLICY chat_channel_turns_access ON chat_channel_turns FOR ALL USING (%s OR %s) WITH CHECK (%s)', system_only, admin, system_only);
  EXECUTE 'CREATE POLICY chat_channel_turns_agent_reads ON chat_channel_turns FOR SELECT TO PUBLIC USING ('
    || 'kitsuden_agent_can_in_kon(''chat'', ''chat:configure'') OR kitsuden_agent_can_in_kon(''chat'', ''kon:chat:get-chatbot-usage''))';
END $$;
