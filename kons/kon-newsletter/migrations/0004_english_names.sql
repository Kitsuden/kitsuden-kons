-- English names for kon-newsletter: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS nl_deliveries_permitir ON nl_deliveries;
DROP POLICY IF EXISTS nl_deliveries_solo_admin ON nl_deliveries;
DROP POLICY IF EXISTS nl_events_permitir ON nl_events;
DROP POLICY IF EXISTS nl_events_solo_admin ON nl_events;
DROP POLICY IF EXISTS nl_members_permitir ON nl_members;
DROP POLICY IF EXISTS nl_members_solo_admin ON nl_members;
DROP POLICY IF EXISTS nl_subscriptions_permitir ON nl_subscriptions;
DROP POLICY IF EXISTS nl_subscriptions_solo_admin ON nl_subscriptions;
DROP POLICY IF EXISTS nl_suppressions_permitir ON nl_suppressions;
DROP POLICY IF EXISTS nl_suppressions_solo_admin ON nl_suppressions;

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:newsletter:suscribirse":"kon:newsletter:subscribe","newsletter:suscribirse":"newsletter:subscribe","newsletter__suscribirse":"newsletter__subscribe","kon:newsletter:confirmar-suscripcion":"kon:newsletter:confirm-subscription","newsletter:confirmar-suscripcion":"newsletter:confirm-subscription","newsletter__confirmar-suscripcion":"newsletter__confirm-subscription","kon:newsletter:darse-de-baja":"kon:newsletter:unsubscribe","newsletter:darse-de-baja":"newsletter:unsubscribe","newsletter__darse-de-baja":"newsletter__unsubscribe","kon:newsletter:darse-de-baja-un-clic":"kon:newsletter:unsubscribe-one-click","newsletter:darse-de-baja-un-clic":"newsletter:unsubscribe-one-click","newsletter__darse-de-baja-un-clic":"newsletter__unsubscribe-one-click","kon:newsletter:pixel-de-apertura":"kon:newsletter:open-pixel","newsletter:pixel-de-apertura":"newsletter:open-pixel","newsletter__pixel-de-apertura":"newsletter__open-pixel","kon:newsletter:redirigir-clic":"kon:newsletter:redirect-click","newsletter:redirigir-clic":"newsletter:redirect-click","newsletter__redirigir-clic":"newsletter__redirect-click","kon:newsletter:ver-script-del-portal":"kon:newsletter:get-portal-script","newsletter:ver-script-del-portal":"newsletter:get-portal-script","newsletter__ver-script-del-portal":"newsletter__get-portal-script","kon:newsletter:ver-pagina-del-portal":"kon:newsletter:get-portal-page","newsletter:ver-pagina-del-portal":"newsletter:get-portal-page","newsletter__ver-pagina-del-portal":"newsletter__get-portal-page","kon:newsletter:recibir-webhook":"kon:newsletter:receive-webhook","newsletter:recibir-webhook":"newsletter:receive-webhook","newsletter__recibir-webhook":"newsletter__receive-webhook","kon:newsletter:listar-newsletters":"kon:newsletter:list-newsletters","newsletter:listar-newsletters":"newsletter:list-newsletters","newsletter__listar-newsletters":"newsletter__list-newsletters","kon:newsletter:listar-miembros":"kon:newsletter:list-members","newsletter:listar-miembros":"newsletter:list-members","newsletter__listar-miembros":"newsletter__list-members","kon:newsletter:listar-supresiones":"kon:newsletter:list-suppressions","newsletter:listar-supresiones":"newsletter:list-suppressions","newsletter__listar-supresiones":"newsletter__list-suppressions","kon:newsletter:suprimir-direccion":"kon:newsletter:suppress-address","newsletter:suprimir-direccion":"newsletter:suppress-address","newsletter__suprimir-direccion":"newsletter__suppress-address","kon:newsletter:quitar-supresion":"kon:newsletter:remove-suppression","newsletter:quitar-supresion":"newsletter:remove-suppression","newsletter__quitar-supresion":"newsletter__remove-suppression","kon:newsletter:previsualizar-segmento":"kon:newsletter:preview-segment","newsletter:previsualizar-segmento":"newsletter:preview-segment","newsletter__previsualizar-segmento":"newsletter__preview-segment","kon:newsletter:listar-segmentos":"kon:newsletter:list-segments","newsletter:listar-segmentos":"newsletter:list-segments","newsletter__listar-segmentos":"newsletter__list-segments","kon:newsletter:listar-campanas":"kon:newsletter:list-campaigns","newsletter:listar-campanas":"newsletter:list-campaigns","newsletter__listar-campanas":"newsletter__list-campaigns","kon:newsletter:crear-campana":"kon:newsletter:create-campaign","newsletter:crear-campana":"newsletter:create-campaign","newsletter__crear-campana":"newsletter__create-campaign","kon:newsletter:previsualizar-campana":"kon:newsletter:preview-campaign","newsletter:previsualizar-campana":"newsletter:preview-campaign","newsletter__previsualizar-campana":"newsletter__preview-campaign","kon:newsletter:preparar-campana":"kon:newsletter:prepare-campaign","newsletter:preparar-campana":"newsletter:prepare-campaign","newsletter__preparar-campana":"newsletter__prepare-campaign","kon:newsletter:enviar-campana":"kon:newsletter:send-campaign","newsletter:enviar-campana":"newsletter:send-campaign","newsletter__enviar-campana":"newsletter__send-campaign","kon:newsletter:ver-estadisticas-de-campana":"kon:newsletter:get-campaign-stats","newsletter:ver-estadisticas-de-campana":"newsletter:get-campaign-stats","newsletter__ver-estadisticas-de-campana":"newsletter__get-campaign-stats"}'::jsonb;
  ops jsonb := '{"suscribirse":"subscribe","confirmar-suscripcion":"confirm-subscription","darse-de-baja":"unsubscribe","darse-de-baja-un-clic":"unsubscribe-one-click","pixel-de-apertura":"open-pixel","redirigir-clic":"redirect-click","ver-script-del-portal":"get-portal-script","ver-pagina-del-portal":"get-portal-page","recibir-webhook":"receive-webhook","listar-newsletters":"list-newsletters","listar-miembros":"list-members","listar-supresiones":"list-suppressions","suprimir-direccion":"suppress-address","quitar-supresion":"remove-suppression","previsualizar-segmento":"preview-segment","listar-segmentos":"list-segments","listar-campanas":"list-campaigns","crear-campana":"create-campaign","previsualizar-campana":"preview-campaign","preparar-campana":"prepare-campaign","enviar-campana":"send-campaign","ver-estadisticas-de-campana":"get-campaign-stats"}'::jsonb;
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
