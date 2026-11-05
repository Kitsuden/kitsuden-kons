-- 0003 — Conta: an AGENT with a scope reaches the data the app opens to it (2026-10-25)
-- ============================================================================
-- Idempotent: CREATE OR REPLACE / DROP POLICY IF EXISTS.
--
-- The app's policy (conta.policy.ts + the engine's `can()`) grants an agent
-- `conta:ver` / `conta:escribir` / `conta:administrar` by SCOPE
-- (`conta:*`, `admin`…). The RLS only knew the human role and `conta_permisos`,
-- so an authorized agent got a 200 with an EMPTY list and, when creating,
-- a 404 (the INSERT … RETURNING returned no row). Tested over HTTP in
-- phase D: `GET /api/conta/accounts` with an `admin` agent → `{"data":[]}`.
--
-- Fix: additional PERMISSIVE policies (OR-ed with those of 0002) that read the
-- scopes the host sets in `app.agent_scopes` (only for agents, role `agent`;
-- see packages/engine/src/rls-request.ts). The rule is the one in
-- @kitsuden/shared (agent-permission.ts): union of grants, `admin` covers
-- everything and a `!pattern` denial always wins.
-- Self-contained: it does not depend on the core's functions (rls-policies.sql
-- is applied AFTER the kons' migrations).

CREATE OR REPLACE FUNCTION conta_agente_puede(p_accion text) RETURNS boolean
LANGUAGE plpgsql STABLE AS $FN$
DECLARE
  crudo text := coalesce(current_setting('app.agent_scopes', true), '');
  req text := 'conta:' || p_accion;
  s text;
  deny boolean;
  pat text;
  p text[];
  r text[];
  fijos int;
  ok boolean;
  i int;
BEGIN
  IF crudo = '' OR coalesce(current_setting('app.current_user_role', true), '') <> 'agent' THEN
    RETURN false;
  END IF;
  r := string_to_array(req, ':');
  -- Two passes: denials first (they win), then grants.
  FOREACH deny IN ARRAY ARRAY[true, false] LOOP
    FOREACH s IN ARRAY string_to_array(crudo, ',') LOOP
      CONTINUE WHEN (left(s, 1) = '!') IS DISTINCT FROM deny;
      pat := CASE WHEN deny THEN substr(s, 2) ELSE s END;
      IF NOT deny AND (pat = 'admin' OR pat = 'admin:*') THEN RETURN true; END IF;
      -- patternCovers(pat, req)
      ok := false;
      IF pat = req THEN
        ok := true;
      ELSE
        p := string_to_array(pat, ':');
        IF array_length(p, 1) >= 2 AND EXISTS (SELECT 1 FROM unnest(p) x WHERE x <> '*') THEN
          IF p[1] = '*' THEN
            ok := right(req, length(pat) - 1) = substr(pat, 2);
          ELSE
            fijos := CASE WHEN p[array_length(p, 1)] = '*' THEN array_length(p, 1) - 1 ELSE array_length(p, 1) END;
            IF (p[array_length(p, 1)] = '*' AND array_length(r, 1) > fijos)
               OR (p[array_length(p, 1)] <> '*' AND array_length(r, 1) = fijos) THEN
              ok := true;
              FOR i IN 1..fijos LOOP
                IF p[i] = '*' THEN
                  IF coalesce(r[i], '') = '' THEN ok := false; END IF;
                ELSIF p[i] IS DISTINCT FROM r[i] THEN
                  ok := false;
                END IF;
              END LOOP;
            END IF;
          END IF;
        END IF;
      END IF;
      IF ok THEN RETURN NOT deny; END IF;
    END LOOP;
  END LOOP;
  RETURN false;
END
$FN$;

DO $$
DECLARE
    t text;
    -- Reading includes whoever writes: an INSERT/UPDATE … RETURNING has to see
    -- the row it writes. What the agent may READ is decided by the app.
    lee text := 'conta_agente_puede(''ver'') OR conta_agente_puede(''escribir'') OR conta_agente_puede(''administrar'')';
    escribe text := 'conta_agente_puede(''escribir'') OR conta_agente_puede(''administrar'')';
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'conta_currencies', 'conta_accounts', 'conta_counterparties', 'conta_matters',
        'conta_journal_templates', 'conta_journals', 'conta_ledger_entries',
        'conta_disbursements'
    ] LOOP
        IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_agente_lee', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_agente_alta', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_agente_cambia', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_conta_agente_borra', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', t || '_conta_agente_lee', t, lee);
        EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', t || '_conta_agente_alta', t, escribe);
        EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', t || '_conta_agente_cambia', t, escribe, escribe);
        EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', t || '_conta_agente_borra', t, escribe);
    END LOOP;

    -- Human permissions are managed by whoever administers the accounting.
    IF to_regclass('public.conta_permisos') IS NOT NULL THEN
        EXECUTE 'DROP POLICY IF EXISTS conta_permisos_agente ON conta_permisos';
        EXECUTE 'CREATE POLICY conta_permisos_agente ON conta_permisos FOR ALL '
             || 'USING (conta_agente_puede(''administrar'')) WITH CHECK (conta_agente_puede(''administrar''))';
    END IF;
END $$;
