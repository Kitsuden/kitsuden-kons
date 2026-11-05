-- 0003 — Academy: who manages, in the database (2026-10-23)
-- ============================================================================
-- Idempotent: CREATE OR REPLACE / DROP POLICY IF EXISTS.
--
-- The academy's personal tables (progress, answers, results, assignments,
-- certificates, surveys, feedback, profile) are isolated by `user_id` in
-- rls-owned-tables.sql: each person sees their own rows and the GLOBAL admin
-- sees everything. But the academy has its OWN role model (academy.policy.ts):
-- an academy «administrator» or «supervisor» (who in the CMS may be an
-- ordinary `user`) manages other people's assignments, reports and profiles.
--
-- While kon routes ran without an RLS context (= system) this worked by
-- accident. Since 2026-10-23 every request to a kon runs in its own RLS
-- transaction, and without these policies:
--
--   · a supervisor would see only THEIR OWN row in the academy panel;
--   · an assignment to a GROUP (`asignaciones.user_id` NULL) would match
--     nobody, and the learner would lose the courses that reach them through their group.
--
-- `academy_gestiona()` is SECURITY DEFINER: it reads the caller's profile
-- without going through the RLS of `perfil_usuario_capacitaciones` (whose
-- policy calls this function). Same pattern as `agile_rol_en_proyecto`.

CREATE OR REPLACE FUNCTION academy_gestiona() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM perfil_usuario_capacitaciones p
        WHERE p.user_id = current_setting('app.current_user_id', true)
          AND p.activo
          AND p.rol_capacitaciones::text IN ('administrador', 'supervisor')
    )
$$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'perfil_usuario_capacitaciones', 'progreso_cursos', 'progreso_temas',
    'respuestas_usuario', 'resultados_quiz', 'progreso_learning_paths',
    'asignaciones_learning_path', 'asignaciones', 'certificados',
    'encuestas_satisfaccion', 'feedback'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_academia_gestion', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (academy_gestiona()) WITH CHECK (academy_gestiona())',
      t || '_academia_gestion', t);
  END LOOP;

  -- Assignment to a group: it belongs to nobody in particular. Anyone with a
  -- session can read it; the application joins with `grupo_usuarios` to know who it applies to.
  IF to_regclass('public.asignaciones') IS NOT NULL THEN
    DROP POLICY IF EXISTS asignaciones_de_grupo_lectura ON asignaciones;
    CREATE POLICY asignaciones_de_grupo_lectura ON asignaciones
      FOR SELECT TO PUBLIC
      USING (
        user_id IS NULL
        AND COALESCE(current_setting('app.current_user_id', true), '') <> ''
      );
  END IF;
END $$;
