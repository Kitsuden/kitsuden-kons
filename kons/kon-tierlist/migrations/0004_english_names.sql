-- English names for kon-tierlist: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS tier_lists_plantillas_lectura ON tier_lists;
DROP POLICY IF EXISTS tier_lists_plantillas_edicion ON tier_lists;

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:tierlist:listar-plantillas":"kon:tierlist:list-templates","tierlist:listar-plantillas":"tierlist:list-templates","tierlist__listar-plantillas":"tierlist__list-templates","kon:tierlist:ver-plantilla":"kon:tierlist:get-template","tierlist:ver-plantilla":"tierlist:get-template","tierlist__ver-plantilla":"tierlist__get-template","kon:tierlist:publicar-plantilla":"kon:tierlist:publish-template","tierlist:publicar-plantilla":"tierlist:publish-template","tierlist__publicar-plantilla":"tierlist__publish-template","kon:tierlist:colocar-en-plantilla":"kon:tierlist:place-in-template","tierlist:colocar-en-plantilla":"tierlist:place-in-template","tierlist__colocar-en-plantilla":"tierlist__place-in-template","kon:tierlist:anadir-elementos":"kon:tierlist:add-items","tierlist:anadir-elementos":"tierlist:add-items","tierlist__anadir-elementos":"tierlist__add-items","kon:tierlist:quitar-elemento":"kon:tierlist:remove-item","tierlist:quitar-elemento":"tierlist:remove-item","tierlist__quitar-elemento":"tierlist__remove-item","kon:tierlist:sincronizar-catalogo":"kon:tierlist:sync-catalog","tierlist:sincronizar-catalogo":"tierlist:sync-catalog","tierlist__sincronizar-catalogo":"tierlist__sync-catalog","kon:tierlist:comparar-versiones":"kon:tierlist:compare-versions","tierlist:comparar-versiones":"tierlist:compare-versions","tierlist__comparar-versiones":"tierlist__compare-versions","kon:tierlist:bifurcar-plantilla":"kon:tierlist:fork-template","tierlist:bifurcar-plantilla":"tierlist:fork-template","tierlist__bifurcar-plantilla":"tierlist__fork-template","kon:tierlist:colocar-en-mi-lista":"kon:tierlist:place-in-my-list","tierlist:colocar-en-mi-lista":"tierlist:place-in-my-list","tierlist__colocar-en-mi-lista":"tierlist__place-in-my-list","kon:tierlist:abrir-codigo":"kon:tierlist:open-code","tierlist:abrir-codigo":"tierlist:open-code","tierlist__abrir-codigo":"tierlist__open-code"}'::jsonb;
  ops jsonb := '{"listar-plantillas":"list-templates","ver-plantilla":"get-template","publicar-plantilla":"publish-template","colocar-en-plantilla":"place-in-template","anadir-elementos":"add-items","quitar-elemento":"remove-item","sincronizar-catalogo":"sync-catalog","comparar-versiones":"compare-versions","bifurcar-plantilla":"fork-template","colocar-en-mi-lista":"place-in-my-list","abrir-codigo":"open-code"}'::jsonb;
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
