-- 0016 — A write may only point at what the subject sees; portal links and merge requests follow the record scope.
-- Idempotent.
--
-- 0008 lets a subject limited to `assigned` see a contact or company through a deal that references it, and
-- its scope policies checked writes with `WITH CHECK (true)`: creating a deal on any contact id made that contact
-- visible. Now a new or changed row may reference only a contact, company or deal the subject already sees.
-- The checks are functions, not subqueries, so the policies of these tables do not recurse into each other.
-- They are STABLE and run under the caller's own policies: the row being written is not yet visible to them.

CREATE OR REPLACE FUNCTION crm_sees_contact(p_id text) RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
BEGIN
  IF p_id IS NULL OR crm_access() ->> 'records' = 'all' THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM crm_contacts WHERE id = p_id);
END;
$FN$;

CREATE OR REPLACE FUNCTION crm_sees_company(p_id text) RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
BEGIN
  IF p_id IS NULL OR crm_access() ->> 'records' = 'all' THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM crm_companies WHERE id = p_id);
END;
$FN$;

CREATE OR REPLACE FUNCTION crm_sees_deal(p_id text) RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
BEGIN
  IF p_id IS NULL OR crm_access() ->> 'records' = 'all' THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM crm_deals WHERE id = p_id);
END;
$FN$;

DROP POLICY IF EXISTS crm_deals_scope ON crm_deals;
CREATE POLICY crm_deals_scope ON crm_deals AS RESTRICTIVE FOR ALL
  USING (crm_can_see(assigned_to, created_by))
  WITH CHECK (crm_sees_contact(contact_id) AND crm_sees_company(company_id));

DROP POLICY IF EXISTS crm_contacts_scope ON crm_contacts;
CREATE POLICY crm_contacts_scope ON crm_contacts AS RESTRICTIVE FOR ALL
  USING (crm_can_see(assigned_to, created_by)
         OR EXISTS (SELECT 1 FROM crm_deals d WHERE d.contact_id = crm_contacts.id))
  WITH CHECK (crm_sees_company(company_id));

DROP POLICY IF EXISTS crm_activities_scope ON crm_activities;
CREATE POLICY crm_activities_scope ON crm_activities AS RESTRICTIVE FOR ALL
  USING (crm_can_see(assigned_to, created_by)
         OR EXISTS (SELECT 1 FROM crm_deals d WHERE d.id = crm_activities.deal_id))
  WITH CHECK (crm_sees_contact(contact_id) AND crm_sees_company(company_id) AND crm_sees_deal(deal_id));

DROP POLICY IF EXISTS crm_deal_contacts_scope ON crm_deal_contacts;
CREATE POLICY crm_deal_contacts_scope ON crm_deal_contacts AS RESTRICTIVE FOR ALL
  USING (crm_access() ->> 'records' = 'all' OR EXISTS (SELECT 1 FROM crm_deals d WHERE d.id = crm_deal_contacts.deal_id))
  WITH CHECK (crm_sees_deal(deal_id) AND crm_sees_contact(contact_id));

-- A portal link is seen by whoever sees its contact.
DROP POLICY IF EXISTS crm_portal_links_scope ON crm_portal_links;
CREATE POLICY crm_portal_links_scope ON crm_portal_links AS RESTRICTIVE FOR ALL
  USING (crm_sees_contact(contact_id));

-- A merge request names two contacts: pending, both must be visible. Once decided, one of them may be gone,
-- so the one that remains is enough.
DROP POLICY IF EXISTS crm_merge_requests_scope ON crm_merge_requests;
CREATE POLICY crm_merge_requests_scope ON crm_merge_requests AS RESTRICTIVE FOR ALL
  USING (
    (crm_sees_contact(contact_id) AND crm_sees_contact(other_id))
    OR (status <> 'pending' AND (crm_sees_contact(contact_id) OR crm_sees_contact(other_id)))
  );
