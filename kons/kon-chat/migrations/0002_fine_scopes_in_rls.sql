-- 0002 — Fine scopes reach the rows their operation needs
-- ============================================================================
-- Idempotent: drops and recreates the `_agent_reads` and `_agent_changes` policies it adds.
--
-- The HTTP check lets an agent run an admin operation with the operation's fine scope
-- (`kon:chat:list-chatbots`) or the policy scope (`chat:configure`), but 0001 admits an agent
-- in the row security only when its key opens the whole kon (`chat:*`, `kon:chat:*`, `admin`):
-- with a fine scope alone a list came back empty and a write failed on the row-level check.
-- These policies sit next to the ones of 0001 (permissive policies are ORed) and admit an agent
-- whose key grants the operation that needs the table, with the core's rule
-- (`kitsuden_agent_can_in_kon`: a denial of the scope, of `chat:*` or of `kon:chat:*` wins).
--
--   chat_bots           read by every admin operation; written by create, update, delete
--   chat_documents      read and written by list/add/delete knowledge (written: add, delete)
--   chat_chunks         read and written by add knowledge; read by delete knowledge
--   chat_conversations  read by list-chatbot-conversations (still written by the system only)
--   chat_messages       read by get-chatbot-usage and list-chatbot-feedback (system writes)
--
-- `chat:configure` grants every admin operation, so it reaches every table here. Conversations
-- and messages stay written by the system only, as in 0001.

DO $$
DECLARE
  t text;
  reads text[];
  changes text[];
  grants CONSTANT text :=
    '(kitsuden_agent_can_in_kon(''chat'', ''chat:configure'') OR EXISTS ('
    || 'SELECT 1 FROM unnest(%L::text[]) AS op WHERE kitsuden_agent_can_in_kon(''chat'', ''kon:chat:'' || op)))';
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_bots', 'chat_documents', 'chat_chunks', 'chat_conversations', 'chat_messages'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_agent_reads', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_agent_changes', t);

    reads := CASE t
      WHEN 'chat_bots' THEN ARRAY['list-chatbots', 'create-chatbot', 'update-chatbot', 'delete-chatbot',
        'list-chatbot-knowledge', 'add-chatbot-knowledge', 'delete-chatbot-knowledge',
        'list-chatbot-conversations', 'get-chatbot-usage', 'list-chatbot-feedback']
      WHEN 'chat_documents' THEN ARRAY['list-chatbot-knowledge', 'add-chatbot-knowledge', 'delete-chatbot-knowledge']
      WHEN 'chat_chunks' THEN ARRAY['add-chatbot-knowledge', 'delete-chatbot-knowledge']
      WHEN 'chat_conversations' THEN ARRAY['list-chatbot-conversations']
      WHEN 'chat_messages' THEN ARRAY['get-chatbot-usage', 'list-chatbot-feedback']
    END;
    changes := CASE t
      WHEN 'chat_bots' THEN ARRAY['create-chatbot', 'update-chatbot', 'delete-chatbot']
      WHEN 'chat_documents' THEN ARRAY['add-chatbot-knowledge', 'delete-chatbot-knowledge']
      WHEN 'chat_chunks' THEN ARRAY['add-chatbot-knowledge']
      ELSE NULL
    END;

    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO PUBLIC USING (%s)',
      t || '_agent_reads', t, format(grants, reads));
    IF changes IS NOT NULL THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
        t || '_agent_changes', t, format(grants, changes), format(grants, changes));
    END IF;
  END LOOP;
END $$;
