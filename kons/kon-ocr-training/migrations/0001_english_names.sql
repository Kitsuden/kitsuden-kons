-- English names for kon-ocr-training: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:ocr-training:ver-resumen":"kon:ocr-training:get-summary","ocr-training:ver-resumen":"ocr-training:get-summary","ocr-training__ver-resumen":"ocr-training__get-summary","kon:ocr-training:ver-config-de-vision":"kon:ocr-training:get-vision-config","ocr-training:ver-config-de-vision":"ocr-training:get-vision-config","ocr-training__ver-config-de-vision":"ocr-training__get-vision-config","kon:ocr-training:guardar-config-de-vision":"kon:ocr-training:save-vision-config","ocr-training:guardar-config-de-vision":"ocr-training:save-vision-config","ocr-training__guardar-config-de-vision":"ocr-training__save-vision-config","kon:ocr-training:probar-config-de-vision":"kon:ocr-training:test-vision-config","ocr-training:probar-config-de-vision":"ocr-training:test-vision-config","ocr-training__probar-config-de-vision":"ocr-training__test-vision-config","kon:ocr-training:releer-con-vision":"kon:ocr-training:reread-with-vision","ocr-training:releer-con-vision":"ocr-training:reread-with-vision","ocr-training__releer-con-vision":"ocr-training__reread-with-vision","kon:ocr-training:ver-salud":"kon:ocr-training:get-health","ocr-training:ver-salud":"ocr-training:get-health","ocr-training__ver-salud":"ocr-training__get-health"}'::jsonb;
  ops jsonb := '{"ver-resumen":"get-summary","ver-config-de-vision":"get-vision-config","guardar-config-de-vision":"save-vision-config","probar-config-de-vision":"test-vision-config","releer-con-vision":"reread-with-vision","ver-salud":"get-health"}'::jsonb;
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
