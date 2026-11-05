-- 0004 — Orders: an AGENT with a scope sees and operates the orders the app opens to it (2026-10-25)
-- ============================================================================
-- Idempotent: CREATE OR REPLACE / DROP POLICY IF EXISTS.
--
-- The app (shop.policy.ts + the engine's `can()`) grants an agent
-- `shop-order:view` / `shop-order:update` by SCOPE (`shop-order:*`, `admin`…),
-- but the policy from 0003 only lets through the system and the human roles
-- admin/editor: `GET /api/shop/admin/orders` with an `admin` agent returned
-- 200 with an EMPTY list (phase D, e2e test over HTTP) and changing the status of
-- an order answered 404 ("Order not found").
--
-- Fix: additional PERMISSIVE policies (OR'ed with the one from 0003) that read the
-- scopes the host sets in `app.agent_scopes` (agents only, role
-- `agent`; packages/engine/src/rls-request.ts). Same rule as
-- @kitsuden/shared (agent-permission.ts): union, `admin` covers everything and a
-- `!pattern` denial wins. CREATING orders still belongs to the system (the
-- public route uses asSystem). Self-contained: it uses no core functions
-- (rls-policies.sql is applied AFTER the kons' migrations).

CREATE OR REPLACE FUNCTION shop_agente_puede(p_req text) RETURNS boolean
LANGUAGE plpgsql STABLE AS $FN$
DECLARE
  crudo text := coalesce(current_setting('app.agent_scopes', true), '');
  req text := p_req;
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
  t TEXT;
  lee CONSTANT TEXT := $Q$(shop_agente_puede('shop-order:view') OR shop_agente_puede('shop-order:update'))$Q$;
  cambia CONSTANT TEXT := $Q$(shop_agente_puede('shop-order:update'))$Q$;
BEGIN
  FOREACH t IN ARRAY ARRAY['shop_orders', 'shop_order_items'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_agente_lee', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_agente_cambia', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO PUBLIC USING (%s)', t || '_agente_lee', t, lee);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO PUBLIC USING (%s) WITH CHECK (%s)',
      t || '_agente_cambia', t, cambia, cambia);
  END LOOP;
END $$;
