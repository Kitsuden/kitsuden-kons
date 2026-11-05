-- 0001 — Agents with the kon's scope reach the bots the API already lets them configure
-- ============================================================================
-- Idempotent: drops and recreates the same five policies of 0000.
--
-- An agent with `chat:*` passes the HTTP policy (the kon-wide scope grants every operation) and
-- `list-chatbots` / `create-chatbot` are MCP tools, but 0000 only let the HUMAN roles through:
-- the agent got an empty list and a 500 on create (row-level security violation). The same class
-- of bug the core fixed for dms, members, booking and directory. Here "admin" and "team" become
-- the core's EFFECTIVE ones: the human role, or an agent that opens the whole kon
-- (`chat:*`, `kon:chat:*`, `admin`), with a denial winning (agent-functions.sql).

DO $$
DECLARE
  t text;
  system_only text := $q$(coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')$q$;
  admin text := $q$kitsuden_effective_admin('chat')$q$;
  me text := $q$coalesce(current_setting('app.current_user_id', true), '')$q$;
  team text := $q$kitsuden_effective_staff('chat')$q$;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_bots', 'chat_documents', 'chat_chunks', 'chat_conversations', 'chat_messages'] LOOP
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
