-- English names for kon-deckshow: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:deckshow:listar-juegos":"kon:deckshow:list-games","deckshow:listar-juegos":"deckshow:list-games","deckshow__listar-juegos":"deckshow__list-games","kon:deckshow:buscar-cartas":"kon:deckshow:search-cards","deckshow:buscar-cartas":"deckshow:search-cards","deckshow__buscar-cartas":"deckshow__search-cards","kon:deckshow:validar-mazo":"kon:deckshow:validate-deck","deckshow:validar-mazo":"deckshow:validate-deck","deckshow__validar-mazo":"deckshow__validate-deck","kon:deckshow:repartir-manos":"kon:deckshow:deal-hands","deckshow:repartir-manos":"deckshow:deal-hands","deckshow__repartir-manos":"deckshow__deal-hands","kon:deckshow:simular-goldfish":"kon:deckshow:simulate-goldfish","deckshow:simular-goldfish":"deckshow:simulate-goldfish","deckshow__simular-goldfish":"deckshow__simulate-goldfish","kon:deckshow:guardar-mazo":"kon:deckshow:save-deck","deckshow:guardar-mazo":"deckshow:save-deck","deckshow__guardar-mazo":"deckshow__save-deck","kon:deckshow:listar-entradas":"kon:deckshow:list-posts","deckshow:listar-entradas":"deckshow:list-posts","deckshow__listar-entradas":"deckshow__list-posts","kon:deckshow:ver-entrada":"kon:deckshow:get-post","deckshow:ver-entrada":"deckshow:get-post","deckshow__ver-entrada":"deckshow__get-post","kon:deckshow:publicar-entrada":"kon:deckshow:publish-post","deckshow:publicar-entrada":"deckshow:publish-post","deckshow__publicar-entrada":"deckshow__publish-post","kon:deckshow:editar-entrada":"kon:deckshow:update-post","deckshow:editar-entrada":"deckshow:update-post","deckshow__editar-entrada":"deckshow__update-post","kon:deckshow:borrar-entrada":"kon:deckshow:delete-post","deckshow:borrar-entrada":"deckshow:delete-post","deckshow__borrar-entrada":"deckshow__delete-post","kon:deckshow:dar-me-gusta":"kon:deckshow:like","deckshow:dar-me-gusta":"deckshow:like","deckshow__dar-me-gusta":"deckshow__like","kon:deckshow:quitar-me-gusta":"kon:deckshow:unlike","deckshow:quitar-me-gusta":"deckshow:unlike","deckshow__quitar-me-gusta":"deckshow__unlike","kon:deckshow:moderar-entrada":"kon:deckshow:moderate-post","deckshow:moderar-entrada":"deckshow:moderate-post","deckshow__moderar-entrada":"deckshow__moderate-post"}'::jsonb;
  ops jsonb := '{"listar-juegos":"list-games","buscar-cartas":"search-cards","validar-mazo":"validate-deck","repartir-manos":"deal-hands","simular-goldfish":"simulate-goldfish","guardar-mazo":"save-deck","listar-entradas":"list-posts","ver-entrada":"get-post","publicar-entrada":"publish-post","editar-entrada":"update-post","borrar-entrada":"delete-post","dar-me-gusta":"like","quitar-me-gusta":"unlike","moderar-entrada":"moderate-post"}'::jsonb;
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
