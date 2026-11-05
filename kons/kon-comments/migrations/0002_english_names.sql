-- English names for kon-comments: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:comments:cola-de-moderacion":"kon:comments:moderation-queue","comments:cola-de-moderacion":"comments:moderation-queue","comments__cola-de-moderacion":"comments__moderation-queue","kon:comments:moderar-en-lote":"kon:comments:moderate-in-bulk","comments:moderar-en-lote":"comments:moderate-in-bulk","comments__moderar-en-lote":"comments__moderate-in-bulk","kon:comments:ver-hilo":"kon:comments:get-thread","comments:ver-hilo":"comments:get-thread","comments__ver-hilo":"comments__get-thread","kon:comments:crear-comentario":"kon:comments:create-comment","comments:crear-comentario":"comments:create-comment","comments__crear-comentario":"comments__create-comment","kon:comments:editar-comentario":"kon:comments:update-comment","comments:editar-comentario":"comments:update-comment","comments__editar-comentario":"comments__update-comment","kon:comments:moderar-comentario":"kon:comments:moderate-comment","comments:moderar-comentario":"comments:moderate-comment","comments__moderar-comentario":"comments__moderate-comment","kon:comments:borrar-comentario":"kon:comments:delete-comment","comments:borrar-comentario":"comments:delete-comment","comments__borrar-comentario":"comments__delete-comment","kon:comments:votar-comentario":"kon:comments:vote-comment","comments:votar-comentario":"comments:vote-comment","comments__votar-comentario":"comments__vote-comment"}'::jsonb;
  ops jsonb := '{"cola-de-moderacion":"moderation-queue","moderar-en-lote":"moderate-in-bulk","ver-hilo":"get-thread","crear-comentario":"create-comment","editar-comentario":"update-comment","moderar-comentario":"moderate-comment","borrar-comentario":"delete-comment","votar-comentario":"vote-comment"}'::jsonb;
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
