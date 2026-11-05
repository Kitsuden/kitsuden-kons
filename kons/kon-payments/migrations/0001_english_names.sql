-- English names for kon-payments: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:payments:listar-proveedores":"kon:payments:list-providers","payments:listar-proveedores":"payments:list-providers","payments__listar-proveedores":"payments__list-providers","kon:payments:crear-checkout":"kon:payments:create-checkout","payments:crear-checkout":"payments:create-checkout","payments__crear-checkout":"payments__create-checkout","kon:payments:recibir-webhook":"kon:payments:receive-webhook","payments:recibir-webhook":"payments:receive-webhook","payments__recibir-webhook":"payments__receive-webhook","kon:payments:ver-mi-suscripcion":"kon:payments:get-my-subscription","payments:ver-mi-suscripcion":"payments:get-my-subscription","payments__ver-mi-suscripcion":"payments__get-my-subscription","kon:payments:abrir-portal":"kon:payments:open-portal","payments:abrir-portal":"payments:open-portal","payments__abrir-portal":"payments__open-portal","kon:payments:cancelar-suscripcion":"kon:payments:cancel-subscription","payments:cancelar-suscripcion":"payments:cancel-subscription","payments__cancelar-suscripcion":"payments__cancel-subscription"}'::jsonb;
  ops jsonb := '{"listar-proveedores":"list-providers","crear-checkout":"create-checkout","recibir-webhook":"receive-webhook","ver-mi-suscripcion":"get-my-subscription","abrir-portal":"open-portal","cancelar-suscripcion":"cancel-subscription"}'::jsonb;
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
