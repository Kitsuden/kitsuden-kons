-- 0001 — Connections to third-party accounts (Google, Microsoft, and any provider a kon adds)
-- Idempotent.
--
-- One row per connected account. The credential (OAuth tokens or an API key) is a SealedSecret in
-- `credentials`, sealed by the host's `ctx.secrets` for this kon: the table never holds it readable,
-- and no route returns it.

CREATE TABLE IF NOT EXISTS conn_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  -- `user`: one person's account, seen and used by them alone. `organization`: the installation's,
  -- managed by an admin and used by kons on everyone's behalf.
  scope TEXT NOT NULL CHECK (scope IN ('user', 'organization')),
  owner_id TEXT,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('oauth', 'api_key')),
  label TEXT NOT NULL DEFAULT '',
  -- Who the account is at the provider (an email, a tenant): shown, never used to authenticate.
  account_id TEXT,
  account_email TEXT,
  granted_scopes JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked', 'error')),
  credentials JSONB,
  expires_at TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  last_error TEXT,
  expiry_notified_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A user connection belongs to someone; an organization's belongs to nobody in particular.
  CONSTRAINT conn_connections_owner CHECK ((scope = 'user') = (owner_id IS NOT NULL)),
  -- A revoked connection keeps no credential.
  CONSTRAINT conn_connections_revoked_empty CHECK (status <> 'revoked' OR credentials IS NULL)
);

CREATE INDEX IF NOT EXISTS conn_connections_owner_idx ON conn_connections (owner_id, provider);
CREATE INDEX IF NOT EXISTS conn_connections_expiry_idx ON conn_connections (expires_at) WHERE status = 'active';
-- The same account connected twice by the same owner is one connection, reconnected.
CREATE UNIQUE INDEX IF NOT EXISTS conn_connections_account_uidx
  ON conn_connections (provider, scope, COALESCE(owner_id, ''), COALESCE(account_id, ''))
  WHERE status <> 'revoked';

-- One OAuth round trip in flight: the `state` the provider sends back, hashed, and the PKCE verifier,
-- sealed. Ten minutes, then useless.
CREATE TABLE IF NOT EXISTS conn_oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'organization')),
  owner_id TEXT,
  user_id TEXT NOT NULL,
  requested_scopes JSONB NOT NULL DEFAULT '[]',
  verifier JSONB NOT NULL,
  return_to TEXT,
  label TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Row security ─────────────────────────────────────────────────────────────
--
--   system (no user in the context)   everything: the refresh worker and kons asking for a client
--   a person                          their own user connections
--   an admin                          the organization's connections, NOT other people's
--
-- An admin does not see anyone's personal mailbox connection: "admin" is not "reads my mail".

ALTER TABLE conn_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE conn_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conn_connections_system ON conn_connections;
CREATE POLICY conn_connections_system ON conn_connections FOR ALL TO PUBLIC
  USING (COALESCE(current_setting('app.current_user_id', true), '') = ''
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
  WITH CHECK (COALESCE(current_setting('app.current_user_id', true), '') = ''
         AND COALESCE(current_setting('app.current_user_role', true), '') = '');
DROP POLICY IF EXISTS conn_connections_owner ON conn_connections;
CREATE POLICY conn_connections_owner ON conn_connections FOR ALL TO PUBLIC
  USING (scope = 'user' AND COALESCE(current_setting('app.current_user_id', true), '') <> ''
         AND owner_id = current_setting('app.current_user_id', true))
  WITH CHECK (scope = 'user' AND COALESCE(current_setting('app.current_user_id', true), '') <> ''
         AND owner_id = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS conn_connections_admin ON conn_connections;
CREATE POLICY conn_connections_admin ON conn_connections FOR ALL TO PUBLIC
  USING (scope = 'organization' AND current_setting('app.current_user_role', true) = 'admin')
  WITH CHECK (scope = 'organization' AND current_setting('app.current_user_role', true) = 'admin');

ALTER TABLE conn_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE conn_oauth_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conn_oauth_states_system ON conn_oauth_states;
CREATE POLICY conn_oauth_states_system ON conn_oauth_states FOR ALL TO PUBLIC
  USING (COALESCE(current_setting('app.current_user_id', true), '') = ''
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
  WITH CHECK (COALESCE(current_setting('app.current_user_id', true), '') = ''
         AND COALESCE(current_setting('app.current_user_role', true), '') = '');
DROP POLICY IF EXISTS conn_oauth_states_owner ON conn_oauth_states;
CREATE POLICY conn_oauth_states_owner ON conn_oauth_states FOR ALL TO PUBLIC
  USING (COALESCE(current_setting('app.current_user_id', true), '') <> ''
         AND user_id = current_setting('app.current_user_id', true))
  WITH CHECK (COALESCE(current_setting('app.current_user_id', true), '') <> ''
         AND user_id = current_setting('app.current_user_id', true));
