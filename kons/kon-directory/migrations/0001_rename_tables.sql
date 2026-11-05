-- Rename the legacy tables to the kon's prefix
-- ----------------------------------------------------------------------------
--
-- Only has an effect on databases that come from the previous core version.
-- Since `0000_base_schema.sql` creates the `directory_*` tables, we must also
-- check that the TARGET is free: with both present, `RENAME TO` fails with
-- "relation already exists" and brings down the chain.
--
-- `ALTER TABLE IF EXISTS` only covers half of the condition.

DO $$
DECLARE
  par RECORD;
BEGIN
  FOR par IN
    SELECT * FROM (VALUES
      ('organizations',      'directory_organizations'),
      ('departments',        'directory_departments'),
      ('positions',          'directory_positions'),
      ('employees',          'directory_employees'),
      ('employee_documents', 'directory_employee_documents'),
      ('org_chart_cache',    'directory_org_chart_cache')
    ) AS t(viejo, nuevo)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = par.viejo)
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                        WHERE table_schema = 'public' AND table_name = par.nuevo) THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', par.viejo, par.nuevo);
    END IF;
  END LOOP;
END $$;

-- Rename enums
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'employee_status')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'directory_employee_status') THEN
    ALTER TYPE employee_status RENAME TO directory_employee_status;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'employment_type')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'directory_employment_type') THEN
    ALTER TYPE employment_type RENAME TO directory_employment_type;
  END IF;
END $$;
