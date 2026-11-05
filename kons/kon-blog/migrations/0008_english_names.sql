-- English names for kon-blog: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Indexes.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('blog_posts_grupo_idioma_idx', 'blog_posts_group_language_idx'),
    ('blog_posts_grupo_idx', 'blog_posts_group_idx'),
    ('blog_posts_idioma_idx', 'blog_posts_language_idx')
  ) AS v(old_name, new_name) LOOP
    IF to_regclass('public.' || quote_ident(r.old_name)) IS NOT NULL AND to_regclass('public.' || quote_ident(r.new_name)) IS NULL THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:blog:listar-entradas":"kon:blog:list-posts","blog:listar-entradas":"blog:list-posts","blog__listar-entradas":"blog__list-posts","kon:blog:obtener-por-slug":"kon:blog:get-by-slug","blog:obtener-por-slug":"blog:get-by-slug","blog__obtener-por-slug":"blog__get-by-slug","kon:blog:seo-de-entrada":"kon:blog:post-seo","blog:seo-de-entrada":"blog:post-seo","blog__seo-de-entrada":"blog__post-seo","kon:blog:geo-de-entrada":"kon:blog:post-geo","blog:geo-de-entrada":"blog:post-geo","blog__geo-de-entrada":"blog__post-geo","kon:blog:validar-seo":"kon:blog:validate-seo","blog:validar-seo":"blog:validate-seo","blog__validar-seo":"blog__validate-seo","kon:blog:validar-imagen":"kon:blog:validate-image","blog:validar-imagen":"blog:validate-image","blog__validar-imagen":"blog__validate-image","kon:blog:promover-desde-fuente":"kon:blog:promote-from-source","blog:promover-desde-fuente":"blog:promote-from-source","blog__promover-desde-fuente":"blog__promote-from-source","kon:blog:fuente-de-entrada":"kon:blog:post-source","blog:fuente-de-entrada":"blog:post-source","blog__fuente-de-entrada":"blog__post-source","kon:blog:crear-entrada":"kon:blog:create-post","blog:crear-entrada":"blog:create-post","blog__crear-entrada":"blog__create-post","kon:blog:listar-categorias":"kon:blog:list-categories","blog:listar-categorias":"blog:list-categories","blog__listar-categorias":"blog__list-categories","kon:blog:crear-categoria":"kon:blog:create-category","blog:crear-categoria":"blog:create-category","blog__crear-categoria":"blog__create-category","kon:blog:editar-categoria":"kon:blog:update-category","blog:editar-categoria":"blog:update-category","blog__editar-categoria":"blog__update-category","kon:blog:borrar-categoria":"kon:blog:delete-category","blog:borrar-categoria":"blog:delete-category","blog__borrar-categoria":"blog__delete-category","kon:blog:obtener-entrada":"kon:blog:get-post","blog:obtener-entrada":"blog:get-post","blog__obtener-entrada":"blog__get-post","kon:blog:editar-entrada":"kon:blog:update-post","blog:editar-entrada":"blog:update-post","blog__editar-entrada":"blog__update-post","kon:blog:borrar-entrada":"kon:blog:delete-post","blog:borrar-entrada":"blog:delete-post","blog__borrar-entrada":"blog__delete-post","kon:blog:publicar-entrada":"kon:blog:publish-post","blog:publicar-entrada":"blog:publish-post","blog__publicar-entrada":"blog__publish-post","kon:blog:refrescar-cache-og":"kon:blog:refresh-og-cache","blog:refrescar-cache-og":"blog:refresh-og-cache","blog__refrescar-cache-og":"blog__refresh-og-cache"}'::jsonb;
  ops jsonb := '{"listar-entradas":"list-posts","obtener-por-slug":"get-by-slug","seo-de-entrada":"post-seo","geo-de-entrada":"post-geo","validar-seo":"validate-seo","validar-imagen":"validate-image","promover-desde-fuente":"promote-from-source","fuente-de-entrada":"post-source","crear-entrada":"create-post","listar-categorias":"list-categories","crear-categoria":"create-category","editar-categoria":"update-category","borrar-categoria":"delete-category","obtener-entrada":"get-post","editar-entrada":"update-post","borrar-entrada":"delete-post","publicar-entrada":"publish-post","refrescar-cache-og":"refresh-og-cache"}'::jsonb;
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
