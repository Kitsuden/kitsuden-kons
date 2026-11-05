-- Generic department and job-title values, for databases created before these catalogues became generic.
-- On a new database they already exist, and this does nothing.
ALTER TYPE academy_departamento ADD VALUE IF NOT EXISTS 'OPERACIONES';
ALTER TYPE academy_departamento ADD VALUE IF NOT EXISTS 'TECNOLOGIA';
ALTER TYPE academy_departamento ADD VALUE IF NOT EXISTS 'OTRO';
ALTER TYPE academy_cargo ADD VALUE IF NOT EXISTS 'Profesional';
ALTER TYPE academy_cargo ADD VALUE IF NOT EXISTS 'Supervisor';
