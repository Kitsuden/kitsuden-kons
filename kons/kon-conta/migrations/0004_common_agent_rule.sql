-- 0004 — Conta: the CORE's agent rule instead of the copy in 0003 (2026-10-25)
-- ============================================================================
-- Idempotent: CREATE OR REPLACE.
--
-- 0003 wrote its own plpgsql copy of the scope rule (wildcards, denial wins)
-- because the core applied its functions AFTER the kons' migrations. Since the
-- phase D fixes the core applies `apps/api/src/db/agent-functions.sql` BEFORE
-- any kon migration, and the rule lives there only once. The 0003 policies do
-- not change: they still call `conta_agente_puede`, which now delegates.
--
-- Also, as in the rest of the kons: `conta:*` or `kon:conta:*` open the whole
-- kon (`kitsuden_agent_opens_kon`); a denial of the specific action
-- (`!conta:escribir`, `!shop-order:*`) still wins, `admin` included, just like
-- `isEffectiveAdmin` in conta.policy.ts.

CREATE OR REPLACE FUNCTION conta_agente_puede(p_accion text) RETURNS boolean
LANGUAGE sql STABLE AS $FN$
  SELECT kitsuden_agent_can_in_kon('conta', 'conta:' || p_accion)
$FN$;
