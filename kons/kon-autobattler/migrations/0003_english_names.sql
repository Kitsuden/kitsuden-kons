-- English names for kon-autobattler: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:autobattler:listar-sets":"kon:autobattler:list-sets","autobattler:listar-sets":"autobattler:list-sets","autobattler__listar-sets":"autobattler__list-sets","kon:autobattler:ver-set":"kon:autobattler:get-set","autobattler:ver-set":"autobattler:get-set","autobattler__ver-set":"autobattler__get-set","kon:autobattler:importar-set":"kon:autobattler:import-set","autobattler:importar-set":"autobattler:import-set","autobattler__importar-set":"autobattler__import-set","kon:autobattler:listar-comps-del-set":"kon:autobattler:list-set-comps","autobattler:listar-comps-del-set":"autobattler:list-set-comps","autobattler__listar-comps-del-set":"autobattler__list-set-comps","kon:autobattler:buscar-entidades":"kon:autobattler:search-entities","autobattler:buscar-entidades":"autobattler:search-entities","autobattler__buscar-entidades":"autobattler__search-entities","kon:autobattler:analizar-comp":"kon:autobattler:analyze-comp","autobattler:analizar-comp":"autobattler:analyze-comp","autobattler__analizar-comp":"autobattler__analyze-comp","kon:autobattler:sugerir-unidades":"kon:autobattler:suggest-units","autobattler:sugerir-unidades":"autobattler:suggest-units","autobattler__sugerir-unidades":"autobattler__suggest-units","kon:autobattler:plan-de-rasgo":"kon:autobattler:trait-plan","autobattler:plan-de-rasgo":"autobattler:trait-plan","autobattler__plan-de-rasgo":"autobattler__trait-plan","kon:autobattler:objetos-craftables":"kon:autobattler:craftable-items","autobattler:objetos-craftables":"autobattler:craftable-items","autobattler__objetos-craftables":"autobattler__craftable-items","kon:autobattler:componentes-de-objeto":"kon:autobattler:item-components","autobattler:componentes-de-objeto":"autobattler:item-components","autobattler__componentes-de-objeto":"autobattler__item-components","kon:autobattler:ver-comp":"kon:autobattler:get-comp","autobattler:ver-comp":"autobattler:get-comp","autobattler__ver-comp":"autobattler__get-comp","kon:autobattler:crear-comp":"kon:autobattler:create-comp","autobattler:crear-comp":"autobattler:create-comp","autobattler__crear-comp":"autobattler__create-comp","kon:autobattler:borrar-comp":"kon:autobattler:delete-comp","autobattler:borrar-comp":"autobattler:delete-comp","autobattler__borrar-comp":"autobattler__delete-comp","kon:autobattler:clasificar-comp":"kon:autobattler:rank-comp","autobattler:clasificar-comp":"autobattler:rank-comp","autobattler__clasificar-comp":"autobattler__rank-comp"}'::jsonb;
  ops jsonb := '{"listar-sets":"list-sets","ver-set":"get-set","importar-set":"import-set","listar-comps-del-set":"list-set-comps","buscar-entidades":"search-entities","analizar-comp":"analyze-comp","sugerir-unidades":"suggest-units","plan-de-rasgo":"trait-plan","objetos-craftables":"craftable-items","componentes-de-objeto":"item-components","ver-comp":"get-comp","crear-comp":"create-comp","borrar-comp":"delete-comp","clasificar-comp":"rank-comp"}'::jsonb;
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
