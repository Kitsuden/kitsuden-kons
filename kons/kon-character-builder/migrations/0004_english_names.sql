-- English names for kon-character-builder: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS builder_builds_lectura_publica ON builder_builds;

-- Indexes.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('builder_builds_publicas_idx', 'builder_builds_public_idx')
  ) AS v(old_name, new_name) LOOP
    IF to_regclass('public.' || quote_ident(r.old_name)) IS NOT NULL AND to_regclass('public.' || quote_ident(r.new_name)) IS NULL THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Default values of new rows.
ALTER TABLE builder_builds ALTER COLUMN name SET DEFAULT 'My build';

-- Stored build JSON and link-planner ids.
UPDATE builder_builds SET build = (build - 'enlace' - 'etiqueta')
    || jsonb_strip_nulls(jsonb_build_object('link', build->'enlace', 'label', build->'etiqueta'))
  WHERE jsonb_typeof(build) = 'object' AND build ?| ARRAY['enlace', 'etiqueta'];
UPDATE builder_builds SET builder_id = 'link:' || substr(builder_id, 8) WHERE builder_id LIKE 'enlace:%';

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:character-builder:listar-definiciones":"kon:character-builder:list-definitions","character-builder:listar-definiciones":"character-builder:list-definitions","character-builder__listar-definiciones":"character-builder__list-definitions","kon:character-builder:ver-definicion":"kon:character-builder:get-definition","character-builder:ver-definicion":"character-builder:get-definition","character-builder__ver-definicion":"character-builder__get-definition","kon:character-builder:validar-definicion":"kon:character-builder:validate-definition","character-builder:validar-definicion":"character-builder:validate-definition","character-builder__validar-definicion":"character-builder__validate-definition","kon:character-builder:publicar-definicion":"kon:character-builder:publish-definition","character-builder:publicar-definicion":"character-builder:publish-definition","character-builder__publicar-definicion":"character-builder__publish-definition","kon:character-builder:calcular-build":"kon:character-builder:compute-build","character-builder:calcular-build":"character-builder:compute-build","character-builder__calcular-build":"character-builder__compute-build","kon:character-builder:abrir-codigo-de-build":"kon:character-builder:open-build-code","character-builder:abrir-codigo-de-build":"character-builder:open-build-code","character-builder__abrir-codigo-de-build":"character-builder__open-build-code","kon:character-builder:guardar-build":"kon:character-builder:save-build","character-builder:guardar-build":"character-builder:save-build","character-builder__guardar-build":"character-builder__save-build","kon:character-builder:listar-mis-builds":"kon:character-builder:list-my-builds","character-builder:listar-mis-builds":"character-builder:list-my-builds","character-builder__listar-mis-builds":"character-builder__list-my-builds","kon:character-builder:listar-builds":"kon:character-builder:list-builds","character-builder:listar-builds":"character-builder:list-builds","character-builder__listar-builds":"character-builder__list-builds","kon:character-builder:ver-build":"kon:character-builder:get-build","character-builder:ver-build":"character-builder:get-build","character-builder__ver-build":"character-builder__get-build","kon:character-builder:editar-build":"kon:character-builder:update-build","character-builder:editar-build":"character-builder:update-build","character-builder__editar-build":"character-builder__update-build","kon:character-builder:borrar-build":"kon:character-builder:delete-build","character-builder:borrar-build":"character-builder:delete-build","character-builder__borrar-build":"character-builder__delete-build","kon:character-builder:votar-build":"kon:character-builder:vote-build","character-builder:votar-build":"character-builder:vote-build","character-builder__votar-build":"character-builder__vote-build"}'::jsonb;
  ops jsonb := '{"listar-definiciones":"list-definitions","ver-definicion":"get-definition","validar-definicion":"validate-definition","publicar-definicion":"publish-definition","calcular-build":"compute-build","abrir-codigo-de-build":"open-build-code","guardar-build":"save-build","listar-mis-builds":"list-my-builds","listar-builds":"list-builds","ver-build":"get-build","editar-build":"update-build","borrar-build":"delete-build","votar-build":"vote-build"}'::jsonb;
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
