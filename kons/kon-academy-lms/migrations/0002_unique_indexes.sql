-- Academy: the unique indexes that the `ON CONFLICT` clauses rely on
-- ============================================================================
-- Idempotent.
--
-- Audit 2026-10-15. Several routes do `INSERT … ON CONFLICT (user_id,
-- curso_id)` (certificates) or `(user_id, tema_id)` (feedback, topic
-- progress). Postgres requires an EXACT unique index for that, and:
--
--   · `certificados (user_id, curso_id)` was created by nobody: `GET
--     /certificados/:cursoId` ALWAYS failed with a 500.
--   · The rest lives in `apps/api/src/db/migrations/0023_academy_indexes.sql`,
--     a CORE migration that runs BEFORE the kon migrations: on a clean
--     install the tables do not exist yet, its guards skip, and the indexes
--     are never created.
--
-- A unique index also prevents duplicate certificates or progress rows for
-- the same person. If duplicates already exist, the index is not created and
-- a NOTICE is raised instead of aborting the migration chain.

DO $$
DECLARE
  idx RECORD;
BEGIN
  FOR idx IN
    SELECT * FROM (VALUES
      ('certificados_usuario_curso', 'certificados', 'user_id, curso_id'),
      ('fb_usr_tem',                 'feedback', 'user_id, tema_id'),
      ('pr_usr_tem_prog',            'progreso_temas', 'user_id, tema_id'),
      ('pr_usr_cur',                 'progreso_cursos', 'user_id, curso_id'),
      ('gu_pk',                      'grupo_usuarios', 'grupo_id, user_id'),
      ('gs_pk',                      'grupo_supervisores', 'grupo_id, supervisor_id'),
      ('lp_usr',                     'progreso_learning_paths', 'user_id, learning_path_id'),
      ('lp_cur',                     'learning_path_cursos', 'learning_path_id, curso_id')
    ) AS t(nombre, tabla, columnas)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = idx.tabla
    ) THEN
      BEGIN
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (%s)',
          idx.nombre, idx.tabla, idx.columnas);
      EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'academy: % tiene duplicados en (%); índice % sin crear',
          idx.tabla, idx.columnas, idx.nombre;
      END;
    END IF;
  END LOOP;
END $$;
