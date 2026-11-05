-- English names for kon-games: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"contenido:editar":"content:edit","kon:games:listar-juegos":"kon:games:list-games","games:listar-juegos":"games:list-games","games__listar-juegos":"games__list-games","kon:games:ver-juego-por-slug":"kon:games:get-game-by-slug","games:ver-juego-por-slug":"games:get-game-by-slug","games__ver-juego-por-slug":"games__get-game-by-slug","kon:games:listar-colecciones":"kon:games:list-collections","games:listar-colecciones":"games:list-collections","games__listar-colecciones":"games__list-collections","kon:games:ver-coleccion":"kon:games:get-collection","games:ver-coleccion":"games:get-collection","games__ver-coleccion":"games__get-collection","kon:games:crear-coleccion":"kon:games:create-collection","games:crear-coleccion":"games:create-collection","games__crear-coleccion":"games__create-collection","kon:games:editar-coleccion":"kon:games:update-collection","games:editar-coleccion":"games:update-collection","games__editar-coleccion":"games__update-collection","kon:games:borrar-coleccion":"kon:games:delete-collection","games:borrar-coleccion":"games:delete-collection","games__borrar-coleccion":"games__delete-collection","kon:games:listar-plataformas":"kon:games:list-platforms","games:listar-plataformas":"games:list-platforms","games__listar-plataformas":"games__list-platforms","kon:games:crear-plataforma":"kon:games:create-platform","games:crear-plataforma":"games:create-platform","games__crear-plataforma":"games__create-platform","kon:games:listar-etiquetas":"kon:games:list-tags","games:listar-etiquetas":"games:list-tags","games__listar-etiquetas":"games__list-tags","kon:games:crear-etiqueta":"kon:games:create-tag","games:crear-etiqueta":"games:create-tag","games__crear-etiqueta":"games__create-tag","kon:games:ver-juego":"kon:games:get-game","games:ver-juego":"games:get-game","games__ver-juego":"games__get-game","kon:games:crear-juego":"kon:games:create-game","games:crear-juego":"games:create-game","games__crear-juego":"games__create-game","kon:games:editar-capa-editorial":"kon:games:update-editorial-layer","games:editar-capa-editorial":"games:update-editorial-layer","games__editar-capa-editorial":"games__update-editorial-layer","kon:games:ordenar-bloques":"kon:games:reorder-blocks","games:ordenar-bloques":"games:reorder-blocks","games__ordenar-bloques":"games__reorder-blocks","kon:games:editar-juego":"kon:games:update-game","games:editar-juego":"games:update-game","games__editar-juego":"games__update-game","kon:games:borrar-juego":"kon:games:delete-game","games:borrar-juego":"games:delete-game","games__borrar-juego":"games__delete-game"}'::jsonb;
  ops jsonb := '{"listar-juegos":"list-games","ver-juego-por-slug":"get-game-by-slug","listar-colecciones":"list-collections","ver-coleccion":"get-collection","crear-coleccion":"create-collection","editar-coleccion":"update-collection","borrar-coleccion":"delete-collection","listar-plataformas":"list-platforms","crear-plataforma":"create-platform","listar-etiquetas":"list-tags","crear-etiqueta":"create-tag","ver-juego":"get-game","crear-juego":"create-game","editar-capa-editorial":"update-editorial-layer","ordenar-bloques":"reorder-blocks","editar-juego":"update-game","borrar-juego":"delete-game"}'::jsonb;
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
