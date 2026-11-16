-- kon-koe: omnichannel conversations (WhatsApp Cloud API, Messenger, Instagram, web chat)
-- ============================================================================
--
-- One conversation per contact and channel at a time, with a state that says who answers (bot, queue,
-- person, snoozed, resolved), the service window each channel enforces, and every message in and out.
-- Around it: the people who answer (members, teams), what they reuse (templates, quick replies), what
-- runs on its own (campaigns, sequences, bot flows) and what sales and collections teams track
-- (payment promises).
--
-- Who sees what (row-level security):
--   - the system (workers, webhooks, `asSystem`) sees and writes everything;
--   - a koe admin (Kitsuden admin, or an agent key that opens the kon: `koe:*`) sees and writes everything;
--   - a supervisor (koe_members.role = 'supervisor') sees every conversation and edits the shared setup;
--   - an agent (koe_members.role = 'agent') sees the conversations assigned to them, those of their teams,
--     and unassigned ones without a team;
--   - nobody else sees anything.
-- Membership is read through SECURITY DEFINER functions so the policies do not recurse into koe_members.
--
-- Credentials (access tokens, app secrets) are sealed with the core's ctx.secrets and kept in columns
-- whose names end in `token` or `secret`, so the generic read surfaces hide them.
--
-- Re-runnable: every step checks first.

-- ── People ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS koe_members (
    user_id text PRIMARY KEY,
    role text NOT NULL DEFAULT 'agent' CHECK (role IN ('agent', 'supervisor', 'admin')),
    display_name text NOT NULL,
    max_concurrent integer NOT NULL DEFAULT 10 CHECK (max_concurrent BETWEEN 0 AND 500),
    available boolean NOT NULL DEFAULT true,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS koe_teams (
    id text PRIMARY KEY,
    slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
    name text NOT NULL,
    purpose text NOT NULL DEFAULT 'support' CHECK (purpose IN ('support', 'sales', 'collections')),
    timezone text NOT NULL DEFAULT 'UTC',
    -- {"mon": [["09:00","18:00"]], ...}; empty = always open
    business_hours jsonb NOT NULL DEFAULT '{}',
    assignment text NOT NULL DEFAULT 'round_robin' CHECK (assignment IN ('round_robin', 'load', 'manual')),
    sla_first_response_s integer CHECK (sla_first_response_s IS NULL OR sla_first_response_s > 0),
    sla_resolution_s integer CHECK (sla_resolution_s IS NULL OR sla_resolution_s > 0),
    last_assigned_user_id text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS koe_team_members (
    team_id text NOT NULL REFERENCES koe_teams(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES koe_members(user_id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_koe_team_members_user ON koe_team_members (user_id);

-- ── Channels ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS koe_channels (
    id text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('whatsapp', 'messenger', 'instagram', 'webchat')),
    name text NOT NULL,
    -- WhatsApp: phone_number_id. Messenger: page id. Instagram: IG business account id. Web chat: public key.
    external_id text NOT NULL,
    -- WhatsApp: WABA id (templates live there). Others: optional.
    account_id text,
    -- What people recognise: the phone number, the page or account name.
    display text,
    access_token jsonb,
    app_secret jsonb,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
    status_detail text,
    quality text,
    messaging_limit text,
    bot_slug text,
    default_team_id text REFERENCES koe_teams(id) ON DELETE SET NULL,
    settings jsonb NOT NULL DEFAULT '{}',
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (kind, external_id)
);

-- ── Contacts and their identities per channel ──────────────────────────────

CREATE TABLE IF NOT EXISTS koe_contacts (
    id text PRIMARY KEY,
    display_name text,
    phone text,
    email text,
    locale text,
    crm_contact_id text,
    attributes jsonb NOT NULL DEFAULT '{}',
    blocked boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_koe_contacts_phone ON koe_contacts (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_koe_contacts_email ON koe_contacts (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS koe_identities (
    id text PRIMARY KEY,
    contact_id text NOT NULL REFERENCES koe_contacts(id) ON DELETE CASCADE,
    channel_id text NOT NULL REFERENCES koe_channels(id) ON DELETE CASCADE,
    -- WhatsApp: wa_id. Messenger: PSID. Instagram: IGSID. Web chat: SHA-256 of the visitor's key.
    external_id text NOT NULL,
    profile jsonb NOT NULL DEFAULT '{}',
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (channel_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_koe_identities_contact ON koe_identities (contact_id);

-- ── Conversations ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS koe_conversations (
    id text PRIMARY KEY,
    channel_id text NOT NULL REFERENCES koe_channels(id) ON DELETE CASCADE,
    identity_id text NOT NULL REFERENCES koe_identities(id) ON DELETE CASCADE,
    contact_id text NOT NULL REFERENCES koe_contacts(id) ON DELETE CASCADE,
    state text NOT NULL DEFAULT 'bot' CHECK (state IN ('bot', 'queued', 'human', 'snoozed', 'resolved')),
    assignee_id text,
    team_id text REFERENCES koe_teams(id) ON DELETE SET NULL,
    priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    labels jsonb NOT NULL DEFAULT '[]',
    last_inbound_at timestamp with time zone,
    last_outbound_at timestamp with time zone,
    last_message_at timestamp with time zone,
    last_message_preview text,
    -- An index for reminders; the window itself is computed from last_inbound_at (koe.window.ts).
    window_expires_at timestamp with time zone,
    -- Free-entry point (click-to-WhatsApp ad, page CTA): 72 h in which templates are not needed.
    free_entry_until timestamp with time zone,
    window_warned_at timestamp with time zone,
    unread_count integer NOT NULL DEFAULT 0,
    snoozed_until timestamp with time zone,
    first_response_due_at timestamp with time zone,
    resolution_due_at timestamp with time zone,
    first_responded_at timestamp with time zone,
    sla_breached boolean NOT NULL DEFAULT false,
    resolved_at timestamp with time zone,
    crm_deal_id text,
    bot_failures integer NOT NULL DEFAULT 0,
    -- Flow state, ad referral, handoff summary…
    metadata jsonb NOT NULL DEFAULT '{}',
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (state <> 'human' OR assignee_id IS NOT NULL),
    CHECK (state <> 'snoozed' OR snoozed_until IS NOT NULL)
);
-- One open conversation per identity: a new message reopens it, never forks it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_koe_conversations_open ON koe_conversations (identity_id) WHERE state <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_koe_conversations_inbox ON koe_conversations (state, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_koe_conversations_assignee ON koe_conversations (assignee_id, state) WHERE assignee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_koe_conversations_team ON koe_conversations (team_id, state);
CREATE INDEX IF NOT EXISTS idx_koe_conversations_window ON koe_conversations (window_expires_at) WHERE state <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_koe_conversations_snoozed ON koe_conversations (snoozed_until) WHERE state = 'snoozed';
CREATE INDEX IF NOT EXISTS idx_koe_conversations_contact ON koe_conversations (contact_id);

CREATE TABLE IF NOT EXISTS koe_media (
    id text PRIMARY KEY,
    conversation_id text REFERENCES koe_conversations(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('image', 'audio', 'voice', 'video', 'document', 'sticker')),
    mime text NOT NULL,
    size_bytes integer,
    duration_ms integer,
    filename text,
    sha256 text,
    storage_key text,
    -- Where the channel keeps its copy (WhatsApp media id) and until when it is valid.
    meta_media_id text,
    meta_media_channel_id text,
    meta_media_expires_at timestamp with time zone,
    -- A browser-playable copy of a voice note (OGG/Opus does not play everywhere).
    playable_key text,
    waveform jsonb,
    transcript text,
    animated boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    error text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_koe_media_conversation ON koe_media (conversation_id);

CREATE TABLE IF NOT EXISTS koe_messages (
    id text PRIMARY KEY,
    conversation_id text NOT NULL REFERENCES koe_conversations(id) ON DELETE CASCADE,
    channel_id text NOT NULL REFERENCES koe_channels(id) ON DELETE CASCADE,
    direction text NOT NULL CHECK (direction IN ('in', 'out')),
    author_kind text NOT NULL CHECK (author_kind IN ('contact', 'bot', 'ai', 'agent', 'rule', 'campaign', 'system')),
    author_id text,
    kind text NOT NULL,
    body text,
    payload jsonb NOT NULL DEFAULT '{}',
    media_id text REFERENCES koe_media(id) ON DELETE SET NULL,
    reply_to_id text,
    external_id text,
    status text NOT NULL CHECK (status IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
    -- Statuses arrive out of order: only a higher rank replaces a lower one (koe.inbound.ts).
    status_rank smallint NOT NULL DEFAULT 0,
    error_code text,
    error_message text,
    template_id text,
    -- Set by the caller of send(): the same key never sends twice.
    idempotency_key text UNIQUE,
    sent_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_koe_messages_external ON koe_messages (channel_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_koe_messages_conversation ON koe_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS koe_conversation_events (
    id text PRIMARY KEY,
    conversation_id text NOT NULL REFERENCES koe_conversations(id) ON DELETE CASCADE,
    type text NOT NULL,
    from_state text,
    to_state text,
    actor_kind text NOT NULL,
    actor_id text,
    reason text,
    data jsonb NOT NULL DEFAULT '{}',
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_koe_conversation_events ON koe_conversation_events (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS koe_notes (
    id text PRIMARY KEY,
    conversation_id text NOT NULL REFERENCES koe_conversations(id) ON DELETE CASCADE,
    author_kind text NOT NULL DEFAULT 'agent' CHECK (author_kind IN ('agent', 'ai', 'system', 'rule')),
    author_id text,
    body text NOT NULL,
    mentions jsonb NOT NULL DEFAULT '[]',
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_koe_notes_conversation ON koe_notes (conversation_id, created_at);

-- ── What people reuse ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS koe_templates (
    id text PRIMARY KEY,
    channel_id text NOT NULL REFERENCES koe_channels(id) ON DELETE CASCADE,
    external_id text,
    name text NOT NULL,
    language text NOT NULL,
    category text NOT NULL CHECK (category IN ('marketing', 'utility', 'authentication')),
    status text NOT NULL CHECK (status IN ('approved', 'pending', 'rejected', 'paused', 'disabled', 'in_appeal', 'deleted')),
    components jsonb NOT NULL DEFAULT '[]',
    quality text,
    rejected_reason text,
    synced_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (channel_id, name, language)
);

CREATE TABLE IF NOT EXISTS koe_quick_replies (
    id text PRIMARY KEY,
    shortcut text NOT NULL CHECK (shortcut ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
    title text NOT NULL,
    body text,
    -- [{ mediaId }]: uploaded once, re-sent by id.
    attachments jsonb NOT NULL DEFAULT '[]',
    scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('personal', 'team', 'global')),
    owner_id text,
    team_id text REFERENCES koe_teams(id) ON DELETE CASCADE,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (scope <> 'personal' OR owner_id IS NOT NULL),
    CHECK (scope <> 'team' OR team_id IS NOT NULL),
    CHECK (body IS NOT NULL OR attachments <> '[]'::jsonb)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_koe_quick_replies ON koe_quick_replies (shortcut, scope, coalesce(owner_id, ''), coalesce(team_id, ''));

-- Stickers the team kept to send again.
CREATE TABLE IF NOT EXISTS koe_stickers (
    id text PRIMARY KEY,
    media_id text NOT NULL REFERENCES koe_media(id) ON DELETE CASCADE,
    name text,
    created_by text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS koe_consents (
    id text PRIMARY KEY,
    contact_id text NOT NULL REFERENCES koe_contacts(id) ON DELETE CASCADE,
    channel_id text NOT NULL REFERENCES koe_channels(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('opted_in', 'opted_out')),
    source text NOT NULL,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (contact_id, channel_id)
);

-- ── Inbound buffer and notifications ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS koe_webhook_events (
    id text PRIMARY KEY,
    channel_kind text NOT NULL,
    dedupe_key text NOT NULL UNIQUE,
    payload jsonb NOT NULL,
    received_at timestamp with time zone NOT NULL DEFAULT now(),
    processed_at timestamp with time zone,
    error text
);
CREATE INDEX IF NOT EXISTS idx_koe_webhook_events_pending ON koe_webhook_events (received_at) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS koe_push_subscriptions (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    endpoint text NOT NULL UNIQUE,
    p256dh text,
    auth_secret text,
    user_agent text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    last_used_at timestamp with time zone
);
CREATE INDEX IF NOT EXISTS idx_koe_push_user ON koe_push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS koe_notices (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    kind text NOT NULL,
    conversation_id text REFERENCES koe_conversations(id) ON DELETE CASCADE,
    title text NOT NULL,
    body text,
    read_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_koe_notices_user ON koe_notices (user_id, created_at DESC);

-- Installation-wide settings (VAPID keys, sealed).
CREATE TABLE IF NOT EXISTS koe_config (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    private_secret jsonb,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- ── What runs on its own ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS koe_campaigns (
    id text PRIMARY KEY,
    channel_id text NOT NULL REFERENCES koe_channels(id) ON DELETE CASCADE,
    name text NOT NULL,
    template_id text NOT NULL REFERENCES koe_templates(id) ON DELETE RESTRICT,
    -- {"1": "{{contact.name}}", "2": "fixed"}
    variables jsonb NOT NULL DEFAULT '{}',
    -- {"labels": [...], "contactIds": [...], "attributes": {...}}
    segment jsonb NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'done', 'cancelled')),
    scheduled_at timestamp with time zone,
    rate_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_per_minute BETWEEN 1 AND 6000),
    -- Hours NOT to send in (contact-law quiet hours), in the contact's timezone when known: {"from": "21:00", "to": "08:00", "timezone": "America/Lima"}
    quiet_hours jsonb,
    estimated_cost_usd numeric(12, 4),
    created_by text,
    approved_by text,
    stats jsonb NOT NULL DEFAULT '{}',
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS koe_campaign_recipients (
    id text PRIMARY KEY,
    campaign_id text NOT NULL REFERENCES koe_campaigns(id) ON DELETE CASCADE,
    contact_id text NOT NULL REFERENCES koe_contacts(id) ON DELETE CASCADE,
    variables jsonb NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
    message_id text,
    error text,
    sent_at timestamp with time zone,
    UNIQUE (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_koe_campaign_recipients_pending ON koe_campaign_recipients (campaign_id) WHERE status = 'pending';

-- Several messages over time that stop when the contact answers.
CREATE TABLE IF NOT EXISTS koe_sequences (
    id text PRIMARY KEY,
    name text NOT NULL,
    channel_id text NOT NULL REFERENCES koe_channels(id) ON DELETE CASCADE,
    -- [{ "delayMinutes": 60, "templateId": "...", "variables": {...} } | { "delayMinutes": 0, "text": "..." }]
    steps jsonb NOT NULL DEFAULT '[]',
    stop_on_reply boolean NOT NULL DEFAULT true,
    active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS koe_sequence_runs (
    id text PRIMARY KEY,
    sequence_id text NOT NULL REFERENCES koe_sequences(id) ON DELETE CASCADE,
    conversation_id text NOT NULL REFERENCES koe_conversations(id) ON DELETE CASCADE,
    step integer NOT NULL DEFAULT 0,
    next_at timestamp with time zone,
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'stopped', 'done')),
    started_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (sequence_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_koe_sequence_runs_due ON koe_sequence_runs (next_at) WHERE status = 'running';

-- Bot flows without AI: menus, data capture, branches (koe.flows.ts).
CREATE TABLE IF NOT EXISTS koe_flows (
    id text PRIMARY KEY,
    name text NOT NULL,
    channel_id text REFERENCES koe_channels(id) ON DELETE CASCADE,
    definition jsonb NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- ── Sales and collections ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS koe_promises (
    id text PRIMARY KEY,
    conversation_id text REFERENCES koe_conversations(id) ON DELETE SET NULL,
    contact_id text NOT NULL REFERENCES koe_contacts(id) ON DELETE CASCADE,
    amount_cents bigint NOT NULL CHECK (amount_cents > 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    due_date date NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'kept', 'broken', 'cancelled')),
    reference text,
    note text,
    reminded_at timestamp with time zone,
    created_by text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    resolved_at timestamp with time zone
);
CREATE INDEX IF NOT EXISTS idx_koe_promises_due ON koe_promises (due_date) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_koe_promises_contact ON koe_promises (contact_id);

-- The outcome of each collection or sales attempt, for reports.
CREATE TABLE IF NOT EXISTS koe_outcomes (
    id text PRIMARY KEY,
    conversation_id text NOT NULL REFERENCES koe_conversations(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('contacted', 'no_answer', 'promise', 'paid', 'refused', 'wrong_number', 'won', 'lost', 'follow_up')),
    amount_cents bigint,
    currency text,
    note text,
    author_id text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_koe_outcomes_conversation ON koe_outcomes (conversation_id);

-- ── Who sees what ──────────────────────────────────────────────────────────

-- The system: no user AND no role (a worker, a migration, `asSystem`). An anonymous request carries
-- the role `anonymous`, so it never counts.
CREATE OR REPLACE FUNCTION koe_is_system() RETURNS boolean LANGUAGE sql STABLE AS $FN$
  SELECT coalesce(current_setting('app.current_user_id', true), '') = ''
     AND coalesce(current_setting('app.current_user_role', true), '') = ''
$FN$;

-- 'admin', 'supervisor', 'agent' or NULL. A Kitsuden admin, or an agent key that opens the kon, is a koe admin.
CREATE OR REPLACE FUNCTION koe_role() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  r text;
BEGIN
  IF kitsuden_effective_admin('koe') THEN
    RETURN 'admin';
  END IF;
  SELECT role INTO r FROM koe_members WHERE user_id = coalesce(current_setting('app.current_user_id', true), '');
  RETURN r;
END
$FN$;

CREATE OR REPLACE FUNCTION koe_is_lead() RETURNS boolean LANGUAGE sql STABLE AS $FN$
  SELECT koe_is_system() OR coalesce(koe_role(), '') IN ('admin', 'supervisor')
$FN$;

CREATE OR REPLACE FUNCTION koe_is_member() RETURNS boolean LANGUAGE sql STABLE AS $FN$
  SELECT koe_is_system() OR koe_role() IS NOT NULL
$FN$;

-- Whether the caller may see a conversation with this team and assignee.
CREATE OR REPLACE FUNCTION koe_sees(p_team_id text, p_assignee_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  me text := coalesce(current_setting('app.current_user_id', true), '');
BEGIN
  IF koe_is_lead() THEN
    RETURN true;
  END IF;
  IF koe_role() IS NULL THEN
    RETURN false;
  END IF;
  IF p_assignee_id IS NOT NULL AND p_assignee_id = me THEN
    RETURN true;
  END IF;
  IF p_team_id IS NULL THEN
    RETURN p_assignee_id IS NULL;
  END IF;
  RETURN EXISTS (SELECT 1 FROM koe_team_members WHERE team_id = p_team_id AND user_id = me);
END
$FN$;

CREATE OR REPLACE FUNCTION koe_sees_conversation(p_conversation_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  t text;
  a text;
BEGIN
  IF koe_is_lead() THEN
    RETURN true;
  END IF;
  SELECT team_id, assignee_id INTO t, a FROM koe_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  RETURN koe_sees(t, a);
END
$FN$;

CREATE OR REPLACE FUNCTION koe_sees_contact(p_contact_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $FN$
BEGIN
  IF koe_is_lead() THEN
    RETURN true;
  END IF;
  RETURN EXISTS (SELECT 1 FROM koe_conversations c WHERE c.contact_id = p_contact_id AND koe_sees(c.team_id, c.assignee_id));
END
$FN$;

DO $$
DECLARE
  t text;
  me text := $q$coalesce(current_setting('app.current_user_id', true), '')$q$;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'koe_members', 'koe_teams', 'koe_team_members', 'koe_channels', 'koe_contacts', 'koe_identities',
    'koe_conversations', 'koe_media', 'koe_messages', 'koe_conversation_events', 'koe_notes',
    'koe_templates', 'koe_quick_replies', 'koe_stickers', 'koe_consents', 'koe_webhook_events',
    'koe_push_subscriptions', 'koe_notices', 'koe_config', 'koe_campaigns', 'koe_campaign_recipients',
    'koe_sequences', 'koe_sequence_runs', 'koe_flows', 'koe_promises', 'koe_outcomes'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_access', t);
  END LOOP;

  -- Setup every member reads; leads (admins, supervisors) write.
  FOREACH t IN ARRAY ARRAY['koe_teams', 'koe_team_members', 'koe_templates', 'koe_flows', 'koe_sequences'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (koe_is_member()) WITH CHECK (koe_is_lead())', t || '_access', t);
  END LOOP;
  -- Channels: members read (the credentials are never returned by the API); only admins write.
  EXECUTE $p$CREATE POLICY koe_channels_access ON koe_channels FOR ALL USING (koe_is_member()) WITH CHECK (koe_is_system() OR koe_role() = 'admin')$p$;
  -- Members: everyone in koe sees who is on it; a member updates their own availability; admins the rest.
  EXECUTE format($p$CREATE POLICY koe_members_access ON koe_members FOR ALL USING (koe_is_member()) WITH CHECK (koe_is_system() OR koe_role() = 'admin' OR user_id = %s)$p$, me);
  -- Installation settings: admins only.
  EXECUTE $p$CREATE POLICY koe_config_access ON koe_config FOR ALL USING (koe_is_system() OR koe_role() = 'admin') WITH CHECK (koe_is_system() OR koe_role() = 'admin')$p$;
  -- The inbound buffer is the workers' business.
  EXECUTE $p$CREATE POLICY koe_webhook_events_access ON koe_webhook_events FOR ALL USING (koe_is_system() OR koe_role() = 'admin') WITH CHECK (koe_is_system())$p$;

  -- Conversations and everything hanging from one: whoever sees the conversation.
  EXECUTE $p$CREATE POLICY koe_conversations_access ON koe_conversations FOR ALL USING (koe_sees(team_id, assignee_id)) WITH CHECK (koe_sees(team_id, assignee_id) OR koe_is_member())$p$;
  FOREACH t IN ARRAY ARRAY['koe_messages', 'koe_conversation_events', 'koe_notes', 'koe_outcomes'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (koe_sees_conversation(conversation_id)) WITH CHECK (koe_sees_conversation(conversation_id))', t || '_access', t);
  END LOOP;
  EXECUTE $p$CREATE POLICY koe_media_access ON koe_media FOR ALL USING (koe_is_lead() OR (conversation_id IS NULL AND koe_is_member()) OR (conversation_id IS NOT NULL AND koe_sees_conversation(conversation_id))) WITH CHECK (koe_is_member())$p$;
  EXECUTE $p$CREATE POLICY koe_stickers_access ON koe_stickers FOR ALL USING (koe_is_member()) WITH CHECK (koe_is_member())$p$;

  -- Contacts and what belongs to them: whoever sees one of their conversations.
  EXECUTE $p$CREATE POLICY koe_contacts_access ON koe_contacts FOR ALL USING (koe_sees_contact(id)) WITH CHECK (koe_is_member())$p$;
  FOREACH t IN ARRAY ARRAY['koe_identities', 'koe_consents', 'koe_promises'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (koe_sees_contact(contact_id)) WITH CHECK (koe_sees_contact(contact_id))', t || '_access', t);
  END LOOP;

  -- Quick replies: global and team ones for members, personal ones for their owner; leads write shared ones.
  EXECUTE format($p$CREATE POLICY koe_quick_replies_access ON koe_quick_replies FOR ALL
    USING (koe_is_lead() OR (koe_is_member() AND (scope = 'global' OR (scope = 'personal' AND owner_id = %1$s)
      OR (scope = 'team' AND EXISTS (SELECT 1 FROM koe_team_members m WHERE m.team_id = koe_quick_replies.team_id AND m.user_id = %1$s)))))
    WITH CHECK (koe_is_lead() OR (koe_is_member() AND scope = 'personal' AND owner_id = %1$s))$p$, me);

  -- Notifications and push subscriptions: their owner.
  FOREACH t IN ARRAY ARRAY['koe_push_subscriptions', 'koe_notices'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (koe_is_system() OR user_id = %s) WITH CHECK (koe_is_system() OR user_id = %s)', t || '_access', t, me, me);
  END LOOP;

  -- Campaigns: leads.
  FOREACH t IN ARRAY ARRAY['koe_campaigns', 'koe_campaign_recipients', 'koe_sequence_runs'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (koe_is_lead()) WITH CHECK (koe_is_lead())', t || '_access', t);
  END LOOP;
END $$;
