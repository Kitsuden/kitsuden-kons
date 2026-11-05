-- English names for kon-academy-lms: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS asignaciones_academia_gestion ON asignaciones;
DROP POLICY IF EXISTS asignaciones_academia_gestion ON assignments;
DROP POLICY IF EXISTS asignaciones_de_grupo_lectura ON asignaciones;
DROP POLICY IF EXISTS asignaciones_de_grupo_lectura ON assignments;
DROP POLICY IF EXISTS assignments_de_group_lectura ON assignments;
DROP POLICY IF EXISTS asignaciones_owner_isolation ON asignaciones;
DROP POLICY IF EXISTS asignaciones_owner_isolation ON assignments;
DROP POLICY IF EXISTS asignaciones_learning_path_academia_gestion ON asignaciones_learning_path;
DROP POLICY IF EXISTS asignaciones_learning_path_academia_gestion ON learning_path_assignments;
DROP POLICY IF EXISTS asignaciones_learning_path_owner_isolation ON asignaciones_learning_path;
DROP POLICY IF EXISTS asignaciones_learning_path_owner_isolation ON learning_path_assignments;
DROP POLICY IF EXISTS certificados_academia_gestion ON certificados;
DROP POLICY IF EXISTS certificados_academia_gestion ON certificates;
DROP POLICY IF EXISTS certificados_owner_isolation ON certificados;
DROP POLICY IF EXISTS certificados_owner_isolation ON certificates;
DROP POLICY IF EXISTS encuestas_satisfaccion_academia_gestion ON encuestas_satisfaccion;
DROP POLICY IF EXISTS encuestas_satisfaccion_academia_gestion ON satisfaction_surveys;
DROP POLICY IF EXISTS encuestas_satisfaccion_owner_isolation ON encuestas_satisfaccion;
DROP POLICY IF EXISTS encuestas_satisfaccion_owner_isolation ON satisfaction_surveys;
DROP POLICY IF EXISTS feedback_academia_gestion ON feedback;
DROP POLICY IF EXISTS perfil_usuario_capacitaciones_academia_gestion ON perfil_usuario_capacitaciones;
DROP POLICY IF EXISTS perfil_usuario_capacitaciones_academia_gestion ON training_user_profiles;
DROP POLICY IF EXISTS perfil_usuario_capacitaciones_owner_isolation ON perfil_usuario_capacitaciones;
DROP POLICY IF EXISTS perfil_usuario_capacitaciones_owner_isolation ON training_user_profiles;
DROP POLICY IF EXISTS progreso_cursos_academia_gestion ON progreso_cursos;
DROP POLICY IF EXISTS progreso_cursos_academia_gestion ON course_progress;
DROP POLICY IF EXISTS progreso_cursos_owner_isolation ON progreso_cursos;
DROP POLICY IF EXISTS progreso_cursos_owner_isolation ON course_progress;
DROP POLICY IF EXISTS progreso_learning_paths_academia_gestion ON progreso_learning_paths;
DROP POLICY IF EXISTS progreso_learning_paths_academia_gestion ON learning_path_progress;
DROP POLICY IF EXISTS progreso_learning_paths_owner_isolation ON progreso_learning_paths;
DROP POLICY IF EXISTS progreso_learning_paths_owner_isolation ON learning_path_progress;
DROP POLICY IF EXISTS progreso_temas_academia_gestion ON progreso_temas;
DROP POLICY IF EXISTS progreso_temas_academia_gestion ON topic_progress;
DROP POLICY IF EXISTS progreso_temas_owner_isolation ON progreso_temas;
DROP POLICY IF EXISTS progreso_temas_owner_isolation ON topic_progress;
DROP POLICY IF EXISTS respuestas_usuario_academia_gestion ON respuestas_usuario;
DROP POLICY IF EXISTS respuestas_usuario_academia_gestion ON user_answers;
DROP POLICY IF EXISTS respuestas_usuario_owner_isolation ON respuestas_usuario;
DROP POLICY IF EXISTS respuestas_usuario_owner_isolation ON user_answers;
DROP POLICY IF EXISTS resultados_quiz_academia_gestion ON resultados_quiz;
DROP POLICY IF EXISTS resultados_quiz_academia_gestion ON quiz_results;
DROP POLICY IF EXISTS resultados_quiz_owner_isolation ON resultados_quiz;
DROP POLICY IF EXISTS resultados_quiz_owner_isolation ON quiz_results;

-- Functions whose name or parameters change.
DROP FUNCTION IF EXISTS academy_administra();
DROP FUNCTION IF EXISTS academy_gestiona();
DROP FUNCTION IF EXISTS academy_supervisa_grupo(text);
DROP FUNCTION IF EXISTS academy_supervisa_usuario(text);

-- Tables.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('actividad_log', 'academy_activity_log'),
    ('archivos_adicionales', 'additional_files'),
    ('asignaciones', 'assignments'),
    ('asignaciones_learning_path', 'learning_path_assignments'),
    ('certificados', 'certificates'),
    ('cursos', 'courses'),
    ('encuestas_satisfaccion', 'satisfaction_surveys'),
    ('grupo_supervisores', 'group_supervisors'),
    ('grupo_usuarios', 'group_users'),
    ('grupos_asignacion', 'assignment_groups'),
    ('learning_path_cursos', 'learning_path_courses'),
    ('modulos', 'course_modules'),
    ('opciones', 'question_options'),
    ('perfil_usuario_capacitaciones', 'training_user_profiles'),
    ('preguntas', 'questions'),
    ('progreso_cursos', 'course_progress'),
    ('progreso_learning_paths', 'learning_path_progress'),
    ('progreso_modulos', 'module_progress'),
    ('progreso_temas', 'topic_progress'),
    ('respuestas_usuario', 'user_answers'),
    ('resultados_quiz', 'quiz_results'),
    ('temas', 'topics')
  ) AS v(old_name, new_name) LOOP
    IF to_regclass('public.' || quote_ident(r.old_name)) IS NOT NULL AND to_regclass('public.' || quote_ident(r.new_name)) IS NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Columns.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('academy_activity_log', 'tipo', 'type'),
    ('academy_activity_log', 'entidad_tipo', 'entity_type'),
    ('academy_activity_log', 'entidad_id', 'entity_id'),
    ('academy_activity_log', 'descripcion', 'description'),
    ('additional_files', 'tema_id', 'topic_id'),
    ('additional_files', 'nombre', 'name'),
    ('additional_files', 'archivo', 'file'),
    ('additional_files', 'orden', 'position'),
    ('assignments', 'curso_id', 'course_id'),
    ('assignments', 'grupo_id', 'group_id'),
    ('assignments', 'metodo', 'method'),
    ('assignments', 'asignado_por_id', 'assigned_by_id'),
    ('assignments', 'fecha', 'date'),
    ('assignments', 'notas', 'notes'),
    ('learning_path_assignments', 'asignado_por_id', 'assigned_by_id'),
    ('learning_path_assignments', 'fecha_limite', 'due_date'),
    ('learning_path_assignments', 'prioridad', 'priority'),
    ('learning_path_assignments', 'notas', 'notes'),
    ('learning_path_assignments', 'fecha', 'date'),
    ('certificates', 'curso_id', 'course_id'),
    ('certificates', 'codigo', 'code'),
    ('certificates', 'archivo', 'file'),
    ('certificates', 'fecha_generacion', 'generated_at'),
    ('certificates', 'fecha_descarga', 'downloaded_at'),
    ('certificates', 'datos_json', 'data_json'),
    ('courses', 'titulo', 'title'),
    ('courses', 'descripcion', 'description'),
    ('courses', 'fecha_inicio', 'start_date'),
    ('courses', 'fecha_fin', 'end_date'),
    ('courses', 'duracion_horas', 'duration_hours'),
    ('courses', 'portada', 'cover'),
    ('courses', 'color_portada', 'cover_color'),
    ('courses', 'tipo_curso', 'course_type'),
    ('courses', 'activo', 'active'),
    ('satisfaction_surveys', 'curso_id', 'course_id'),
    ('satisfaction_surveys', 'departamento', 'department'),
    ('satisfaction_surveys', 'cargo', 'job_title'),
    ('satisfaction_surveys', 'utilidad', 'usefulness'),
    ('satisfaction_surveys', 'satisfaccion', 'satisfaction'),
    ('satisfaction_surveys', 'aprendido', 'learned'),
    ('satisfaction_surveys', 'lugar', 'place'),
    ('satisfaction_surveys', 'rol', 'role'),
    ('satisfaction_surveys', 'comentarios_curso', 'course_comments'),
    ('satisfaction_surveys', 'fecha', 'date'),
    ('feedback', 'tema_id', 'topic_id'),
    ('feedback', 'puntuacion', 'rating'),
    ('feedback', 'comentario', 'comment'),
    ('group_supervisors', 'grupo_id', 'group_id'),
    ('group_supervisors', 'fecha_asignacion', 'assigned_at'),
    ('group_users', 'grupo_id', 'group_id'),
    ('group_users', 'fecha_asignacion', 'assigned_at'),
    ('assignment_groups', 'nombre', 'name'),
    ('assignment_groups', 'descripcion', 'description'),
    ('assignment_groups', 'activo', 'active'),
    ('learning_path_courses', 'curso_id', 'course_id'),
    ('learning_path_courses', 'orden', 'position'),
    ('learning_path_courses', 'obligatorio', 'required'),
    ('learning_path_courses', 'duracion_estimada_dias', 'estimated_days'),
    ('learning_paths', 'nombre', 'name'),
    ('learning_paths', 'descripcion', 'description'),
    ('learning_paths', 'categoria', 'category'),
    ('learning_paths', 'duracion_estimada_horas', 'estimated_hours'),
    ('learning_paths', 'imagen', 'image'),
    ('learning_paths', 'activo', 'active'),
    ('learning_paths', 'requiere_aprobacion_secuencial', 'requires_sequential_approval'),
    ('course_modules', 'curso_id', 'course_id'),
    ('course_modules', 'titulo', 'title'),
    ('course_modules', 'descripcion', 'description'),
    ('course_modules', 'orden', 'position'),
    ('course_modules', 'activo', 'active'),
    ('question_options', 'pregunta_id', 'question_id'),
    ('question_options', 'texto', 'text'),
    ('question_options', 'es_correcta', 'is_correct'),
    ('question_options', 'orden', 'position'),
    ('training_user_profiles', 'rol_capacitaciones', 'training_role'),
    ('training_user_profiles', 'activo', 'active'),
    ('training_user_profiles', 'fecha_asignacion_rol', 'role_assigned_at'),
    ('training_user_profiles', 'notas', 'notes'),
    ('questions', 'texto', 'text'),
    ('questions', 'puntaje', 'score'),
    ('questions', 'orden', 'position'),
    ('questions', 'archivo', 'file'),
    ('questions', 'activo', 'active'),
    ('questions', 'archivo_id', 'file_id'),
    ('course_progress', 'curso_id', 'course_id'),
    ('course_progress', 'completado', 'completed'),
    ('course_progress', 'fecha_completado', 'completed_at'),
    ('course_progress', 'encuesta_completada', 'survey_completed'),
    ('course_progress', 'certificado_descargado', 'certificate_downloaded'),
    ('course_progress', 'fecha_descarga_certificado', 'certificate_downloaded_at'),
    ('course_progress', 'porcentaje_progreso', 'progress_percent'),
    ('learning_path_progress', 'porcentaje_completado', 'completion_percent'),
    ('learning_path_progress', 'cursos_completados', 'completed_courses'),
    ('learning_path_progress', 'total_cursos', 'total_courses'),
    ('learning_path_progress', 'completado', 'completed'),
    ('learning_path_progress', 'fecha_completado', 'completed_at'),
    ('learning_path_progress', 'fecha_inicio', 'start_date'),
    ('learning_path_progress', 'fecha_limite', 'due_date'),
    ('module_progress', 'progreso_curso_id', 'course_progress_id'),
    ('module_progress', 'modulo_id', 'module_id'),
    ('module_progress', 'fecha_completado', 'completed_at'),
    ('topic_progress', 'tema_id', 'topic_id'),
    ('topic_progress', 'completado', 'completed'),
    ('topic_progress', 'fecha_completado', 'completed_at'),
    ('quizzes', 'modulo_id', 'module_id'),
    ('quizzes', 'titulo', 'title'),
    ('quizzes', 'instrucciones', 'instructions'),
    ('quizzes', 'portada', 'cover'),
    ('quizzes', 'puntaje_minimo_aprobacion', 'min_passing_score'),
    ('quizzes', 'tiempo_limite_minutos', 'time_limit_minutes'),
    ('quizzes', 'activo', 'active'),
    ('user_answers', 'pregunta_id', 'question_id'),
    ('user_answers', 'opcion_seleccionada_id', 'selected_option_id'),
    ('quiz_results', 'puntaje', 'score'),
    ('quiz_results', 'puntaje_porcentaje', 'score_percent'),
    ('quiz_results', 'aprobado', 'passed'),
    ('quiz_results', 'respuestas_json', 'answers_json'),
    ('quiz_results', 'fecha_realizacion', 'taken_at'),
    ('quiz_results', 'tiempo_empleado_segundos', 'time_spent_seconds'),
    ('topics', 'modulo_id', 'module_id'),
    ('topics', 'titulo', 'title'),
    ('topics', 'contenido', 'content'),
    ('topics', 'orden', 'position'),
    ('topics', 'video_externo', 'external_video'),
    ('topics', 'imagen', 'image'),
    ('topics', 'documento', 'document'),
    ('topics', 'activo', 'active'),
    ('topics', 'imagen_id', 'image_id'),
    ('topics', 'documento_id', 'document_id')
  ) AS v(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.new_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Enum types.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('academy_cargo', 'academy_job_title'),
    ('academy_departamento', 'academy_department'),
    ('academy_lugar', 'academy_place'),
    ('academy_metodo_asignacion', 'academy_assignment_method'),
    ('academy_rol_capacitaciones', 'academy_training_role'),
    ('academy_rol_encuesta', 'academy_survey_role'),
    ('academy_tipo_curso', 'academy_course_type')
  ) AS v(old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = r.old_name) AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = r.new_name) THEN
      EXECUTE format('ALTER TYPE %I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Enum values: stored rows and column defaults follow by themselves.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('academy_job_title', 'Asistente', 'Assistant'),
    ('academy_job_title', 'Analista', 'Analyst'),
    ('academy_job_title', 'Profesional', 'Professional'),
    ('academy_job_title', 'Coordinador', 'Coordinator'),
    ('academy_job_title', 'Jefe', 'Head'),
    ('academy_job_title', 'Gerente', 'Manager'),
    ('academy_department', 'CONTABILIDAD', 'ACCOUNTING'),
    ('academy_department', 'FINANZAS', 'FINANCE'),
    ('academy_department', 'GERENCIA', 'EXECUTIVE'),
    ('academy_department', 'NEGOCIOS', 'BUSINESS'),
    ('academy_department', 'OPERACIONES', 'OPERATIONS'),
    ('academy_department', 'RECURSOS_HUMANOS', 'HUMAN_RESOURCES'),
    ('academy_department', 'TECNOLOGIA', 'TECHNOLOGY'),
    ('academy_department', 'OTRO', 'OTHER'),
    ('academy_place', 'OFICINA', 'OFFICE'),
    ('academy_place', 'CASA', 'HOME'),
    ('academy_place', 'TRANSPORTE', 'TRANSIT'),
    ('academy_assignment_method', 'grupo', 'group'),
    ('academy_assignment_method', 'automatico', 'automatic'),
    ('academy_training_role', 'administrador', 'administrator'),
    ('academy_training_role', 'estudiante', 'student'),
    ('academy_survey_role', 'Participante', 'Participant'),
    ('academy_survey_role', 'Expositor', 'Speaker'),
    ('academy_survey_role', 'Organizador', 'Organizer'),
    ('academy_survey_role', 'Otro', 'Other'),
    ('academy_course_type', 'INDUCCION', 'ONBOARDING'),
    ('academy_course_type', 'GESTION', 'MANAGEMENT'),
    ('academy_course_type', 'TECNICO', 'TECHNICAL'),
    ('academy_course_type', 'HERRAMIENTAS', 'TOOLS'),
    ('academy_course_type', 'DESARROLLO', 'DEVELOPMENT')
  ) AS v(typ, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM pg_enum en JOIN pg_type ty ON ty.oid = en.enumtypid WHERE ty.typname = r.typ AND en.enumlabel = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM pg_enum en JOIN pg_type ty ON ty.oid = en.enumtypid WHERE ty.typname = r.typ AND en.enumlabel = r.new_name) THEN
      EXECUTE format('ALTER TYPE %I RENAME VALUE %L TO %L', r.typ, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Constraints.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('academy_activity_log', 'actividad_log_pkey', 'academy_activity_log_pkey'),
    ('additional_files', 'archivos_adicionales_pkey', 'additional_files_pkey'),
    ('additional_files', 'archivos_adicionales_tema_id_fkey', 'additional_files_topic_id_fkey'),
    ('assignments', 'asignaciones_curso_id_fkey', 'assignments_course_id_fkey'),
    ('assignments', 'asignaciones_grupo_id_fkey', 'assignments_group_id_fkey'),
    ('assignments', 'asignaciones_pkey', 'assignments_pkey'),
    ('learning_path_assignments', 'asignaciones_learning_path_learning_path_id_fkey', 'learning_path_assignments_learning_path_id_fkey'),
    ('learning_path_assignments', 'asignaciones_learning_path_pkey', 'learning_path_assignments_pkey'),
    ('certificates', 'certificados_codigo_key', 'certificates_code_key'),
    ('certificates', 'certificados_curso_id_fkey', 'certificates_course_id_fkey'),
    ('certificates', 'certificados_pkey', 'certificates_pkey'),
    ('courses', 'cursos_pkey', 'courses_pkey'),
    ('satisfaction_surveys', 'encuestas_satisfaccion_curso_id_fkey', 'satisfaction_surveys_course_id_fkey'),
    ('satisfaction_surveys', 'encuestas_satisfaccion_pkey', 'satisfaction_surveys_pkey'),
    ('feedback', 'feedback_tema_id_fkey', 'feedback_topic_id_fkey'),
    ('group_supervisors', 'grupo_supervisores_grupo_id_fkey', 'group_supervisors_group_id_fkey'),
    ('group_supervisors', 'grupo_supervisores_pkey', 'group_supervisors_pkey'),
    ('group_users', 'grupo_usuarios_grupo_id_fkey', 'group_users_group_id_fkey'),
    ('group_users', 'grupo_usuarios_pkey', 'group_users_pkey'),
    ('assignment_groups', 'grupos_asignacion_pkey', 'assignment_groups_pkey'),
    ('learning_path_courses', 'learning_path_cursos_curso_id_fkey', 'learning_path_courses_course_id_fkey'),
    ('learning_path_courses', 'learning_path_cursos_learning_path_id_fkey', 'learning_path_courses_learning_path_id_fkey'),
    ('learning_path_courses', 'learning_path_cursos_pkey', 'learning_path_courses_pkey'),
    ('course_modules', 'modulos_curso_id_fkey', 'course_modules_course_id_fkey'),
    ('course_modules', 'modulos_pkey', 'course_modules_pkey'),
    ('question_options', 'opciones_pkey', 'question_options_pkey'),
    ('question_options', 'opciones_pregunta_id_fkey', 'question_options_question_id_fkey'),
    ('training_user_profiles', 'perfil_usuario_capacitaciones_pkey', 'training_user_profiles_pkey'),
    ('training_user_profiles', 'perfil_usuario_capacitaciones_user_id_key', 'training_user_profiles_user_id_key'),
    ('questions', 'preguntas_pkey', 'questions_pkey'),
    ('questions', 'preguntas_quiz_id_fkey', 'questions_quiz_id_fkey'),
    ('course_progress', 'progreso_cursos_curso_id_fkey', 'course_progress_course_id_fkey'),
    ('course_progress', 'progreso_cursos_pkey', 'course_progress_pkey'),
    ('course_progress', 'progreso_cursos_user_id_curso_id_key', 'course_progress_user_id_course_id_key'),
    ('learning_path_progress', 'progreso_learning_paths_learning_path_id_fkey', 'learning_path_progress_learning_path_id_fkey'),
    ('learning_path_progress', 'progreso_learning_paths_pkey', 'learning_path_progress_pkey'),
    ('learning_path_progress', 'progreso_learning_paths_user_id_learning_path_id_key', 'learning_path_progress_user_id_learning_path_id_key'),
    ('module_progress', 'progreso_modulos_modulo_id_fkey', 'module_progress_module_id_fkey'),
    ('module_progress', 'progreso_modulos_pkey', 'module_progress_pkey'),
    ('module_progress', 'progreso_modulos_progreso_curso_id_fkey', 'module_progress_course_progress_id_fkey'),
    ('topic_progress', 'progreso_temas_pkey', 'topic_progress_pkey'),
    ('topic_progress', 'progreso_temas_tema_id_fkey', 'topic_progress_topic_id_fkey'),
    ('topic_progress', 'progreso_temas_user_id_tema_id_key', 'topic_progress_user_id_topic_id_key'),
    ('quizzes', 'quizzes_modulo_id_fkey', 'quizzes_module_id_fkey'),
    ('quizzes', 'quizzes_modulo_id_key', 'quizzes_module_id_key'),
    ('user_answers', 'respuestas_usuario_opcion_seleccionada_id_fkey', 'user_answers_selected_option_id_fkey'),
    ('user_answers', 'respuestas_usuario_pkey', 'user_answers_pkey'),
    ('user_answers', 'respuestas_usuario_pregunta_id_fkey', 'user_answers_question_id_fkey'),
    ('user_answers', 'respuestas_usuario_user_id_pregunta_id_key', 'user_answers_user_id_question_id_key'),
    ('quiz_results', 'resultados_quiz_pkey', 'quiz_results_pkey'),
    ('quiz_results', 'resultados_quiz_quiz_id_fkey', 'quiz_results_quiz_id_fkey'),
    ('topics', 'temas_modulo_id_fkey', 'topics_module_id_fkey'),
    ('topics', 'temas_pkey', 'topics_pkey')
  ) AS v(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = r.tbl AND c.conname = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = r.tbl AND c.conname = r.new_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Indexes.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('idx_asignaciones_curso', 'idx_assignments_course'),
    ('idx_asignaciones_user', 'idx_assignments_user'),
    ('certificados_usuario_curso', 'certificates_user_course'),
    ('idx_certificados_curso', 'idx_certificates_course'),
    ('idx_certificados_user', 'idx_certificates_user'),
    ('idx_cursos_activo', 'idx_courses_active'),
    ('idx_cursos_tipo', 'idx_courses_type'),
    ('idx_modulos_curso', 'idx_course_modules_course'),
    ('idx_opciones_pregunta', 'idx_question_options_question'),
    ('idx_preguntas_quiz', 'idx_questions_quiz'),
    ('idx_progreso_curso_user', 'idx_course_progress_user'),
    ('idx_progreso_tema_user', 'idx_topic_progress_user'),
    ('idx_quizzes_modulo', 'idx_quizzes_module'),
    ('idx_resultados_quiz_user', 'idx_quiz_results_user'),
    ('idx_temas_modulo', 'idx_topics_module'),
    ('pr_usr_cur', 'course_progress_user_course_idx'),
    ('fb_usr_tem', 'feedback_user_topic_idx'),
    ('lp_cur', 'learning_path_courses_path_course_idx'),
    ('lp_usr', 'learning_path_progress_user_path_idx'),
    ('pr_usr_tem_prog', 'topic_progress_user_topic_idx')
  ) AS v(old_name, new_name) LOOP
    IF to_regclass('public.' || quote_ident(r.old_name)) IS NOT NULL AND to_regclass('public.' || quote_ident(r.new_name)) IS NULL THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- JSON keys stored by earlier versions in certificates.data_json.
UPDATE certificates SET data_json = (data_json - 'nombreUsuario' - 'nombreCurso' - 'fechaCompletado' - 'duracionHoras')
    || jsonb_strip_nulls(jsonb_build_object(
         'userName', data_json->'nombreUsuario',
         'courseName', data_json->'nombreCurso',
         'completedAt', data_json->'fechaCompletado',
         'durationHours', data_json->'duracionHoras'))
  WHERE jsonb_typeof(data_json) = 'object'
    AND data_json ?| ARRAY['nombreUsuario', 'nombreCurso', 'fechaCompletado', 'duracionHoras'];

-- Stored scopes and tool names of this kon: agents, OAuth grants and pending approvals keep working.
-- A denial keeps its "!". Rows without an old name are not touched. Tables that do not exist are skipped.
DO $$
DECLARE
  m jsonb := '{"kon:academy-lms:listar-mis-cursos":"kon:academy-lms:list-my-courses","academy-lms:listar-mis-cursos":"academy-lms:list-my-courses","academy-lms__listar-mis-cursos":"academy-lms__list-my-courses","kon:academy-lms:ver-curso":"kon:academy-lms:get-course","academy-lms:ver-curso":"academy-lms:get-course","academy-lms__ver-curso":"academy-lms__get-course","kon:academy-lms:crear-curso":"kon:academy-lms:create-course","academy-lms:crear-curso":"academy-lms:create-course","academy-lms__crear-curso":"academy-lms__create-course","kon:academy-lms:ver-tema":"kon:academy-lms:get-topic","academy-lms:ver-tema":"academy-lms:get-topic","academy-lms__ver-tema":"academy-lms__get-topic","kon:academy-lms:completar-tema":"kon:academy-lms:complete-topic","academy-lms:completar-tema":"academy-lms:complete-topic","academy-lms__completar-tema":"academy-lms__complete-topic","kon:academy-lms:responder-quiz":"kon:academy-lms:answer-quiz","academy-lms:responder-quiz":"academy-lms:answer-quiz","academy-lms__responder-quiz":"academy-lms__answer-quiz","kon:academy-lms:asignar-curso":"kon:academy-lms:assign-course","academy-lms:asignar-curso":"academy-lms:assign-course","academy-lms__asignar-curso":"academy-lms__assign-course","kon:academy-lms:listar-asignaciones":"kon:academy-lms:list-assignments","academy-lms:listar-asignaciones":"academy-lms:list-assignments","academy-lms__listar-asignaciones":"academy-lms__list-assignments","kon:academy-lms:asignar-cursos-en-bloque":"kon:academy-lms:assign-courses-in-bulk","academy-lms:asignar-cursos-en-bloque":"academy-lms:assign-courses-in-bulk","academy-lms__asignar-cursos-en-bloque":"academy-lms__assign-courses-in-bulk","kon:academy-lms:listar-learning-paths":"kon:academy-lms:list-learning-paths","academy-lms:listar-learning-paths":"academy-lms:list-learning-paths","academy-lms__listar-learning-paths":"academy-lms__list-learning-paths","kon:academy-lms:listar-mis-learning-paths":"kon:academy-lms:list-my-learning-paths","academy-lms:listar-mis-learning-paths":"academy-lms:list-my-learning-paths","academy-lms__listar-mis-learning-paths":"academy-lms__list-my-learning-paths","kon:academy-lms:ver-learning-path":"kon:academy-lms:get-learning-path","academy-lms:ver-learning-path":"academy-lms:get-learning-path","academy-lms__ver-learning-path":"academy-lms__get-learning-path","kon:academy-lms:crear-learning-path":"kon:academy-lms:create-learning-path","academy-lms:crear-learning-path":"academy-lms:create-learning-path","academy-lms__crear-learning-path":"academy-lms__create-learning-path","kon:academy-lms:actualizar-learning-path":"kon:academy-lms:update-learning-path","academy-lms:actualizar-learning-path":"academy-lms:update-learning-path","academy-lms__actualizar-learning-path":"academy-lms__update-learning-path","kon:academy-lms:asignar-learning-path":"kon:academy-lms:assign-learning-path","academy-lms:asignar-learning-path":"academy-lms:assign-learning-path","academy-lms__asignar-learning-path":"academy-lms__assign-learning-path","kon:academy-lms:listar-grupos":"kon:academy-lms:list-groups","academy-lms:listar-grupos":"academy-lms:list-groups","academy-lms__listar-grupos":"academy-lms__list-groups","kon:academy-lms:crear-grupo":"kon:academy-lms:create-group","academy-lms:crear-grupo":"academy-lms:create-group","academy-lms__crear-grupo":"academy-lms__create-group","kon:academy-lms:anadir-miembros-grupo":"kon:academy-lms:add-group-members","academy-lms:anadir-miembros-grupo":"academy-lms:add-group-members","academy-lms__anadir-miembros-grupo":"academy-lms__add-group-members","kon:academy-lms:enviar-encuesta":"kon:academy-lms:submit-survey","academy-lms:enviar-encuesta":"academy-lms:submit-survey","academy-lms__enviar-encuesta":"academy-lms__submit-survey","kon:academy-lms:listar-encuestas":"kon:academy-lms:list-surveys","academy-lms:listar-encuestas":"academy-lms:list-surveys","academy-lms__listar-encuestas":"academy-lms__list-surveys","kon:academy-lms:ver-dashboard":"kon:academy-lms:get-dashboard","academy-lms:ver-dashboard":"academy-lms:get-dashboard","academy-lms__ver-dashboard":"academy-lms__get-dashboard","kon:academy-lms:ver-mi-progreso":"kon:academy-lms:get-my-progress","academy-lms:ver-mi-progreso":"academy-lms:get-my-progress","academy-lms__ver-mi-progreso":"academy-lms__get-my-progress","kon:academy-lms:obtener-certificado":"kon:academy-lms:get-certificate","academy-lms:obtener-certificado":"academy-lms:get-certificate","academy-lms__obtener-certificado":"academy-lms__get-certificate","kon:academy-lms:enviar-feedback":"kon:academy-lms:submit-feedback","academy-lms:enviar-feedback":"academy-lms:submit-feedback","academy-lms__enviar-feedback":"academy-lms__submit-feedback","kon:academy-lms:actualizar-curso":"kon:academy-lms:update-course","academy-lms:actualizar-curso":"academy-lms:update-course","academy-lms__actualizar-curso":"academy-lms__update-course","kon:academy-lms:desactivar-curso":"kon:academy-lms:deactivate-course","academy-lms:desactivar-curso":"academy-lms:deactivate-course","academy-lms__desactivar-curso":"academy-lms__deactivate-course","kon:academy-lms:ver-estadisticas-curso":"kon:academy-lms:get-course-stats","academy-lms:ver-estadisticas-curso":"academy-lms:get-course-stats","academy-lms__ver-estadisticas-curso":"academy-lms__get-course-stats","kon:academy-lms:listar-modulos-curso":"kon:academy-lms:list-course-modules","academy-lms:listar-modulos-curso":"academy-lms:list-course-modules","academy-lms__listar-modulos-curso":"academy-lms__list-course-modules","kon:academy-lms:ver-modulo":"kon:academy-lms:get-module","academy-lms:ver-modulo":"academy-lms:get-module","academy-lms__ver-modulo":"academy-lms__get-module","kon:academy-lms:crear-modulo":"kon:academy-lms:create-module","academy-lms:crear-modulo":"academy-lms:create-module","academy-lms__crear-modulo":"academy-lms__create-module","kon:academy-lms:actualizar-modulo":"kon:academy-lms:update-module","academy-lms:actualizar-modulo":"academy-lms:update-module","academy-lms__actualizar-modulo":"academy-lms__update-module","kon:academy-lms:borrar-modulo":"kon:academy-lms:delete-module","academy-lms:borrar-modulo":"academy-lms:delete-module","academy-lms__borrar-modulo":"academy-lms__delete-module","kon:academy-lms:reordenar-modulos":"kon:academy-lms:reorder-modules","academy-lms:reordenar-modulos":"academy-lms:reorder-modules","academy-lms__reordenar-modulos":"academy-lms__reorder-modules","kon:academy-lms:crear-tema":"kon:academy-lms:create-topic","academy-lms:crear-tema":"academy-lms:create-topic","academy-lms__crear-tema":"academy-lms__create-topic","kon:academy-lms:actualizar-tema":"kon:academy-lms:update-topic","academy-lms:actualizar-tema":"academy-lms:update-topic","academy-lms__actualizar-tema":"academy-lms__update-topic","kon:academy-lms:borrar-tema":"kon:academy-lms:delete-topic","academy-lms:borrar-tema":"academy-lms:delete-topic","academy-lms__borrar-tema":"academy-lms__delete-topic","kon:academy-lms:reordenar-temas":"kon:academy-lms:reorder-topics","academy-lms:reordenar-temas":"academy-lms:reorder-topics","academy-lms__reordenar-temas":"academy-lms__reorder-topics","kon:academy-lms:anadir-archivo-tema":"kon:academy-lms:add-topic-file","academy-lms:anadir-archivo-tema":"academy-lms:add-topic-file","academy-lms__anadir-archivo-tema":"academy-lms__add-topic-file","kon:academy-lms:borrar-archivo":"kon:academy-lms:delete-file","academy-lms:borrar-archivo":"academy-lms:delete-file","academy-lms__borrar-archivo":"academy-lms__delete-file","kon:academy-lms:ver-quiz":"kon:academy-lms:get-quiz","academy-lms:ver-quiz":"academy-lms:get-quiz","academy-lms__ver-quiz":"academy-lms__get-quiz","kon:academy-lms:crear-quiz":"kon:academy-lms:create-quiz","academy-lms:crear-quiz":"academy-lms:create-quiz","academy-lms__crear-quiz":"academy-lms__create-quiz","kon:academy-lms:actualizar-quiz":"kon:academy-lms:update-quiz","academy-lms:actualizar-quiz":"academy-lms:update-quiz","academy-lms__actualizar-quiz":"academy-lms__update-quiz","kon:academy-lms:borrar-quiz":"kon:academy-lms:delete-quiz","academy-lms:borrar-quiz":"academy-lms:delete-quiz","academy-lms__borrar-quiz":"academy-lms__delete-quiz","kon:academy-lms:crear-pregunta":"kon:academy-lms:create-question","academy-lms:crear-pregunta":"academy-lms:create-question","academy-lms__crear-pregunta":"academy-lms__create-question","kon:academy-lms:actualizar-pregunta":"kon:academy-lms:update-question","academy-lms:actualizar-pregunta":"academy-lms:update-question","academy-lms__actualizar-pregunta":"academy-lms__update-question","kon:academy-lms:borrar-pregunta":"kon:academy-lms:delete-question","academy-lms:borrar-pregunta":"academy-lms:delete-question","academy-lms__borrar-pregunta":"academy-lms__delete-question","kon:academy-lms:crear-opcion":"kon:academy-lms:create-option","academy-lms:crear-opcion":"academy-lms:create-option","academy-lms__crear-opcion":"academy-lms__create-option","kon:academy-lms:actualizar-opcion":"kon:academy-lms:update-option","academy-lms:actualizar-opcion":"academy-lms:update-option","academy-lms__actualizar-opcion":"academy-lms__update-option","kon:academy-lms:borrar-opcion":"kon:academy-lms:delete-option","academy-lms:borrar-opcion":"academy-lms:delete-option","academy-lms__borrar-opcion":"academy-lms__delete-option","kon:academy-lms:ver-grupo":"kon:academy-lms:get-group","academy-lms:ver-grupo":"academy-lms:get-group","academy-lms__ver-grupo":"academy-lms__get-group","kon:academy-lms:actualizar-grupo":"kon:academy-lms:update-group","academy-lms:actualizar-grupo":"academy-lms:update-group","academy-lms__actualizar-grupo":"academy-lms__update-group","kon:academy-lms:borrar-grupo":"kon:academy-lms:delete-group","academy-lms:borrar-grupo":"academy-lms:delete-group","academy-lms__borrar-grupo":"academy-lms__delete-group","kon:academy-lms:quitar-miembro-grupo":"kon:academy-lms:remove-group-member","academy-lms:quitar-miembro-grupo":"academy-lms:remove-group-member","academy-lms__quitar-miembro-grupo":"academy-lms__remove-group-member","kon:academy-lms:anadir-supervisor-grupo":"kon:academy-lms:add-group-supervisor","academy-lms:anadir-supervisor-grupo":"academy-lms:add-group-supervisor","academy-lms__anadir-supervisor-grupo":"academy-lms__add-group-supervisor","kon:academy-lms:quitar-supervisor-grupo":"kon:academy-lms:remove-group-supervisor","academy-lms:quitar-supervisor-grupo":"academy-lms:remove-group-supervisor","academy-lms__quitar-supervisor-grupo":"academy-lms__remove-group-supervisor","kon:academy-lms:ver-asignacion":"kon:academy-lms:get-assignment","academy-lms:ver-asignacion":"academy-lms:get-assignment","academy-lms__ver-asignacion":"academy-lms__get-assignment","kon:academy-lms:actualizar-asignacion":"kon:academy-lms:update-assignment","academy-lms:actualizar-asignacion":"academy-lms:update-assignment","academy-lms__actualizar-asignacion":"academy-lms__update-assignment","kon:academy-lms:borrar-asignacion":"kon:academy-lms:delete-assignment","academy-lms:borrar-asignacion":"academy-lms:delete-assignment","academy-lms__borrar-asignacion":"academy-lms__delete-assignment","kon:academy-lms:desactivar-learning-path":"kon:academy-lms:deactivate-learning-path","academy-lms:desactivar-learning-path":"academy-lms:deactivate-learning-path","academy-lms__desactivar-learning-path":"academy-lms__deactivate-learning-path","kon:academy-lms:anadir-curso-learning-path":"kon:academy-lms:add-learning-path-course","academy-lms:anadir-curso-learning-path":"academy-lms:add-learning-path-course","academy-lms__anadir-curso-learning-path":"academy-lms__add-learning-path-course","kon:academy-lms:actualizar-curso-learning-path":"kon:academy-lms:update-learning-path-course","academy-lms:actualizar-curso-learning-path":"academy-lms:update-learning-path-course","academy-lms__actualizar-curso-learning-path":"academy-lms__update-learning-path-course","kon:academy-lms:quitar-curso-learning-path":"kon:academy-lms:remove-learning-path-course","academy-lms:quitar-curso-learning-path":"academy-lms:remove-learning-path-course","academy-lms__quitar-curso-learning-path":"academy-lms__remove-learning-path-course","kon:academy-lms:ver-estadisticas-learning-path":"kon:academy-lms:get-learning-path-stats","academy-lms:ver-estadisticas-learning-path":"academy-lms:get-learning-path-stats","academy-lms__ver-estadisticas-learning-path":"academy-lms__get-learning-path-stats","kon:academy-lms:ver-estadisticas-encuestas":"kon:academy-lms:get-survey-stats","academy-lms:ver-estadisticas-encuestas":"academy-lms:get-survey-stats","academy-lms__ver-estadisticas-encuestas":"academy-lms__get-survey-stats","kon:academy-lms:ver-encuesta":"kon:academy-lms:get-survey","academy-lms:ver-encuesta":"academy-lms:get-survey","academy-lms__ver-encuesta":"academy-lms__get-survey","kon:academy-lms:informe-cursos":"kon:academy-lms:courses-report","academy-lms:informe-cursos":"academy-lms:courses-report","academy-lms__informe-cursos":"academy-lms__courses-report","kon:academy-lms:informe-usuario":"kon:academy-lms:user-report","academy-lms:informe-usuario":"academy-lms:user-report","academy-lms__informe-usuario":"academy-lms__user-report","kon:academy-lms:informe-progreso":"kon:academy-lms:progress-report","academy-lms:informe-progreso":"academy-lms:progress-report","academy-lms__informe-progreso":"academy-lms__progress-report","kon:academy-lms:listar-perfiles":"kon:academy-lms:list-profiles","academy-lms:listar-perfiles":"academy-lms:list-profiles","academy-lms__listar-perfiles":"academy-lms__list-profiles","kon:academy-lms:crear-perfil":"kon:academy-lms:create-profile","academy-lms:crear-perfil":"academy-lms:create-profile","academy-lms__crear-perfil":"academy-lms__create-profile","kon:academy-lms:cambiar-rol-perfil":"kon:academy-lms:change-profile-role","academy-lms:cambiar-rol-perfil":"academy-lms:change-profile-role","academy-lms__cambiar-rol-perfil":"academy-lms__change-profile-role","kon:academy-lms:descargar-certificado-pdf":"kon:academy-lms:download-certificate-pdf","academy-lms:descargar-certificado-pdf":"academy-lms:download-certificate-pdf","academy-lms__descargar-certificado-pdf":"academy-lms__download-certificate-pdf","kon:academy-lms:verificar-certificado":"kon:academy-lms:verify-certificate","academy-lms:verificar-certificado":"academy-lms:verify-certificate","academy-lms__verificar-certificado":"academy-lms__verify-certificate","kon:academy-lms:exportar-asignaciones":"kon:academy-lms:export-assignments","academy-lms:exportar-asignaciones":"academy-lms:export-assignments","academy-lms__exportar-asignaciones":"academy-lms__export-assignments","kon:academy-lms:exportar-progreso":"kon:academy-lms:export-progress","academy-lms:exportar-progreso":"academy-lms:export-progress","academy-lms__exportar-progreso":"academy-lms__export-progress","kon:academy-lms:exportar-encuestas":"kon:academy-lms:export-surveys","academy-lms:exportar-encuestas":"academy-lms:export-surveys","academy-lms__exportar-encuestas":"academy-lms__export-surveys","kon:academy-lms:sincronizar-usuarios":"kon:academy-lms:sync-users","academy-lms:sincronizar-usuarios":"academy-lms:sync-users","academy-lms__sincronizar-usuarios":"academy-lms__sync-users","kon:academy-lms:sincronizar-usuarios-csv":"kon:academy-lms:sync-users-csv","academy-lms:sincronizar-usuarios-csv":"academy-lms:sync-users-csv","academy-lms__sincronizar-usuarios-csv":"academy-lms__sync-users-csv","kon:academy-lms:ver-mapeo-roles":"kon:academy-lms:get-role-mapping","academy-lms:ver-mapeo-roles":"academy-lms:get-role-mapping","academy-lms__ver-mapeo-roles":"academy-lms__get-role-mapping","kon:academy-lms:validar-archivo":"kon:academy-lms:validate-file","academy-lms:validar-archivo":"academy-lms:validate-file","academy-lms__validar-archivo":"academy-lms__validate-file","kon:academy-lms:info-video-youtube":"kon:academy-lms:youtube-video-info","academy-lms:info-video-youtube":"academy-lms:youtube-video-info","academy-lms__info-video-youtube":"academy-lms__youtube-video-info","kon:academy-lms:normalizar-url-video":"kon:academy-lms:normalize-video-url","academy-lms:normalizar-url-video":"academy-lms:normalize-video-url","academy-lms__normalizar-url-video":"academy-lms__normalize-video-url"}'::jsonb;
  ops jsonb := '{"listar-mis-cursos":"list-my-courses","ver-curso":"get-course","crear-curso":"create-course","ver-tema":"get-topic","completar-tema":"complete-topic","responder-quiz":"answer-quiz","asignar-curso":"assign-course","listar-asignaciones":"list-assignments","asignar-cursos-en-bloque":"assign-courses-in-bulk","listar-learning-paths":"list-learning-paths","listar-mis-learning-paths":"list-my-learning-paths","ver-learning-path":"get-learning-path","crear-learning-path":"create-learning-path","actualizar-learning-path":"update-learning-path","asignar-learning-path":"assign-learning-path","listar-grupos":"list-groups","crear-grupo":"create-group","anadir-miembros-grupo":"add-group-members","enviar-encuesta":"submit-survey","listar-encuestas":"list-surveys","ver-dashboard":"get-dashboard","ver-mi-progreso":"get-my-progress","obtener-certificado":"get-certificate","enviar-feedback":"submit-feedback","actualizar-curso":"update-course","desactivar-curso":"deactivate-course","ver-estadisticas-curso":"get-course-stats","listar-modulos-curso":"list-course-modules","ver-modulo":"get-module","crear-modulo":"create-module","actualizar-modulo":"update-module","borrar-modulo":"delete-module","reordenar-modulos":"reorder-modules","crear-tema":"create-topic","actualizar-tema":"update-topic","borrar-tema":"delete-topic","reordenar-temas":"reorder-topics","anadir-archivo-tema":"add-topic-file","borrar-archivo":"delete-file","ver-quiz":"get-quiz","crear-quiz":"create-quiz","actualizar-quiz":"update-quiz","borrar-quiz":"delete-quiz","crear-pregunta":"create-question","actualizar-pregunta":"update-question","borrar-pregunta":"delete-question","crear-opcion":"create-option","actualizar-opcion":"update-option","borrar-opcion":"delete-option","ver-grupo":"get-group","actualizar-grupo":"update-group","borrar-grupo":"delete-group","quitar-miembro-grupo":"remove-group-member","anadir-supervisor-grupo":"add-group-supervisor","quitar-supervisor-grupo":"remove-group-supervisor","ver-asignacion":"get-assignment","actualizar-asignacion":"update-assignment","borrar-asignacion":"delete-assignment","desactivar-learning-path":"deactivate-learning-path","anadir-curso-learning-path":"add-learning-path-course","actualizar-curso-learning-path":"update-learning-path-course","quitar-curso-learning-path":"remove-learning-path-course","ver-estadisticas-learning-path":"get-learning-path-stats","ver-estadisticas-encuestas":"get-survey-stats","ver-encuesta":"get-survey","informe-cursos":"courses-report","informe-usuario":"user-report","informe-progreso":"progress-report","listar-perfiles":"list-profiles","crear-perfil":"create-profile","cambiar-rol-perfil":"change-profile-role","descargar-certificado-pdf":"download-certificate-pdf","verificar-certificado":"verify-certificate","exportar-asignaciones":"export-assignments","exportar-progreso":"export-progress","exportar-encuestas":"export-surveys","sincronizar-usuarios":"sync-users","sincronizar-usuarios-csv":"sync-users-csv","ver-mapeo-roles":"get-role-mapping","validar-archivo":"validate-file","info-video-youtube":"youtube-video-info","normalizar-url-video":"normalize-video-url"}'::jsonb;
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
