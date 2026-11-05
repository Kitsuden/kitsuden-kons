-- English names for kon-cardsim: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS cardsim_decks_sin_dueno ON cardsim_decks;

-- Columns.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('cardsim_sessions', 'rng_secreto', 'secret_rng')
  ) AS v(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.new_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Default values of new rows.
ALTER TABLE cardsim_decks ALTER COLUMN name SET DEFAULT 'Deck';

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:cardsim:listar-presets":"kon:cardsim:list-presets","cardsim:listar-presets":"cardsim:list-presets","cardsim__listar-presets":"cardsim__list-presets","kon:cardsim:listar-juegos":"kon:cardsim:list-games","cardsim:listar-juegos":"cardsim:list-games","cardsim__listar-juegos":"cardsim__list-games","kon:cardsim:ver-juego":"kon:cardsim:get-game","cardsim:ver-juego":"cardsim:get-game","cardsim__ver-juego":"cardsim__get-game","kon:cardsim:buscar-cartas":"kon:cardsim:search-cards","cardsim:buscar-cartas":"cardsim:search-cards","cardsim__buscar-cartas":"cardsim__search-cards","kon:cardsim:publicar-juego":"kon:cardsim:publish-game","cardsim:publicar-juego":"cardsim:publish-game","cardsim__publicar-juego":"cardsim__publish-game","kon:cardsim:importar-cartas":"kon:cardsim:import-cards","cardsim:importar-cartas":"cardsim:import-cards","cardsim__importar-cartas":"cardsim__import-cards","kon:cardsim:sincronizar-catalogo":"kon:cardsim:sync-catalog","cardsim:sincronizar-catalogo":"cardsim:sync-catalog","cardsim__sincronizar-catalogo":"cardsim__sync-catalog","kon:cardsim:generar-sellado":"kon:cardsim:generate-sealed","cardsim:generar-sellado":"cardsim:generate-sealed","cardsim__generar-sellado":"cardsim__generate-sealed","kon:cardsim:listar-mis-mazos":"kon:cardsim:list-my-decks","cardsim:listar-mis-mazos":"cardsim:list-my-decks","cardsim__listar-mis-mazos":"cardsim__list-my-decks","kon:cardsim:crear-mazo":"kon:cardsim:create-deck","cardsim:crear-mazo":"cardsim:create-deck","cardsim__crear-mazo":"cardsim__create-deck","kon:cardsim:ver-mazo":"kon:cardsim:get-deck","cardsim:ver-mazo":"cardsim:get-deck","cardsim__ver-mazo":"cardsim__get-deck","kon:cardsim:editar-mazo":"kon:cardsim:update-deck","cardsim:editar-mazo":"cardsim:update-deck","cardsim__editar-mazo":"cardsim__update-deck","kon:cardsim:borrar-mazo":"kon:cardsim:delete-deck","cardsim:borrar-mazo":"cardsim:delete-deck","cardsim__borrar-mazo":"cardsim__delete-deck","kon:cardsim:importar-mazo":"kon:cardsim:import-deck","cardsim:importar-mazo":"cardsim:import-deck","cardsim__importar-mazo":"cardsim__import-deck","kon:cardsim:exportar-mazo":"kon:cardsim:export-deck","cardsim:exportar-mazo":"cardsim:export-deck","cardsim__exportar-mazo":"cardsim__export-deck","kon:cardsim:simular-goldfish":"kon:cardsim:simulate-goldfish","cardsim:simular-goldfish":"cardsim:simulate-goldfish","cardsim__simular-goldfish":"cardsim__simulate-goldfish","kon:cardsim:listar-salas":"kon:cardsim:list-rooms","cardsim:listar-salas":"cardsim:list-rooms","cardsim__listar-salas":"cardsim__list-rooms","kon:cardsim:crear-sala":"kon:cardsim:create-room","cardsim:crear-sala":"cardsim:create-room","cardsim__crear-sala":"cardsim__create-room","kon:cardsim:buscar-sala-por-codigo":"kon:cardsim:find-room-by-code","cardsim:buscar-sala-por-codigo":"cardsim:find-room-by-code","cardsim__buscar-sala-por-codigo":"cardsim__find-room-by-code","kon:cardsim:sentarse-en-sala":"kon:cardsim:take-seat","cardsim:sentarse-en-sala":"cardsim:take-seat","cardsim__sentarse-en-sala":"cardsim__take-seat","kon:cardsim:ver-partida":"kon:cardsim:get-session","cardsim:ver-partida":"cardsim:get-session","cardsim__ver-partida":"cardsim__get-session","kon:cardsim:enviar-accion":"kon:cardsim:send-action","cardsim:enviar-accion":"cardsim:send-action","cardsim__enviar-accion":"cardsim__send-action","kon:cardsim:pedir-deshacer":"kon:cardsim:request-undo","cardsim:pedir-deshacer":"cardsim:request-undo","cardsim__pedir-deshacer":"cardsim__request-undo","kon:cardsim:cancelar-deshacer":"kon:cardsim:cancel-undo","cardsim:cancelar-deshacer":"cardsim:cancel-undo","cardsim__cancelar-deshacer":"cardsim__cancel-undo","kon:cardsim:ver-replay":"kon:cardsim:get-replay","cardsim:ver-replay":"cardsim:get-replay","cardsim__ver-replay":"cardsim__get-replay","kon:cardsim:pedir-revancha":"kon:cardsim:request-rematch","cardsim:pedir-revancha":"cardsim:request-rematch","cardsim__pedir-revancha":"cardsim__request-rematch","kon:cardsim:ver-match":"kon:cardsim:get-match","cardsim:ver-match":"cardsim:get-match","cardsim__ver-match":"cardsim__get-match","kon:cardsim:entrar-en-cola":"kon:cardsim:join-queue","cardsim:entrar-en-cola":"cardsim:join-queue","cardsim__entrar-en-cola":"cardsim__join-queue","kon:cardsim:salir-de-la-cola":"kon:cardsim:leave-queue","cardsim:salir-de-la-cola":"cardsim:leave-queue","cardsim__salir-de-la-cola":"cardsim__leave-queue","kon:cardsim:ver-clasificacion":"kon:cardsim:get-ranking","cardsim:ver-clasificacion":"cardsim:get-ranking","cardsim__ver-clasificacion":"cardsim__get-ranking"}'::jsonb;
  ops jsonb := '{"listar-presets":"list-presets","listar-juegos":"list-games","ver-juego":"get-game","buscar-cartas":"search-cards","publicar-juego":"publish-game","importar-cartas":"import-cards","sincronizar-catalogo":"sync-catalog","generar-sellado":"generate-sealed","listar-mis-mazos":"list-my-decks","crear-mazo":"create-deck","ver-mazo":"get-deck","editar-mazo":"update-deck","borrar-mazo":"delete-deck","importar-mazo":"import-deck","exportar-mazo":"export-deck","simular-goldfish":"simulate-goldfish","listar-salas":"list-rooms","crear-sala":"create-room","buscar-sala-por-codigo":"find-room-by-code","sentarse-en-sala":"take-seat","ver-partida":"get-session","enviar-accion":"send-action","pedir-deshacer":"request-undo","cancelar-deshacer":"cancel-undo","ver-replay":"get-replay","pedir-revancha":"request-rematch","ver-match":"get-match","entrar-en-cola":"join-queue","salir-de-la-cola":"leave-queue","ver-clasificacion":"get-ranking"}'::jsonb;
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
