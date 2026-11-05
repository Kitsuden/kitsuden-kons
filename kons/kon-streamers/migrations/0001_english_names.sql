-- English names for kon-streamers: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:streamers:listar-streamers":"kon:streamers:list-streamers","streamers:listar-streamers":"streamers:list-streamers","streamers__listar-streamers":"streamers__list-streamers","kon:streamers:listar-en-directo":"kon:streamers:list-live","streamers:listar-en-directo":"streamers:list-live","streamers__listar-en-directo":"streamers__list-live","kon:streamers:ver-streamer-por-slug":"kon:streamers:get-streamer-by-slug","streamers:ver-streamer-por-slug":"streamers:get-streamer-by-slug","streamers__ver-streamer-por-slug":"streamers__get-streamer-by-slug","kon:streamers:sincronizar-directo":"kon:streamers:sync-live","streamers:sincronizar-directo":"streamers:sync-live","streamers__sincronizar-directo":"streamers__sync-live","kon:streamers:ver-streamer":"kon:streamers:get-streamer","streamers:ver-streamer":"streamers:get-streamer","streamers__ver-streamer":"streamers__get-streamer","kon:streamers:crear-streamer":"kon:streamers:create-streamer","streamers:crear-streamer":"streamers:create-streamer","streamers__crear-streamer":"streamers__create-streamer","kon:streamers:editar-streamer":"kon:streamers:update-streamer","streamers:editar-streamer":"streamers:update-streamer","streamers__editar-streamer":"streamers__update-streamer","kon:streamers:borrar-streamer":"kon:streamers:delete-streamer","streamers:borrar-streamer":"streamers:delete-streamer","streamers__borrar-streamer":"streamers__delete-streamer"}'::jsonb;
  ops jsonb := '{"listar-streamers":"list-streamers","listar-en-directo":"list-live","ver-streamer-por-slug":"get-streamer-by-slug","sincronizar-directo":"sync-live","ver-streamer":"get-streamer","crear-streamer":"create-streamer","editar-streamer":"update-streamer","borrar-streamer":"delete-streamer"}'::jsonb;
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('agent_identities', 'scopes'), ('agent_identities', 'allowed_tools'), ('agent_proposals', 'scopes'),
    ('oauth_authorization_requests', 'requested_scopes'), ('oauth_codes', 'scopes'), ('oauth_grants', 'scopes'), ('oauth_tokens', 'scopes')
  ) AS v(tbl, col) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t.tbl AND column_name = t.col) THEN
      EXECUTE format($f$
        UPDATE %1$I SET %2$I = (
          SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e) <> 'string' THEN e
                                         WHEN left(e #>> '{}', 1) = '!' THEN to_jsonb('!' || coalesce($1 ->> substr(e #>> '{}', 2), substr(e #>> '{}', 2)))
                                         ELSE to_jsonb(coalesce($1 ->> (e #>> '{}'), e #>> '{}')) END), '[]'::jsonb)
          FROM jsonb_array_elements(%2$I) AS e)
        WHERE jsonb_typeof(%2$I) = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(%2$I) AS e
          WHERE jsonb_typeof(e) = 'string' AND $1 ? ltrim(e #>> '{}', '!'))
      $f$, t.tbl, t.col) USING m;
    END IF;
  END LOOP;
  IF to_regclass('public.agent_proposals') IS NOT NULL THEN
    UPDATE agent_proposals SET
        operation_key = coalesce(m ->> operation_key, operation_key),
        tool = coalesce(m ->> tool, tool),
        operation_id = coalesce(ops ->> operation_id, operation_id)
      WHERE status = 'pending' AND (m ? coalesce(operation_key, '') OR m ? coalesce(tool, ''));
  END IF;
END $$;
