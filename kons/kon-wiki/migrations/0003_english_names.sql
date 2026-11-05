-- English names for kon-wiki: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:wiki:listar-wikis":"kon:wiki:list-wikis","wiki:listar-wikis":"wiki:list-wikis","wiki__listar-wikis":"wiki__list-wikis","kon:wiki:sugerir-wiki":"kon:wiki:suggest-wiki","wiki:sugerir-wiki":"wiki:suggest-wiki","wiki__sugerir-wiki":"wiki__suggest-wiki","kon:wiki:crear-wiki":"kon:wiki:create-wiki","wiki:crear-wiki":"wiki:create-wiki","wiki__crear-wiki":"wiki__create-wiki","kon:wiki:ver-wiki":"kon:wiki:get-wiki","wiki:ver-wiki":"wiki:get-wiki","wiki__ver-wiki":"wiki__get-wiki","kon:wiki:listar-paginas":"kon:wiki:list-pages","wiki:listar-paginas":"wiki:list-pages","wiki__listar-paginas":"wiki__list-pages","kon:wiki:ver-pagina":"kon:wiki:get-page","wiki:ver-pagina":"wiki:get-page","wiki__ver-pagina":"wiki__get-page","kon:wiki:historial-de-pagina":"kon:wiki:page-history","wiki:historial-de-pagina":"wiki:page-history","wiki__historial-de-pagina":"wiki__page-history","kon:wiki:comparar-revisiones":"kon:wiki:compare-revisions","wiki:comparar-revisiones":"wiki:compare-revisions","wiki__comparar-revisiones":"wiki__compare-revisions","kon:wiki:guardar-pagina":"kon:wiki:save-page","wiki:guardar-pagina":"wiki:save-page","wiki__guardar-pagina":"wiki__save-page","kon:wiki:revertir-pagina":"kon:wiki:revert-page","wiki:revertir-pagina":"wiki:revert-page","wiki__revertir-pagina":"wiki__revert-page","kon:wiki:paginas-pedidas":"kon:wiki:requested-pages","wiki:paginas-pedidas":"wiki:requested-pages","wiki__paginas-pedidas":"wiki__requested-pages"}'::jsonb;
  ops jsonb := '{"listar-wikis":"list-wikis","sugerir-wiki":"suggest-wiki","crear-wiki":"create-wiki","ver-wiki":"get-wiki","listar-paginas":"list-pages","ver-pagina":"get-page","historial-de-pagina":"page-history","comparar-revisiones":"compare-revisions","guardar-pagina":"save-page","revertir-pagina":"revert-page","paginas-pedidas":"requested-pages"}'::jsonb;
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
