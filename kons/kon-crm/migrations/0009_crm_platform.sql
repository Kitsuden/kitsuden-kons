-- What lets the CRM carry a real practice: contacts with roles on a deal, record origin, task priority,
-- saved views, document templates, an editable score model, reviewed merges, public forms and a client portal.

-- Where a record came from. `source` stays as free detail (`landing-x`); this one is a fixed list.
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual';
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual';
ALTER TABLE crm_deals ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual';
ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual';
ALTER TABLE crm_contacts DROP CONSTRAINT IF EXISTS crm_contacts_origin_check;
ALTER TABLE crm_contacts ADD CONSTRAINT crm_contacts_origin_check CHECK (origin IN ('manual', 'import', 'form', 'email', 'agent', 'automation'));
ALTER TABLE crm_companies DROP CONSTRAINT IF EXISTS crm_companies_origin_check;
ALTER TABLE crm_companies ADD CONSTRAINT crm_companies_origin_check CHECK (origin IN ('manual', 'import', 'form', 'email', 'agent', 'automation'));
ALTER TABLE crm_deals DROP CONSTRAINT IF EXISTS crm_deals_origin_check;
ALTER TABLE crm_deals ADD CONSTRAINT crm_deals_origin_check CHECK (origin IN ('manual', 'import', 'form', 'email', 'agent', 'automation'));
ALTER TABLE crm_activities DROP CONSTRAINT IF EXISTS crm_activities_origin_check;
ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_origin_check CHECK (origin IN ('manual', 'import', 'form', 'email', 'agent', 'automation'));

-- In the database so no write path can forget it: what an agent writes says so.
CREATE OR REPLACE FUNCTION crm_mark_agent_origin() RETURNS trigger LANGUAGE plpgsql AS $FN$
BEGIN
  IF NEW.origin = 'manual' AND coalesce(current_setting('app.current_user_role', true), '') = 'agent' THEN
    NEW.origin := 'agent';
  END IF;
  RETURN NEW;
END;
$FN$;
DROP TRIGGER IF EXISTS crm_contacts_origin ON crm_contacts;
CREATE TRIGGER crm_contacts_origin BEFORE INSERT ON crm_contacts FOR EACH ROW EXECUTE FUNCTION crm_mark_agent_origin();
DROP TRIGGER IF EXISTS crm_companies_origin ON crm_companies;
CREATE TRIGGER crm_companies_origin BEFORE INSERT ON crm_companies FOR EACH ROW EXECUTE FUNCTION crm_mark_agent_origin();
DROP TRIGGER IF EXISTS crm_deals_origin ON crm_deals;
CREATE TRIGGER crm_deals_origin BEFORE INSERT ON crm_deals FOR EACH ROW EXECUTE FUNCTION crm_mark_agent_origin();
DROP TRIGGER IF EXISTS crm_activities_origin ON crm_activities;
CREATE TRIGGER crm_activities_origin BEFORE INSERT ON crm_activities FOR EACH ROW EXECUTE FUNCTION crm_mark_agent_origin();

ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS priority crm_priority NOT NULL DEFAULT 'medium';
CREATE INDEX IF NOT EXISTS idx_crm_activities_due ON crm_activities (due_date) WHERE completed_at IS NULL;

-- What the client sees in the portal: nothing unless someone marks it.
ALTER TABLE crm_deals ADD COLUMN IF NOT EXISTS portal_visible boolean NOT NULL DEFAULT false;
ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS shared_with_client boolean NOT NULL DEFAULT false;
ALTER TABLE crm_documents ADD COLUMN IF NOT EXISTS shared_with_client boolean NOT NULL DEFAULT false;

ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS score_version integer;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS score_breakdown jsonb;

CREATE TABLE IF NOT EXISTS crm_deal_contacts (
  deal_id text NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'other',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_deal_contacts_contact ON crm_deal_contacts (contact_id);

CREATE TABLE IF NOT EXISTS crm_saved_views (
  id text PRIMARY KEY,
  name text NOT NULL,
  entity text NOT NULL CHECK (entity IN ('contacts', 'companies', 'deals', 'activities')),
  filters jsonb NOT NULL DEFAULT '{}',
  shared boolean NOT NULL DEFAULT false,
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_document_templates (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  body text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Each save is a new version, so a score can always say which rules produced it.
CREATE TABLE IF NOT EXISTS crm_score_models (
  version serial PRIMARY KEY,
  rules jsonb NOT NULL,
  guide text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_merge_requests (
  id text PRIMARY KEY,
  contact_id text NOT NULL,
  other_id text NOT NULL,
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_capture_forms (
  id text PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  pipeline_id text REFERENCES crm_pipelines(id) ON DELETE SET NULL,
  stage_id text REFERENCES crm_pipeline_stages(id) ON DELETE SET NULL,
  source text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_portal_links (
  id text PRIMARY KEY,
  contact_id text NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  t text;
  system_only text := $q$(coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')$q$;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_deal_contacts', 'crm_saved_views', 'crm_document_templates', 'crm_score_models', 'crm_merge_requests', 'crm_capture_forms', 'crm_portal_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_team', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (%s OR current_setting(''app.current_user_role'', true) IN (''admin'', ''editor'', ''agent'')) WITH CHECK (%s OR current_setting(''app.current_user_role'', true) IN (''admin'', ''editor'', ''agent''))', t || '_team', t, system_only, system_only);
  END LOOP;
END $$;

-- A link hangs from a deal the subject can see.
DROP POLICY IF EXISTS crm_deal_contacts_scope ON crm_deal_contacts;
CREATE POLICY crm_deal_contacts_scope ON crm_deal_contacts AS RESTRICTIVE FOR ALL
  USING (crm_access() ->> 'records' = 'all' OR EXISTS (SELECT 1 FROM crm_deals d WHERE d.id = crm_deal_contacts.deal_id)) WITH CHECK (true);

-- Someone's private view is theirs. The admin sees all, to clean up after people who left.
DROP POLICY IF EXISTS crm_saved_views_scope ON crm_saved_views;
CREATE POLICY crm_saved_views_scope ON crm_saved_views AS RESTRICTIVE FOR SELECT
  USING (shared OR owner_id = current_setting('app.current_user_id', true) OR kitsuden_effective_admin('crm')
         OR (coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = ''));

-- The model everyone starts from. Replaced by saving a new version from the panel.
INSERT INTO crm_score_models (rules, guide)
SELECT '[
  {"id":"corporate-email","label":"Corporate email","signal":"corporateEmail","op":"==","value":true,"points":15},
  {"id":"phone","label":"Has a phone","signal":"hasPhone","op":"==","value":true,"points":10},
  {"id":"company","label":"Linked to a company","signal":"hasCompany","op":"==","value":true,"points":10},
  {"id":"title","label":"Job title known","signal":"hasJobTitle","op":"==","value":true,"points":5},
  {"id":"recent","label":"Activity in the last 30 days","signal":"activities30d","op":">=","value":1,"points":15},
  {"id":"engaged","label":"Five or more activities in 30 days","signal":"activities30d","op":">=","value":5,"points":10},
  {"id":"open-deal","label":"Has an open deal","signal":"openDeals","op":">=","value":1,"points":20},
  {"id":"won-deal","label":"Has won a deal before","signal":"wonDeals","op":">=","value":1,"points":15},
  {"id":"cold","label":"No contact in 90 days","signal":"daysSinceContact","op":">=","value":90,"points":-15}
]'::jsonb,
'# How contacts are scored

score = sum of the points of every rule that holds, kept between 0 and 100.

A score only counts what the CRM can show: each contact keeps the list of rules that gave it its points. It never
comes from an opinion, so nobody has to trust a number they cannot check.

Change the rules when the team stops trusting the order they produce, not when one contact looks wrong.'
WHERE NOT EXISTS (SELECT 1 FROM crm_score_models);
