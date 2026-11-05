-- English names for kon-members: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS member_access_permitir ON member_access;
DROP POLICY IF EXISTS member_access_solo_equipo ON member_access;
DROP POLICY IF EXISTS members_permitir ON members;
DROP POLICY IF EXISTS members_solo_equipo ON members;
DROP POLICY IF EXISTS member_sessions_permitir ON member_sessions;
DROP POLICY IF EXISTS member_sessions_solo_sistema ON member_sessions;
DROP POLICY IF EXISTS member_signins_permitir ON member_signins;
DROP POLICY IF EXISTS member_signins_solo_sistema ON member_signins;

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:members:listar-planes":"kon:members:list-plans","members:listar-planes":"members:list-plans","members__listar-planes":"members__list-plans","kon:members:pedir-enlace-de-acceso":"kon:members:request-access-link","members:pedir-enlace-de-acceso":"members:request-access-link","members__pedir-enlace-de-acceso":"members__request-access-link","kon:members:verificar-enlace-de-acceso":"kon:members:verify-access-link","members:verificar-enlace-de-acceso":"members:verify-access-link","members__verificar-enlace-de-acceso":"members__verify-access-link","kon:members:ver-lector":"kon:members:get-reader","members:ver-lector":"members:get-reader","members__ver-lector":"members__get-reader","kon:members:cerrar-sesion-lector":"kon:members:sign-out-reader","members:cerrar-sesion-lector":"members:sign-out-reader","members__cerrar-sesion-lector":"members__sign-out-reader","kon:members:comprobar-acceso":"kon:members:check-access","members:comprobar-acceso":"members:check-access","members__comprobar-acceso":"members__check-access","kon:members:listar-miembros":"kon:members:list-members","members:listar-miembros":"members:list-members","members__listar-miembros":"members__list-members","kon:members:ver-miembro":"kon:members:get-member","members:ver-miembro":"members:get-member","members__ver-miembro":"members__get-member","kon:members:crear-plan":"kon:members:create-plan","members:crear-plan":"members:create-plan","members__crear-plan":"members__create-plan","kon:members:regalar-acceso":"kon:members:gift-access","members:regalar-acceso":"members:gift-access","members__regalar-acceso":"members__gift-access","kon:members:retirar-acceso":"kon:members:revoke-access","members:retirar-acceso":"members:revoke-access","members__retirar-acceso":"members__revoke-access"}'::jsonb;
  ops jsonb := '{"listar-planes":"list-plans","pedir-enlace-de-acceso":"request-access-link","verificar-enlace-de-acceso":"verify-access-link","ver-lector":"get-reader","cerrar-sesion-lector":"sign-out-reader","comprobar-acceso":"check-access","listar-miembros":"list-members","ver-miembro":"get-member","crear-plan":"create-plan","regalar-acceso":"gift-access","retirar-acceso":"revoke-access"}'::jsonb;
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
