-- 0005 — Orders: the CORE's agent rule instead of the copy in 0004 (2026-10-25)
-- ============================================================================
-- Idempotent: CREATE OR REPLACE.
--
-- 0004 wrote its own plpgsql copy of the scope rule because the
-- core applied its functions AFTER the kons' migrations. Since
-- the phase D fixes the core applies
-- `apps/api/src/db/agent-functions.sql` BEFORE any kon
-- migration. The policies from 0004 do not change: they still call
-- `shop_agente_puede`, which now delegates.
--
-- Also, `ecommerce:*` or `kon:ecommerce:*` open the whole kon
-- (`kitsuden_agent_opens_kon`), just as in shop.policy.ts.

CREATE OR REPLACE FUNCTION shop_agente_puede(p_req text) RETURNS boolean
LANGUAGE sql STABLE AS $FN$
  SELECT kitsuden_agent_can_in_kon('ecommerce', p_req)
$FN$;
