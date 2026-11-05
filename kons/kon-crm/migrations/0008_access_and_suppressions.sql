-- Who sees how much of the CRM, and who must never be captured.
--
-- `crm_access_grants` narrows or widens what the team and agents already reach. The checks live here and
-- not in the routes: the board, the stats and the histories all read these tables, and a route-level
-- filter would have to be repeated in each one. New policies are RESTRICTIVE, so they can only take away
-- from what the existing team policies allow.

CREATE TABLE IF NOT EXISTS crm_access_grants (
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'agent')),
  subject_id text NOT NULL,
  records text NOT NULL DEFAULT 'all' CHECK (records IN ('all', 'assigned')),
  money boolean NOT NULL DEFAULT true,
  sensitive boolean NOT NULL DEFAULT false,
  -- NULL: the default for the subject. People read notes; agents only if someone says so.
  notes boolean,
  -- Only the widening expires. A restriction that lapsed on its own would open records nobody chose to open.
  sensitive_until timestamptz,
  reason text NOT NULL,
  granted_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS crm_suppressions (
  kind text NOT NULL CHECK (kind IN ('email', 'domain')),
  value text NOT NULL,
  reason text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, value)
);

-- What the current request may see. Not SECURITY DEFINER: a subject reads its own grant through the policy below.
CREATE OR REPLACE FUNCTION crm_access() RETURNS jsonb LANGUAGE plpgsql STABLE AS $FN$
DECLARE
  uid text := coalesce(current_setting('app.current_user_id', true), '');
  role_name text := coalesce(current_setting('app.current_user_role', true), '');
  grant_row crm_access_grants%ROWTYPE;
  everything constant jsonb := '{"records":"all","money":true,"sensitive":true,"notes":true}';
BEGIN
  IF (uid = '' AND role_name = '') OR kitsuden_effective_admin('crm') THEN RETURN everything; END IF;
  IF role_name = 'agent' AND kitsuden_agent_can_in_kon('crm', 'crm:read-all') THEN RETURN everything; END IF;

  SELECT * INTO grant_row FROM crm_access_grants
   WHERE subject_id = uid AND subject_type = CASE WHEN role_name = 'agent' THEN 'agent' ELSE 'user' END;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('records', 'all', 'money', true, 'sensitive', false, 'notes', role_name <> 'agent');
  END IF;

  RETURN jsonb_build_object(
    'records', grant_row.records,
    'money', grant_row.money,
    'notes', coalesce(grant_row.notes, role_name <> 'agent'),
    'sensitive', grant_row.sensitive AND (grant_row.sensitive_until IS NULL OR grant_row.sensitive_until > now())
             AND NOT (role_name = 'agent' AND kitsuden_agent_denied('crm:read-all'))
  );
END;
$FN$;

CREATE OR REPLACE FUNCTION crm_can_see(p_assigned text, p_created text) RETURNS boolean LANGUAGE sql STABLE AS $FN$
  SELECT crm_access() ->> 'records' = 'all'
      OR p_assigned = current_setting('app.current_user_id', true)
      OR p_created = current_setting('app.current_user_id', true)
$FN$;

ALTER TABLE crm_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_access_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_suppressions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_access_grants_read ON crm_access_grants;
CREATE POLICY crm_access_grants_read ON crm_access_grants FOR SELECT USING (
  (coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')
  OR kitsuden_effective_admin('crm')
  OR subject_id = current_setting('app.current_user_id', true)
);
DROP POLICY IF EXISTS crm_access_grants_write ON crm_access_grants;
CREATE POLICY crm_access_grants_write ON crm_access_grants FOR ALL USING (
  (coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')
  OR kitsuden_effective_admin('crm')
) WITH CHECK (
  (coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')
  OR kitsuden_effective_admin('crm')
);

DROP POLICY IF EXISTS crm_suppressions_team ON crm_suppressions;
CREATE POLICY crm_suppressions_team ON crm_suppressions FOR ALL USING (
  (coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')
  OR current_setting('app.current_user_role', true) IN ('admin', 'editor', 'agent')
) WITH CHECK (
  (coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')
  OR current_setting('app.current_user_role', true) IN ('admin', 'editor', 'agent')
);

-- A subject limited to `assigned` sees what it owns or created, and what hangs from a deal it can see.
DROP POLICY IF EXISTS crm_deals_scope ON crm_deals;
CREATE POLICY crm_deals_scope ON crm_deals AS RESTRICTIVE FOR ALL
  USING (crm_can_see(assigned_to, created_by)) WITH CHECK (true);

DROP POLICY IF EXISTS crm_contacts_scope ON crm_contacts;
CREATE POLICY crm_contacts_scope ON crm_contacts AS RESTRICTIVE FOR ALL
  USING (crm_can_see(assigned_to, created_by)
         OR EXISTS (SELECT 1 FROM crm_deals d WHERE d.contact_id = crm_contacts.id)) WITH CHECK (true);

DROP POLICY IF EXISTS crm_companies_scope ON crm_companies;
CREATE POLICY crm_companies_scope ON crm_companies AS RESTRICTIVE FOR ALL
  USING (crm_can_see(NULL, created_by)
         OR EXISTS (SELECT 1 FROM crm_deals d WHERE d.company_id = crm_companies.id)
         OR EXISTS (SELECT 1 FROM crm_contacts c WHERE c.company_id = crm_companies.id)) WITH CHECK (true);

DROP POLICY IF EXISTS crm_activities_scope ON crm_activities;
CREATE POLICY crm_activities_scope ON crm_activities AS RESTRICTIVE FOR ALL
  USING (crm_can_see(assigned_to, created_by)
         OR EXISTS (SELECT 1 FROM crm_deals d WHERE d.id = crm_activities.deal_id)) WITH CHECK (true);

DROP POLICY IF EXISTS crm_stage_transitions_scope ON crm_stage_transitions;
CREATE POLICY crm_stage_transitions_scope ON crm_stage_transitions AS RESTRICTIVE FOR ALL
  USING (crm_access() ->> 'records' = 'all'
         OR EXISTS (SELECT 1 FROM crm_deals d WHERE d.id = crm_stage_transitions.deal_id)) WITH CHECK (true);

-- Privileged and confidential documents need the sensitive grant, whatever else the subject can read.
DROP POLICY IF EXISTS crm_documents_scope ON crm_documents;
CREATE POLICY crm_documents_scope ON crm_documents AS RESTRICTIVE FOR ALL
  USING (
    ((crm_access() ->> 'sensitive')::boolean OR NOT (coalesce(is_privileged, false) OR coalesce(confidential, false)))
    AND (crm_access() ->> 'records' = 'all' OR EXISTS (SELECT 1 FROM crm_deals d WHERE d.id = crm_documents.deal_id))
  ) WITH CHECK (true);
