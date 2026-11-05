-- 0003 — Members: "system" means empty role AND no user (2026-10-23)
-- ============================================================================
-- Idempotent: recreates the policies from 0002 with the strict condition.
--
-- 0002 let `app.current_user_role = ''` through as the system even when there was
-- an `app.current_user_id`: a session with a user and no role set saw the whole
-- mailing list. It is the bug the startup checker caught in production in the
-- newsletter (kon-newsletter/0002). Here it never fired because the kon's routes
-- ran without a context; since 2026-10-23 every request runs in its own RLS
-- transaction, and the reader portal operates as the system EXPLICITLY
-- (`ctx.db.comoSistema`), which clears id and role at the same time.

DO $$
DECLARE
  t RECORD;
  quien TEXT;
  sistema CONSTANT TEXT :=
    $Q$(COALESCE(current_setting('app.current_user_role', true), '') = ''
        AND COALESCE(current_setting('app.current_user_id', true), '') = '')$Q$;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('members',         'equipo'),
      ('member_access',   'equipo'),
      ('member_signins',  'sistema'),
      ('member_sessions', 'sistema')
    ) AS x(tabla, alcance)
  LOOP
    IF to_regclass('public.' || t.tabla) IS NULL THEN
      CONTINUE;
    END IF;

    quien := CASE t.alcance
      WHEN 'equipo' THEN
        '(' || sistema || $Q$ OR current_setting('app.current_user_role', true) IN ('admin', 'editor'))$Q$
      ELSE
        sistema
    END;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tabla);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.tabla);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tabla || '_permitir', t.tabla);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      t.tabla || '_permitir', t.tabla, quien, quien);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tabla || '_solo_' || t.alcance, t.tabla);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      t.tabla || '_solo_' || t.alcance, t.tabla, quien, quien);
  END LOOP;
END $$;
