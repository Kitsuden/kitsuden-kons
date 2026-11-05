-- Observed data: what an agent, a connector or a person saw about a contact or company, and where
-- ============================================================================
--
-- Nothing about a person is guessed. Whoever records a value says what it observed and the kind of evidence
-- ("it was in their own email signature"), never how sure it is: a caller asked to grade its own certainty grades
-- itself high. The weight comes from `crm_evidence_kinds`, a table the admin edits. Values seen by several
-- sources add up. At or above `crm_evidence_policy.apply_at` the value is written to the record; below it, it
-- waits as a suggestion for a person. A value a person typed is never overwritten by an observation, and a value a
-- person rejected never applies by itself again.
--
-- Re-runnable: every step checks first.

CREATE TABLE IF NOT EXISTS crm_evidence_kinds (
    key text PRIMARY KEY CHECK (key ~ '^[a-z0-9-]{2,60}$'),
    label text NOT NULL,
    description text,
    weight integer NOT NULL CHECK (weight BETWEEN 0 AND 100),
    active boolean NOT NULL DEFAULT true,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

INSERT INTO crm_evidence_kinds (key, label, description, weight) VALUES
    ('confirmed-by-person', 'Confirmed by the person', 'They said it themselves, in writing, to the team.', 100),
    ('own-email-signature', 'Their own email signature', 'In the signature of an email they sent from their own address.', 80),
    ('own-profile', 'Their own public profile', 'On a profile they maintain: a professional network or their company''s team page.', 60),
    ('company-website', 'The company''s website', 'Published on the website of the company in question.', 50),
    ('data-provider', 'A data provider', 'Returned by a paid or public data source.', 30),
    ('web-mention', 'A mention on the web', 'Seen in an article, a directory or a third-party page.', 15),
    ('inferred', 'Inferred', 'Deduced from other data, not seen anywhere. Never enough by itself.', 0)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS crm_evidence_policy (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    apply_at integer NOT NULL DEFAULT 70 CHECK (apply_at BETWEEN 1 AND 100),
    updated_by text,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
INSERT INTO crm_evidence_policy (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS crm_observations (
    id text PRIMARY KEY,
    entity_type text NOT NULL CHECK (entity_type IN ('contact', 'company')),
    entity_id text NOT NULL,
    field text NOT NULL,
    value jsonb NOT NULL,
    source text NOT NULL,
    evidence text NOT NULL REFERENCES crm_evidence_kinds(key),
    weight integer NOT NULL,
    note text,
    status text NOT NULL CHECK (status IN ('applied', 'suggested', 'confirmed', 'accepted', 'rejected')),
    reason text,
    previous_value jsonb,
    external_ref text,
    observed_by text DEFAULT NULLIF(current_setting('app.current_user_id', true), ''),
    observed_at timestamp with time zone NOT NULL DEFAULT now(),
    decided_by text,
    decided_at timestamp with time zone,
    decision_note text
);
CREATE INDEX IF NOT EXISTS idx_crm_observations_entity ON crm_observations (entity_type, entity_id, field);
CREATE INDEX IF NOT EXISTS idx_crm_observations_pending ON crm_observations (observed_at) WHERE status = 'suggested';
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_observations_external_ref ON crm_observations (external_ref) WHERE external_ref IS NOT NULL;

DO $$
DECLARE
  t text;
  system_only text := $q$(coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')$q$;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_evidence_kinds', 'crm_evidence_policy', 'crm_observations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_team', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (%s OR current_setting(''app.current_user_role'', true) IN (''admin'', ''editor'', ''agent'')) WITH CHECK (%s OR current_setting(''app.current_user_role'', true) IN (''admin'', ''editor'', ''agent''))', t || '_team', t, system_only, system_only);
  END LOOP;
END $$;

-- An observation is seen by whoever sees its record: the same scope as contacts and companies.
DROP POLICY IF EXISTS crm_observations_scope ON crm_observations;
CREATE POLICY crm_observations_scope ON crm_observations AS RESTRICTIVE FOR ALL
    USING (
        (entity_type = 'contact' AND EXISTS (SELECT 1 FROM crm_contacts c WHERE c.id = entity_id))
        OR (entity_type = 'company' AND EXISTS (SELECT 1 FROM crm_companies co WHERE co.id = entity_id))
    );
