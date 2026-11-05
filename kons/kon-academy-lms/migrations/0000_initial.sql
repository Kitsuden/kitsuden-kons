-- Academy LMS - Initial Migration
-- Creates tables and enums, checking whether they already exist

-- ============================================================
-- ENUMS
-- ============================================================

DO $$
BEGIN
    -- Training roles
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'academy_rol_capacitaciones') THEN
        CREATE TYPE academy_rol_capacitaciones AS ENUM (
            'administrador',
            'supervisor',
            'estudiante'
        );
    END IF;

    -- Course types
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'academy_tipo_curso') THEN
        CREATE TYPE academy_tipo_curso AS ENUM (
            'INDUCCION',
            'GESTION',
            'TECNICO',
            'HERRAMIENTAS',
            'DESARROLLO'
        );
    END IF;

    -- Assignment methods
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'academy_metodo_asignacion') THEN
        CREATE TYPE academy_metodo_asignacion AS ENUM (
            'manual',
            'grupo',
            'automatico'
        );
    END IF;

    -- Departments (used in surveys)
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'academy_departamento') THEN
        CREATE TYPE academy_departamento AS ENUM (
            'CONTABILIDAD',
            'FINANZAS',
            'GERENCIA',
            'LEGAL',
            'NEGOCIOS',
            'OPERACIONES',
            'RECURSOS_HUMANOS',
            'TECNOLOGIA',
            'OTRO'
        );
    END IF;

    -- Job titles (used in surveys)
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'academy_cargo') THEN
        CREATE TYPE academy_cargo AS ENUM (
            'Asistente',
            'Analista',
            'Profesional',
            'Coordinador',
            'Supervisor',
            'Jefe',
            'Gerente'
        );
    END IF;

    -- Workplace (used in surveys)
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'academy_lugar') THEN
        CREATE TYPE academy_lugar AS ENUM (
            'OFICINA',
            'CASA',
            'TRANSPORTE'
        );
    END IF;

    -- Role in survey
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'academy_rol_encuesta') THEN
        CREATE TYPE academy_rol_encuesta AS ENUM (
            'Participante',
            'Expositor',
            'Organizador',
            'Otro'
        );
    END IF;
END
$$;

-- ============================================================
-- TABLES
-- ============================================================

-- User profile for training
CREATE TABLE IF NOT EXISTS perfil_usuario_capacitaciones (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL UNIQUE,
    rol_capacitaciones academy_rol_capacitaciones NOT NULL DEFAULT 'estudiante',
    activo boolean NOT NULL DEFAULT true,
    fecha_asignacion_rol timestamp DEFAULT now(),
    notas text,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
);

-- Courses
CREATE TABLE IF NOT EXISTS cursos (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    titulo text NOT NULL,
    descripcion text NOT NULL,
    fecha_inicio timestamp,
    fecha_fin timestamp,
    duracion_horas decimal(5, 1),
    portada text,
    color_portada text NOT NULL DEFAULT '#009c3c',
    tipo_curso academy_tipo_curso,
    activo boolean NOT NULL DEFAULT true,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
);

-- Assignment groups
CREATE TABLE IF NOT EXISTS grupos_asignacion (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    nombre text NOT NULL,
    supervisor_principal_id text,
    descripcion text,
    activo boolean NOT NULL DEFAULT true,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
);

-- Group-user relation
CREATE TABLE IF NOT EXISTS grupo_usuarios (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    grupo_id text NOT NULL REFERENCES grupos_asignacion(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    fecha_asignacion timestamp DEFAULT now()
);

-- Group-supervisor relation
CREATE TABLE IF NOT EXISTS grupo_supervisores (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    grupo_id text NOT NULL REFERENCES grupos_asignacion(id) ON DELETE CASCADE,
    supervisor_id text NOT NULL,
    fecha_asignacion timestamp DEFAULT now()
);

-- Course modules
CREATE TABLE IF NOT EXISTS modulos (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    curso_id text NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
    titulo text NOT NULL,
    descripcion text,
    orden integer NOT NULL DEFAULT 1,
    activo boolean NOT NULL DEFAULT true,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
);

-- Module topics
CREATE TABLE IF NOT EXISTS temas (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    modulo_id text NOT NULL REFERENCES modulos(id) ON DELETE CASCADE,
    titulo text NOT NULL,
    contenido text NOT NULL,
    orden integer NOT NULL DEFAULT 1,
    video_local text,
    video_youtube text,
    video_externo text,
    imagen text,
    documento text,
    activo boolean NOT NULL DEFAULT true,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
);

-- Additional topic files
CREATE TABLE IF NOT EXISTS archivos_adicionales (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tema_id text NOT NULL REFERENCES temas(id) ON DELETE CASCADE,
    nombre text NOT NULL,
    archivo text NOT NULL,
    orden integer NOT NULL DEFAULT 1,
    created_at timestamp DEFAULT now()
);

-- Quizzes
CREATE TABLE IF NOT EXISTS quizzes (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    modulo_id text NOT NULL UNIQUE REFERENCES modulos(id) ON DELETE CASCADE,
    titulo text NOT NULL,
    instrucciones text,
    portada text,
    puntaje_minimo_aprobacion integer NOT NULL DEFAULT 70,
    tiempo_limite_minutos integer,
    activo boolean NOT NULL DEFAULT true,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
);

-- Quiz questions
CREATE TABLE IF NOT EXISTS preguntas (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    quiz_id text NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    texto text NOT NULL,
    puntaje integer NOT NULL DEFAULT 10,
    orden integer NOT NULL DEFAULT 1,
    archivo text,
    activo boolean NOT NULL DEFAULT true,
    created_at timestamp DEFAULT now()
);

-- Answer options
CREATE TABLE IF NOT EXISTS opciones (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    pregunta_id text NOT NULL REFERENCES preguntas(id) ON DELETE CASCADE,
    texto text NOT NULL,
    es_correcta boolean NOT NULL DEFAULT false,
    orden integer NOT NULL DEFAULT 1,
    created_at timestamp DEFAULT now()
);

-- Course progress per user
CREATE TABLE IF NOT EXISTS progreso_cursos (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL,
    curso_id text NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
    completado boolean NOT NULL DEFAULT false,
    fecha_completado timestamp,
    encuesta_completada boolean NOT NULL DEFAULT false,
    certificado_descargado boolean NOT NULL DEFAULT false,
    fecha_descarga_certificado timestamp,
    porcentaje_progreso integer NOT NULL DEFAULT 0,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now(),
    UNIQUE(user_id, curso_id)
);

-- Module progress
CREATE TABLE IF NOT EXISTS progreso_modulos (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    progreso_curso_id text NOT NULL REFERENCES progreso_cursos(id) ON DELETE CASCADE,
    modulo_id text NOT NULL REFERENCES modulos(id) ON DELETE CASCADE,
    fecha_completado timestamp DEFAULT now()
);

-- Topic progress
CREATE TABLE IF NOT EXISTS progreso_temas (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL,
    tema_id text NOT NULL REFERENCES temas(id) ON DELETE CASCADE,
    completado boolean NOT NULL DEFAULT false,
    fecha_completado timestamp,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now(),
    UNIQUE(user_id, tema_id)
);

-- User answers
CREATE TABLE IF NOT EXISTS respuestas_usuario (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL,
    pregunta_id text NOT NULL REFERENCES preguntas(id) ON DELETE CASCADE,
    opcion_seleccionada_id text NOT NULL REFERENCES opciones(id) ON DELETE CASCADE,
    created_at timestamp DEFAULT now(),
    UNIQUE(user_id, pregunta_id)
);

-- Quiz results
CREATE TABLE IF NOT EXISTS resultados_quiz (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL,
    quiz_id text NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    puntaje integer NOT NULL,
    puntaje_porcentaje integer NOT NULL,
    aprobado boolean NOT NULL DEFAULT false,
    respuestas_json jsonb,
    fecha_realizacion timestamp DEFAULT now(),
    tiempo_empleado_segundos integer
);

-- Course assignments
CREATE TABLE IF NOT EXISTS asignaciones (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    curso_id text NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
    user_id text,
    grupo_id text REFERENCES grupos_asignacion(id) ON DELETE CASCADE,
    metodo academy_metodo_asignacion NOT NULL DEFAULT 'manual',
    asignado_por_id text,
    fecha timestamp DEFAULT now(),
    notas text
);

-- User feedback
CREATE TABLE IF NOT EXISTS feedback (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL,
    tema_id text NOT NULL REFERENCES temas(id) ON DELETE CASCADE,
    puntuacion integer NOT NULL,
    comentario text,
    created_at timestamp DEFAULT now()
);

-- Satisfaction surveys
CREATE TABLE IF NOT EXISTS encuestas_satisfaccion (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text,
    curso_id text REFERENCES cursos(id) ON DELETE SET NULL,
    departamento academy_departamento NOT NULL,
    cargo academy_cargo NOT NULL,
    expositor integer NOT NULL,
    utilidad boolean NOT NULL,
    satisfaccion integer NOT NULL,
    aprendido text NOT NULL,
    lugar academy_lugar NOT NULL,
    rol academy_rol_encuesta NOT NULL,
    recomendacion text,
    comentarios_curso text NOT NULL,
    fecha timestamp DEFAULT now()
);

-- Certificates
CREATE TABLE IF NOT EXISTS certificados (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL,
    curso_id text NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
    codigo text NOT NULL UNIQUE,
    archivo text,
    fecha_generacion timestamp DEFAULT now(),
    fecha_descarga timestamp,
    datos_json jsonb
);

-- Activity log
CREATE TABLE IF NOT EXISTS actividad_log (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text,
    tipo text NOT NULL,
    entidad_tipo text,
    entidad_id text,
    descripcion text NOT NULL,
    metadata jsonb,
    created_at timestamp DEFAULT now()
);

-- Learning Paths
CREATE TABLE IF NOT EXISTS learning_paths (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    nombre text NOT NULL,
    descripcion text,
    categoria text,
    duracion_estimada_horas decimal(6, 1),
    imagen text,
    activo boolean NOT NULL DEFAULT true,
    requiere_aprobacion_secuencial boolean NOT NULL DEFAULT false,
    created_by_id text,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
);

-- Learning path - course relation
CREATE TABLE IF NOT EXISTS learning_path_cursos (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    learning_path_id text NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
    curso_id text NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
    orden integer NOT NULL DEFAULT 1,
    obligatorio boolean NOT NULL DEFAULT true,
    duracion_estimada_dias integer,
    created_at timestamp DEFAULT now()
);

-- Learning path progress
CREATE TABLE IF NOT EXISTS progreso_learning_paths (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL,
    learning_path_id text NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
    porcentaje_completado integer NOT NULL DEFAULT 0,
    cursos_completados integer NOT NULL DEFAULT 0,
    total_cursos integer NOT NULL DEFAULT 0,
    completado boolean NOT NULL DEFAULT false,
    fecha_completado timestamp,
    fecha_inicio timestamp DEFAULT now(),
    fecha_limite timestamp,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now(),
    UNIQUE(user_id, learning_path_id)
);

-- Learning path assignments
CREATE TABLE IF NOT EXISTS asignaciones_learning_path (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    learning_path_id text NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    asignado_por_id text,
    fecha_limite timestamp,
    prioridad text DEFAULT 'normal',
    notas text,
    fecha timestamp DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_cursos_activo ON cursos(activo);
CREATE INDEX IF NOT EXISTS idx_cursos_tipo ON cursos(tipo_curso);
CREATE INDEX IF NOT EXISTS idx_modulos_curso ON modulos(curso_id);
CREATE INDEX IF NOT EXISTS idx_temas_modulo ON temas(modulo_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_modulo ON quizzes(modulo_id);
CREATE INDEX IF NOT EXISTS idx_preguntas_quiz ON preguntas(quiz_id);
CREATE INDEX IF NOT EXISTS idx_opciones_pregunta ON opciones(pregunta_id);
CREATE INDEX IF NOT EXISTS idx_progreso_curso_user ON progreso_cursos(user_id, curso_id);
CREATE INDEX IF NOT EXISTS idx_progreso_tema_user ON progreso_temas(user_id, tema_id);
CREATE INDEX IF NOT EXISTS idx_asignaciones_curso ON asignaciones(curso_id);
CREATE INDEX IF NOT EXISTS idx_asignaciones_user ON asignaciones(user_id);
CREATE INDEX IF NOT EXISTS idx_resultados_quiz_user ON resultados_quiz(user_id, quiz_id);
CREATE INDEX IF NOT EXISTS idx_certificados_user ON certificados(user_id);
CREATE INDEX IF NOT EXISTS idx_certificados_curso ON certificados(curso_id);
