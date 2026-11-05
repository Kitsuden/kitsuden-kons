-- English names for kon-broadcast: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Default values of new rows.
ALTER TABLE broadcast_matches ALTER COLUMN event_title SET DEFAULT 'TOURNAMENT';

-- The panel saved the enabled classifications in the kon's settings under a Spanish key.
DO $$
BEGIN
  IF to_regclass('public.modules') IS NOT NULL THEN
    UPDATE modules SET settings = (settings - 'clasificaciones') || jsonb_build_object('classifications', settings->'clasificaciones')
      WHERE key IN ('kon-broadcast', 'broadcast') AND jsonb_typeof(settings) = 'object' AND settings ? 'clasificaciones';
  END IF;
END $$;

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:broadcast:secciones":"kon:broadcast:sections","broadcast:secciones":"broadcast:sections","broadcast__secciones":"broadcast__sections","kon:broadcast:overlay-del-set":"kon:broadcast:set-overlay","broadcast:overlay-del-set":"broadcast:set-overlay","broadcast__overlay-del-set":"broadcast__set-overlay","kon:broadcast:clasificaciones":"kon:broadcast:classifications","broadcast:clasificaciones":"broadcast:classifications","broadcast__clasificaciones":"broadcast__classifications","kon:broadcast:listar-sets":"kon:broadcast:list-sets","broadcast:listar-sets":"broadcast:list-sets","broadcast__listar-sets":"broadcast__list-sets","kon:broadcast:ver-set":"kon:broadcast:get-set","broadcast:ver-set":"broadcast:get-set","broadcast__ver-set":"broadcast__get-set","kon:broadcast:crear-set":"kon:broadcast:create-set","broadcast:crear-set":"broadcast:create-set","broadcast__crear-set":"broadcast__create-set","kon:broadcast:editar-set":"kon:broadcast:update-set","broadcast:editar-set":"broadcast:update-set","broadcast__editar-set":"broadcast__update-set","kon:broadcast:borrar-set":"kon:broadcast:delete-set","broadcast:borrar-set":"broadcast:delete-set","broadcast__borrar-set":"broadcast__delete-set","kon:broadcast:marcador":"kon:broadcast:scoreboard","broadcast:marcador":"broadcast:scoreboard","broadcast__marcador":"broadcast__scoreboard","kon:broadcast:pantallas":"kon:broadcast:screens","broadcast:pantallas":"broadcast:screens","broadcast__pantallas":"broadcast__screens","kon:broadcast:rotulo":"kon:broadcast:caption","broadcast:rotulo":"broadcast:caption","broadcast__rotulo":"broadcast__caption","kon:broadcast:intercambiar-lados":"kon:broadcast:swap-sides","broadcast:intercambiar-lados":"broadcast:swap-sides","broadcast__intercambiar-lados":"broadcast__swap-sides","kon:broadcast:vincular-jugador":"kon:broadcast:link-player","broadcast:vincular-jugador":"broadcast:link-player","broadcast__vincular-jugador":"broadcast__link-player","kon:broadcast:crear-set-desde-cuadro":"kon:broadcast:create-set-from-bracket","broadcast:crear-set-desde-cuadro":"broadcast:create-set-from-bracket","broadcast__crear-set-desde-cuadro":"broadcast__create-set-from-bracket","kon:broadcast:reportar-al-cuadro":"kon:broadcast:report-to-bracket","broadcast:reportar-al-cuadro":"broadcast:report-to-bracket","broadcast__reportar-al-cuadro":"broadcast__report-to-bracket","kon:broadcast:listar-personajes":"kon:broadcast:list-characters","broadcast:listar-personajes":"broadcast:list-characters","broadcast__listar-personajes":"broadcast__list-characters","kon:broadcast:cargar-personajes":"kon:broadcast:load-characters","broadcast:cargar-personajes":"broadcast:load-characters","broadcast__cargar-personajes":"broadcast__load-characters","kon:broadcast:overlay-de-partida":"kon:broadcast:game-overlay","broadcast:overlay-de-partida":"broadcast:game-overlay","broadcast__overlay-de-partida":"broadcast__game-overlay","kon:broadcast:crear-partida":"kon:broadcast:create-game","broadcast:crear-partida":"broadcast:create-game","broadcast__crear-partida":"broadcast__create-game","kon:broadcast:listar-partidas":"kon:broadcast:list-games","broadcast:listar-partidas":"broadcast:list-games","broadcast__listar-partidas":"broadcast__list-games","kon:broadcast:ver-partida":"kon:broadcast:get-game","broadcast:ver-partida":"broadcast:get-game","broadcast__ver-partida":"broadcast__get-game","kon:broadcast:paso-de-draft":"kon:broadcast:draft-step","broadcast:paso-de-draft":"broadcast:draft-step","broadcast__paso-de-draft":"broadcast__draft-step","kon:broadcast:deshacer-draft":"kon:broadcast:undo-draft","broadcast:deshacer-draft":"broadcast:undo-draft","broadcast__deshacer-draft":"broadcast__undo-draft","kon:broadcast:fearless-de-partida":"kon:broadcast:game-fearless","broadcast:fearless-de-partida":"broadcast:game-fearless","broadcast__fearless-de-partida":"broadcast__game-fearless","kon:broadcast:adaptadores-de-ingesta":"kon:broadcast:ingest-adapters","broadcast:adaptadores-de-ingesta":"broadcast:ingest-adapters","broadcast__adaptadores-de-ingesta":"broadcast__ingest-adapters","kon:broadcast:iniciar-ingesta":"kon:broadcast:start-ingest","broadcast:iniciar-ingesta":"broadcast:start-ingest","broadcast__iniciar-ingesta":"broadcast__start-ingest","kon:broadcast:token-de-ingesta":"kon:broadcast:ingest-token","broadcast:token-de-ingesta":"broadcast:ingest-token","broadcast__token-de-ingesta":"broadcast__ingest-token","kon:broadcast:empujar-frame":"kon:broadcast:push-frame","broadcast:empujar-frame":"broadcast:push-frame","broadcast__empujar-frame":"broadcast__push-frame","kon:broadcast:parar-ingesta":"kon:broadcast:stop-ingest","broadcast:parar-ingesta":"broadcast:stop-ingest","broadcast__parar-ingesta":"broadcast__stop-ingest","kon:broadcast:cerrar-partida":"kon:broadcast:close-game","broadcast:cerrar-partida":"broadcast:close-game","broadcast__cerrar-partida":"broadcast__close-game"}'::jsonb;
  ops jsonb := '{"secciones":"sections","overlay-del-set":"set-overlay","clasificaciones":"classifications","listar-sets":"list-sets","ver-set":"get-set","crear-set":"create-set","editar-set":"update-set","borrar-set":"delete-set","marcador":"scoreboard","pantallas":"screens","rotulo":"caption","intercambiar-lados":"swap-sides","vincular-jugador":"link-player","crear-set-desde-cuadro":"create-set-from-bracket","reportar-al-cuadro":"report-to-bracket","listar-personajes":"list-characters","cargar-personajes":"load-characters","overlay-de-partida":"game-overlay","crear-partida":"create-game","listar-partidas":"list-games","ver-partida":"get-game","paso-de-draft":"draft-step","deshacer-draft":"undo-draft","fearless-de-partida":"game-fearless","adaptadores-de-ingesta":"ingest-adapters","iniciar-ingesta":"start-ingest","token-de-ingesta":"ingest-token","empujar-frame":"push-frame","parar-ingesta":"stop-ingest","cerrar-partida":"close-game"}'::jsonb;
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
