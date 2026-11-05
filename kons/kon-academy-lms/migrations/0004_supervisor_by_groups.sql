-- 0004 — A supervisor only sees the learners of THEIR groups (audit 2026-10-25)
-- ============================================================================
-- `academy_gestiona()` (0003) gave any supervisor `FOR ALL` over EVERYONE's
-- personal tables: profiles, progress, quiz results, certificates,
-- surveys… `grupo_supervisores` and `supervisor_principal_id` were stored
-- and nobody looked at them. Now:
--
--   · academy administrator: everything, as before;
--   · supervisor: the rows of learners in the groups they supervise
--     (as main or additional supervisor), and the assignments to those groups;
--   · each person's own row is still granted by the owner policies.
--
-- SECURITY DEFINER functions for the same reason as `academy_gestiona()`: they
-- read profiles and groups without going through their own RLS. Idempotent.

CREATE OR REPLACE FUNCTION academy_administra() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM perfil_usuario_capacitaciones p
        WHERE p.user_id = current_setting('app.current_user_id', true)
          AND p.activo
          AND p.rol_capacitaciones::text = 'administrador'
    )
$$;

-- Does the caller supervise this group? (main or additional, active profile)
CREATE OR REPLACE FUNCTION academy_supervisa_grupo(p_grupo text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM perfil_usuario_capacitaciones p
        JOIN grupos_asignacion g ON g.id = p_grupo
        WHERE p.user_id = current_setting('app.current_user_id', true)
          AND p.activo
          AND p.rol_capacitaciones::text = 'supervisor'
          AND (
            g.supervisor_principal_id = p.id
            OR EXISTS (
              SELECT 1 FROM grupo_supervisores gs
              WHERE gs.grupo_id = g.id AND gs.supervisor_id = p.id
            )
          )
    )
$$;

-- Is this user a learner in some group the caller supervises?
CREATE OR REPLACE FUNCTION academy_supervisa_usuario(p_user text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM grupo_usuarios gu
        WHERE gu.user_id = p_user AND academy_supervisa_grupo(gu.grupo_id)
    )
$$;

-- `academy_gestiona()` stays (other pieces call it), but without the
-- supervisor's global reach over personal data.

DO $$
DECLARE
  t TEXT;
  con_usuario boolean;
  con_grupo boolean;
  condicion text;
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
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = t AND column_name = 'user_id')
      INTO con_usuario;
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = t AND column_name = 'grupo_id')
      INTO con_grupo;

    condicion := 'academy_administra()';
    IF con_usuario THEN
      condicion := condicion || ' OR (user_id IS NOT NULL AND academy_supervisa_usuario(user_id))';
    END IF;
    IF con_grupo THEN
      condicion := condicion || ' OR (grupo_id IS NOT NULL AND academy_supervisa_grupo(grupo_id))';
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_academia_gestion', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      t || '_academia_gestion', t, condicion, condicion);
  END LOOP;
END $$;
