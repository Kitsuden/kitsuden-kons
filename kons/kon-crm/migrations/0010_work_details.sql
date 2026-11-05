-- What an app built on the CRM needs to show work without guessing
-- ============================================================================
--
-- * Who completed a task, so a reopened one can say who had closed it.
-- * An activity `kind` (what the business calls it: "hearing", "site visit", "deadline") and a `location`.
--   The `type` stays the fixed enum the CRM reasons about; the kind is the installation's own word, and a
--   preset lists the kinds it offers.
-- * Custom fields on companies, with the same rules as on contacts.
-- * Per portal link, whether the client also sees their account statement. Off by default: a link only shows
--   amounts when the person who made it said so.
-- * Counters for sequential numbers ("M-0001"), taken atomically.
--
-- Re-runnable: every step checks first.

ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS completed_by text;
ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS location text;
CREATE INDEX IF NOT EXISTS idx_crm_activities_kind ON crm_activities (kind) WHERE kind IS NOT NULL;

ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS custom_fields jsonb DEFAULT '{}';

ALTER TABLE crm_portal_links ADD COLUMN IF NOT EXISTS show_statement boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_crm_deals_custom_fields ON crm_deals USING gin (custom_fields);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_custom_fields ON crm_contacts USING gin (custom_fields);
CREATE INDEX IF NOT EXISTS idx_crm_companies_custom_fields ON crm_companies USING gin (custom_fields);

CREATE TABLE IF NOT EXISTS crm_counters (
    name text PRIMARY KEY,
    value integer NOT NULL DEFAULT 0 CHECK (value >= 0)
);

DO $$
DECLARE
  system_only text := $q$(coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')$q$;
BEGIN
  ALTER TABLE crm_counters ENABLE ROW LEVEL SECURITY;
  ALTER TABLE crm_counters FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS crm_counters_team ON crm_counters;
  EXECUTE format('CREATE POLICY crm_counters_team ON crm_counters FOR ALL USING (%s OR current_setting(''app.current_user_role'', true) IN (''admin'', ''editor'', ''agent'')) WITH CHECK (%s OR current_setting(''app.current_user_role'', true) IN (''admin'', ''editor'', ''agent''))', system_only, system_only);
END $$;
