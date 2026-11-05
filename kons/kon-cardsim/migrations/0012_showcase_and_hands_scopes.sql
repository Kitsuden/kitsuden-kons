-- 0012 — The showcase and the hand generator are part of kon-cardsim (2026-11-06)
-- ============================================================================
-- Idempotent. Tables that do not exist are skipped.
--
-- DeckShow (/api/deckshow) and HandLab (/api/handlab) were kons of their own; their routes now
-- live below /api/cardsim/showcase and /api/cardsim/hands, their operations are cardsim's and
-- their migrations are this folder's 0008-0011 (history.json adopts the rows that existing
-- databases recorded as kon-deckshow/… and kon-handlab/…). Tables and policy resources keep
-- their names (deckshow_*, handlab_*; "deckshow", "handlab", "handlab-deck"). What changes in
-- the database is what NAMES the old kons.
--
-- ── 1. Row security ─────────────────────────────────────────────────────────
--
-- No policy of the shipped chain names the old kons in an agent function: deckshow_entries,
-- deckshow_likes, handlab_datasets and handlab_cards have no row security (public gallery and
-- editorial catalogs; who edits them is the application policy), and handlab_decks only has
-- the core's owner isolation (rls-owned-tables.sql), which names no kon. There is nothing to
-- recreate. A database with a hand-made policy that does name them is reported here, not
-- guessed at: recreate it naming 'cardsim', with the same resource scopes.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('deckshow_entries', 'deckshow_likes', 'handlab_datasets', 'handlab_cards', 'handlab_decks')
      AND (coalesce(qual, '') ~ '''(deckshow|handlab)''' OR coalesce(with_check, '') ~ '''(deckshow|handlab)'''
           OR coalesce(qual, '') ~ '(deckshow|handlab)_agent' OR coalesce(with_check, '') ~ '(deckshow|handlab)_agent')
  LOOP
    RAISE WARNING 'kon-cardsim: policy % on % names the old kon; recreate it naming ''cardsim''', r.policyname, r.tablename;
  END LOOP;
END $$;

-- ── 2. Stored agent permissions ─────────────────────────────────────────────
--
-- Scopes and tool names of the moved operations: agents, OAuth grants and pending approvals keep
-- working. kon:deckshow:<op> and kon:handlab:<op> become kon:cardsim:<op>, their aliases
-- deckshow:<op>/handlab:<op> become cardsim:<op> and the MCP tools deckshow__<op>/handlab__<op>
-- become cardsim__<op>, with the ids that collided prefixed (showcase-…, hands-…).
--
-- A grant is never WIDENED: the broad deckshow:*, kon:deckshow:*, handlab:* and kon:handlab:*
-- become the list of the fine kon:cardsim:<op> scopes of the operations they used to open, not
-- cardsim:* (which also opens the simulator). A denial keeps its "!" and is mapped the same way.
-- Resource scopes of the policies (deckshow:create, handlab:update, handlab-deck:create…) are not
-- operation ids and are left as they are: the policies keep their names. An entry the expansion
-- repeats is kept once. Rows without an old name are not touched.
DO $$
DECLARE
  m jsonb := '{"kon:deckshow:list-games":"kon:cardsim:showcase-list-games","deckshow:list-games":"cardsim:showcase-list-games","deckshow__list-games":"cardsim__showcase-list-games","kon:deckshow:search-cards":"kon:cardsim:showcase-search-cards","deckshow:search-cards":"cardsim:showcase-search-cards","deckshow__search-cards":"cardsim__showcase-search-cards","kon:deckshow:validate-deck":"kon:cardsim:showcase-validate-deck","deckshow:validate-deck":"cardsim:showcase-validate-deck","deckshow__validate-deck":"cardsim__showcase-validate-deck","kon:deckshow:deal-hands":"kon:cardsim:showcase-deal-hands","deckshow:deal-hands":"cardsim:showcase-deal-hands","deckshow__deal-hands":"cardsim__showcase-deal-hands","kon:deckshow:simulate-goldfish":"kon:cardsim:showcase-simulate-goldfish","deckshow:simulate-goldfish":"cardsim:showcase-simulate-goldfish","deckshow__simulate-goldfish":"cardsim__showcase-simulate-goldfish","kon:deckshow:save-deck":"kon:cardsim:showcase-save-deck","deckshow:save-deck":"cardsim:showcase-save-deck","deckshow__save-deck":"cardsim__showcase-save-deck","kon:deckshow:list-posts":"kon:cardsim:list-posts","deckshow:list-posts":"cardsim:list-posts","deckshow__list-posts":"cardsim__list-posts","kon:deckshow:get-post":"kon:cardsim:get-post","deckshow:get-post":"cardsim:get-post","deckshow__get-post":"cardsim__get-post","kon:deckshow:publish-post":"kon:cardsim:publish-post","deckshow:publish-post":"cardsim:publish-post","deckshow__publish-post":"cardsim__publish-post","kon:deckshow:update-post":"kon:cardsim:update-post","deckshow:update-post":"cardsim:update-post","deckshow__update-post":"cardsim__update-post","kon:deckshow:delete-post":"kon:cardsim:delete-post","deckshow:delete-post":"cardsim:delete-post","deckshow__delete-post":"cardsim__delete-post","kon:deckshow:like":"kon:cardsim:like","deckshow:like":"cardsim:like","deckshow__like":"cardsim__like","kon:deckshow:unlike":"kon:cardsim:unlike","deckshow:unlike":"cardsim:unlike","deckshow__unlike":"cardsim__unlike","kon:deckshow:moderate-post":"kon:cardsim:moderate-post","deckshow:moderate-post":"cardsim:moderate-post","deckshow__moderate-post":"cardsim__moderate-post","kon:handlab:list-datasets":"kon:cardsim:list-datasets","handlab:list-datasets":"cardsim:list-datasets","handlab__list-datasets":"cardsim__list-datasets","kon:handlab:get-dataset":"kon:cardsim:get-dataset","handlab:get-dataset":"cardsim:get-dataset","handlab__get-dataset":"cardsim__get-dataset","kon:handlab:import-dataset":"kon:cardsim:import-dataset","handlab:import-dataset":"cardsim:import-dataset","handlab__import-dataset":"cardsim__import-dataset","kon:handlab:create-dataset":"kon:cardsim:create-dataset","handlab:create-dataset":"cardsim:create-dataset","handlab__create-dataset":"cardsim__create-dataset","kon:handlab:upload-cards":"kon:cardsim:upload-cards","handlab:upload-cards":"cardsim:upload-cards","handlab__upload-cards":"cardsim__upload-cards","kon:handlab:search-cards":"kon:cardsim:hands-search-cards","handlab:search-cards":"cardsim:hands-search-cards","handlab__search-cards":"cardsim__hands-search-cards","kon:handlab:delete-dataset":"kon:cardsim:delete-dataset","handlab:delete-dataset":"cardsim:delete-dataset","handlab__delete-dataset":"cardsim__delete-dataset","kon:handlab:list-my-decks":"kon:cardsim:hands-list-my-decks","handlab:list-my-decks":"cardsim:hands-list-my-decks","handlab__list-my-decks":"cardsim__hands-list-my-decks","kon:handlab:save-deck":"kon:cardsim:hands-save-deck","handlab:save-deck":"cardsim:hands-save-deck","handlab__save-deck":"cardsim__hands-save-deck","kon:handlab:random-deck":"kon:cardsim:random-deck","handlab:random-deck":"cardsim:random-deck","handlab__random-deck":"cardsim__random-deck","kon:handlab:validate-deck":"kon:cardsim:hands-validate-deck","handlab:validate-deck":"cardsim:hands-validate-deck","handlab__validate-deck":"cardsim__hands-validate-deck","kon:handlab:deal-hands":"kon:cardsim:hands-deal-hands","handlab:deal-hands":"cardsim:hands-deal-hands","handlab__deal-hands":"cardsim__hands-deal-hands","kon:handlab:simulate-goldfish":"kon:cardsim:hands-simulate-goldfish","handlab:simulate-goldfish":"cardsim:hands-simulate-goldfish","handlab__simulate-goldfish":"cardsim__hands-simulate-goldfish"}'::jsonb;
  wide jsonb := '{"deckshow:*":["kon:cardsim:showcase-list-games","kon:cardsim:showcase-search-cards","kon:cardsim:showcase-validate-deck","kon:cardsim:showcase-deal-hands","kon:cardsim:showcase-simulate-goldfish","kon:cardsim:showcase-save-deck","kon:cardsim:list-posts","kon:cardsim:get-post","kon:cardsim:publish-post","kon:cardsim:update-post","kon:cardsim:delete-post","kon:cardsim:like","kon:cardsim:unlike","kon:cardsim:moderate-post"],"kon:deckshow:*":["kon:cardsim:showcase-list-games","kon:cardsim:showcase-search-cards","kon:cardsim:showcase-validate-deck","kon:cardsim:showcase-deal-hands","kon:cardsim:showcase-simulate-goldfish","kon:cardsim:showcase-save-deck","kon:cardsim:list-posts","kon:cardsim:get-post","kon:cardsim:publish-post","kon:cardsim:update-post","kon:cardsim:delete-post","kon:cardsim:like","kon:cardsim:unlike","kon:cardsim:moderate-post"],"handlab:*":["kon:cardsim:list-datasets","kon:cardsim:get-dataset","kon:cardsim:import-dataset","kon:cardsim:create-dataset","kon:cardsim:upload-cards","kon:cardsim:hands-search-cards","kon:cardsim:delete-dataset","kon:cardsim:hands-list-my-decks","kon:cardsim:hands-save-deck","kon:cardsim:random-deck","kon:cardsim:hands-validate-deck","kon:cardsim:hands-deal-hands","kon:cardsim:hands-simulate-goldfish"],"kon:handlab:*":["kon:cardsim:list-datasets","kon:cardsim:get-dataset","kon:cardsim:import-dataset","kon:cardsim:create-dataset","kon:cardsim:upload-cards","kon:cardsim:hands-search-cards","kon:cardsim:delete-dataset","kon:cardsim:hands-list-my-decks","kon:cardsim:hands-save-deck","kon:cardsim:random-deck","kon:cardsim:hands-validate-deck","kon:cardsim:hands-deal-hands","kon:cardsim:hands-simulate-goldfish"]}'::jsonb;
  showcase_ops jsonb := '{"list-games":"showcase-list-games","search-cards":"showcase-search-cards","validate-deck":"showcase-validate-deck","deal-hands":"showcase-deal-hands","simulate-goldfish":"showcase-simulate-goldfish","save-deck":"showcase-save-deck","list-posts":"list-posts","get-post":"get-post","publish-post":"publish-post","update-post":"update-post","delete-post":"delete-post","like":"like","unlike":"unlike","moderate-post":"moderate-post"}'::jsonb;
  hands_ops jsonb := '{"list-datasets":"list-datasets","get-dataset":"get-dataset","import-dataset":"import-dataset","create-dataset":"create-dataset","upload-cards":"upload-cards","search-cards":"hands-search-cards","delete-dataset":"delete-dataset","list-my-decks":"hands-list-my-decks","save-deck":"hands-save-deck","random-deck":"random-deck","validate-deck":"hands-validate-deck","deal-hands":"hands-deal-hands","simulate-goldfish":"hands-simulate-goldfish"}'::jsonb;
  t record;
  n integer;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('agent_identities', 'scopes'), ('agent_identities', 'allowed_tools'), ('agent_proposals', 'scopes'),
    ('oauth_authorization_requests', 'requested_scopes'), ('oauth_codes', 'scopes'), ('oauth_grants', 'scopes'), ('oauth_tokens', 'scopes')
  ) AS v(tbl, col) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t.tbl AND column_name = t.col) THEN
      EXECUTE format($f$
        UPDATE %1$I SET %2$I = (
          SELECT coalesce(jsonb_agg(d.x ORDER BY d.pos), '[]'::jsonb)
          FROM (
            SELECT l.x, min(e.ord * 1000 + l.sub) AS pos
            FROM jsonb_array_elements(%2$I) WITH ORDINALITY AS e(v, ord)
            CROSS JOIN LATERAL (
              SELECT CASE WHEN jsonb_typeof(e.v) = 'string' AND left(e.v #>> '{}', 1) = '!' THEN '!' ELSE '' END AS bang,
                     CASE WHEN jsonb_typeof(e.v) <> 'string' THEN NULL
                          WHEN left(e.v #>> '{}', 1) = '!' THEN substr(e.v #>> '{}', 2)
                          ELSE e.v #>> '{}' END AS name
            ) b
            CROSS JOIN LATERAL (
              SELECT w.ord AS sub, to_jsonb(b.bang || (w.val #>> '{}')) AS x
                FROM jsonb_array_elements(CASE WHEN b.name IS NOT NULL AND $2 ? b.name THEN $2 -> b.name ELSE '[]'::jsonb END)
                     WITH ORDINALITY AS w(val, ord)
              UNION ALL
              SELECT 0, CASE WHEN b.name IS NOT NULL AND $1 ? b.name THEN to_jsonb(b.bang || ($1 ->> b.name)) ELSE e.v END
                WHERE NOT (b.name IS NOT NULL AND $2 ? b.name)
            ) l
            GROUP BY l.x
          ) d)
        WHERE jsonb_typeof(%2$I) = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(%2$I) AS e
          WHERE jsonb_typeof(e) = 'string'
            AND ($1 ? (CASE WHEN left(e #>> '{}', 1) = '!' THEN substr(e #>> '{}', 2) ELSE e #>> '{}' END)
              OR $2 ? (CASE WHEN left(e #>> '{}', 1) = '!' THEN substr(e #>> '{}', 2) ELSE e #>> '{}' END)))
      $f$, t.tbl, t.col) USING m, wide;
    END IF;
  END LOOP;

  -- Pending approvals: besides the operation and the tool, the kon and the PATH, because an
  -- approved HTTP proposal is replayed against its path, and /api/deckshow no longer exists.
  IF to_regclass('public.agent_proposals') IS NOT NULL THEN
    UPDATE agent_proposals SET
        operation_key = coalesce(m ->> operation_key, operation_key),
        tool = coalesce(m ->> tool, tool),
        operation_id = coalesce(showcase_ops ->> operation_id, operation_id),
        kon_id = CASE kon_id WHEN 'kon-deckshow' THEN 'kon-cardsim' WHEN 'deckshow' THEN 'cardsim' ELSE kon_id END,
        path = CASE WHEN path = '/api/deckshow' OR left(path, 14) IN ('/api/deckshow/', '/api/deckshow?')
                    THEN '/api/cardsim/showcase' || substr(path, 14) ELSE path END
      WHERE status = 'pending' AND (
        left(coalesce(operation_key, ''), 13) = 'kon:deckshow:' OR left(coalesce(tool, ''), 10) = 'deckshow__'
        OR kon_id IN ('kon-deckshow', 'deckshow')
        OR path = '/api/deckshow' OR left(path, 14) IN ('/api/deckshow/', '/api/deckshow?'));
    UPDATE agent_proposals SET
        operation_key = coalesce(m ->> operation_key, operation_key),
        tool = coalesce(m ->> tool, tool),
        operation_id = coalesce(hands_ops ->> operation_id, operation_id),
        kon_id = CASE kon_id WHEN 'kon-handlab' THEN 'kon-cardsim' WHEN 'handlab' THEN 'cardsim' ELSE kon_id END,
        path = CASE WHEN path = '/api/handlab' OR left(path, 13) IN ('/api/handlab/', '/api/handlab?')
                    THEN '/api/cardsim/hands' || substr(path, 13) ELSE path END
      WHERE status = 'pending' AND (
        left(coalesce(operation_key, ''), 12) = 'kon:handlab:' OR left(coalesce(tool, ''), 9) = 'handlab__'
        OR kon_id IN ('kon-handlab', 'handlab')
        OR path = '/api/handlab' OR left(path, 13) IN ('/api/handlab/', '/api/handlab?'));
  END IF;

  -- What the merge itself opens: cardsim:* and kon:cardsim:* now also cover the moved operations.
  -- Said, not changed: adding denials to those agents would be guessing what their owner wanted.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_identities' AND column_name = 'scopes') THEN
    EXECUTE $q$SELECT count(*) FROM agent_identities
      WHERE jsonb_typeof(scopes) = 'array' AND (scopes ? 'cardsim:*' OR scopes ? 'kon:cardsim:*')$q$ INTO n;
    IF n > 0 THEN
      RAISE NOTICE 'kon-cardsim: % agent(s) with cardsim:* or kon:cardsim:* now also reach the showcase and the hand generator', n;
    END IF;
  END IF;
END $$;
