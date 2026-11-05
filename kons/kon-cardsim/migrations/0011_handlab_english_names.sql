-- English names for kon-handlab: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Default values of new rows.
ALTER TABLE handlab_decks ALTER COLUMN name SET DEFAULT 'Deck';

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:handlab:listar-datasets":"kon:handlab:list-datasets","handlab:listar-datasets":"handlab:list-datasets","handlab__listar-datasets":"handlab__list-datasets","kon:handlab:ver-dataset":"kon:handlab:get-dataset","handlab:ver-dataset":"handlab:get-dataset","handlab__ver-dataset":"handlab__get-dataset","kon:handlab:importar-dataset":"kon:handlab:import-dataset","handlab:importar-dataset":"handlab:import-dataset","handlab__importar-dataset":"handlab__import-dataset","kon:handlab:crear-dataset":"kon:handlab:create-dataset","handlab:crear-dataset":"handlab:create-dataset","handlab__crear-dataset":"handlab__create-dataset","kon:handlab:subir-cartas":"kon:handlab:upload-cards","handlab:subir-cartas":"handlab:upload-cards","handlab__subir-cartas":"handlab__upload-cards","kon:handlab:buscar-cartas":"kon:handlab:search-cards","handlab:buscar-cartas":"handlab:search-cards","handlab__buscar-cartas":"handlab__search-cards","kon:handlab:borrar-dataset":"kon:handlab:delete-dataset","handlab:borrar-dataset":"handlab:delete-dataset","handlab__borrar-dataset":"handlab__delete-dataset","kon:handlab:listar-mis-mazos":"kon:handlab:list-my-decks","handlab:listar-mis-mazos":"handlab:list-my-decks","handlab__listar-mis-mazos":"handlab__list-my-decks","kon:handlab:guardar-mazo":"kon:handlab:save-deck","handlab:guardar-mazo":"handlab:save-deck","handlab__guardar-mazo":"handlab__save-deck","kon:handlab:mazo-aleatorio":"kon:handlab:random-deck","handlab:mazo-aleatorio":"handlab:random-deck","handlab__mazo-aleatorio":"handlab__random-deck","kon:handlab:validar-mazo":"kon:handlab:validate-deck","handlab:validar-mazo":"handlab:validate-deck","handlab__validar-mazo":"handlab__validate-deck","kon:handlab:repartir-manos":"kon:handlab:deal-hands","handlab:repartir-manos":"handlab:deal-hands","handlab__repartir-manos":"handlab__deal-hands","kon:handlab:simular-goldfish":"kon:handlab:simulate-goldfish","handlab:simular-goldfish":"handlab:simulate-goldfish","handlab__simular-goldfish":"handlab__simulate-goldfish"}'::jsonb;
  ops jsonb := '{"listar-datasets":"list-datasets","ver-dataset":"get-dataset","importar-dataset":"import-dataset","crear-dataset":"create-dataset","subir-cartas":"upload-cards","buscar-cartas":"search-cards","borrar-dataset":"delete-dataset","listar-mis-mazos":"list-my-decks","guardar-mazo":"save-deck","mazo-aleatorio":"random-deck","validar-mazo":"validate-deck","repartir-manos":"deal-hands","simular-goldfish":"simulate-goldfish"}'::jsonb;
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
