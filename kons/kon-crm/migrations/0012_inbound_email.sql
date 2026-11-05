-- Emails the team copies to the CRM
-- ============================================================================
--
-- Someone on the team puts the CRM's address in Bcc, or forwards a client's email to it; the email provider
-- posts it to `/api/crm/public/inbound/<provider>`, and each contact on it gets the email as an activity. This
-- table is the receipt: one row per message and provider, so a retry records once, and the reason when a message
-- was turned away (unknown sender, failed SPF/DKIM, no contact on it) for an admin to see.
--
-- Re-runnable: every step checks first.

CREATE TABLE IF NOT EXISTS crm_inbound_emails (
    id text PRIMARY KEY,
    provider text NOT NULL,
    message_id text NOT NULL,
    sender text,
    subject text,
    status text NOT NULL CHECK (status IN ('recorded', 'rejected')),
    reason text,
    activity_ids jsonb NOT NULL DEFAULT '[]',
    unmatched jsonb NOT NULL DEFAULT '[]',
    received_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_inbound_emails_message ON crm_inbound_emails (provider, message_id);
CREATE INDEX IF NOT EXISTS idx_crm_inbound_emails_received ON crm_inbound_emails (received_at DESC);

DO $$
DECLARE
  system_only text := $q$(coalesce(current_setting('app.current_user_id', true), '') = '' AND coalesce(current_setting('app.current_user_role', true), '') = '')$q$;
BEGIN
  ALTER TABLE crm_inbound_emails ENABLE ROW LEVEL SECURITY;
  ALTER TABLE crm_inbound_emails FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS crm_inbound_emails_team ON crm_inbound_emails;
  -- Written only by the system (the webhook); read by admins.
  EXECUTE format('CREATE POLICY crm_inbound_emails_team ON crm_inbound_emails FOR ALL USING (%s OR current_setting(''app.current_user_role'', true) = ''admin'') WITH CHECK (%s)', system_only, system_only);
END $$;
