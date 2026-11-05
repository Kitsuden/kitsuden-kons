-- English names for kon-booking: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS booking_notes_dueno_de_reserva ON booking_notes;
DROP POLICY IF EXISTS booking_notes_insercion ON booking_notes;
DROP POLICY IF EXISTS booking_notes_staff ON booking_notes;
DROP POLICY IF EXISTS booking_reservations_staff ON booking_reservations;

-- Functions whose name or parameters change.
DROP FUNCTION IF EXISTS booking_huecos_ocupados(uuid, timestamp with time zone, timestamp with time zone);

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:booking:listar-salas":"kon:booking:list-rooms","booking:listar-salas":"booking:list-rooms","booking__listar-salas":"booking__list-rooms","kon:booking:ver-sala":"kon:booking:get-room","booking:ver-sala":"booking:get-room","booking__ver-sala":"booking__get-room","kon:booking:crear-sala":"kon:booking:create-room","booking:crear-sala":"booking:create-room","booking__crear-sala":"booking__create-room","kon:booking:editar-sala":"kon:booking:update-room","booking:editar-sala":"booking:update-room","booking__editar-sala":"booking__update-room","kon:booking:borrar-sala":"kon:booking:delete-room","booking:borrar-sala":"booking:delete-room","booking__borrar-sala":"booking__delete-room","kon:booking:listar-servicios":"kon:booking:list-services","booking:listar-servicios":"booking:list-services","booking__listar-servicios":"booking__list-services","kon:booking:crear-servicio":"kon:booking:create-service","booking:crear-servicio":"booking:create-service","booking__crear-servicio":"booking__create-service","kon:booking:consultar-disponibilidad":"kon:booking:check-availability","booking:consultar-disponibilidad":"booking:check-availability","booking__consultar-disponibilidad":"booking__check-availability","kon:booking:listar-huecos-de-sala":"kon:booking:list-room-slots","booking:listar-huecos-de-sala":"booking:list-room-slots","booking__listar-huecos-de-sala":"booking__list-room-slots","kon:booking:listar-reservas":"kon:booking:list-reservations","booking:listar-reservas":"booking:list-reservations","booking__listar-reservas":"booking__list-reservations","kon:booking:ver-reserva":"kon:booking:get-reservation","booking:ver-reserva":"booking:get-reservation","booking__ver-reserva":"booking__get-reservation","kon:booking:crear-reserva":"kon:booking:create-reservation","booking:crear-reserva":"booking:create-reservation","booking__crear-reserva":"booking__create-reservation","kon:booking:editar-reserva":"kon:booking:update-reservation","booking:editar-reserva":"booking:update-reservation","booking__editar-reserva":"booking__update-reservation","kon:booking:cancelar-reserva":"kon:booking:cancel-reservation","booking:cancelar-reserva":"booking:cancel-reservation","booking__cancelar-reserva":"booking__cancel-reservation","kon:booking:hacer-check-in":"kon:booking:check-in","booking:hacer-check-in":"booking:check-in","booking__hacer-check-in":"booking__check-in","kon:booking:hacer-check-out":"kon:booking:check-out","booking:hacer-check-out":"booking:check-out","booking__hacer-check-out":"booking__check-out","kon:booking:anotar-reserva":"kon:booking:annotate-reservation","booking:anotar-reserva":"booking:annotate-reservation","booking__anotar-reserva":"booking__annotate-reservation","kon:booking:listar-bloqueos":"kon:booking:list-blackouts","booking:listar-bloqueos":"booking:list-blackouts","booking__listar-bloqueos":"booking__list-blackouts","kon:booking:crear-bloqueo":"kon:booking:create-blackout","booking:crear-bloqueo":"booking:create-blackout","booking__crear-bloqueo":"booking__create-blackout","kon:booking:borrar-bloqueo":"kon:booking:delete-blackout","booking:borrar-bloqueo":"booking:delete-blackout","booking__borrar-bloqueo":"booking__delete-blackout","kon:booking:listar-mis-reservas":"kon:booking:list-my-reservations","booking:listar-mis-reservas":"booking:list-my-reservations","booking__listar-mis-reservas":"booking__list-my-reservations"}'::jsonb;
  ops jsonb := '{"listar-salas":"list-rooms","ver-sala":"get-room","crear-sala":"create-room","editar-sala":"update-room","borrar-sala":"delete-room","listar-servicios":"list-services","crear-servicio":"create-service","consultar-disponibilidad":"check-availability","listar-huecos-de-sala":"list-room-slots","listar-reservas":"list-reservations","ver-reserva":"get-reservation","crear-reserva":"create-reservation","editar-reserva":"update-reservation","cancelar-reserva":"cancel-reservation","hacer-check-in":"check-in","hacer-check-out":"check-out","anotar-reserva":"annotate-reservation","listar-bloqueos":"list-blackouts","crear-bloqueo":"create-blackout","borrar-bloqueo":"delete-blackout","listar-mis-reservas":"list-my-reservations"}'::jsonb;
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
