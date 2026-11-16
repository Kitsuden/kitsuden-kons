/**
 * The provider catalog
 * ============================================================================
 *
 * What each provider is: how to get a token (OAuth 2.0 with PKCE) or what an API key looks like, where the
 * token may be sent, how to refresh and revoke it, and which named scope sets a kon may ask for.
 *
 * Google and Microsoft come with the kon. Another kon adds its own with `registerProvider()` (a payments or
 * email service with an API key, say); the catalog is the one place connections know a provider by.
 *
 * ── WHERE A TOKEN MAY GO ───────────────────────────────────────────────────
 *
 * `apiHosts` lists the hosts the client (connections.client.ts) will send the token to. A kon asks for
 * `fetch("https://gmail.googleapis.com/…")`; anything off the list is refused before a request is made, so a
 * URL built from data (a link in an email, a webhook payload) can never carry the token somewhere else.
 *
 * ── CREDENTIALS OF THE APP ITSELF ──────────────────────────────────────────
 *
 * The OAuth client id and secret are the installation's, from the environment
 * (`CONNECTIONS_GOOGLE_CLIENT_ID`, `CONNECTIONS_GOOGLE_CLIENT_SECRET`, `CONNECTIONS_MICROSOFT_…`,
 * `CONNECTIONS_MICROSOFT_TENANT`, default `common`). A provider without them is listed as not configured and
 * cannot be connected; nothing else changes.
 */

export interface OAuthSpec {
  authorizeUrl: string;
  tokenUrl: string;
  /** Where a token is revoked. Absent: revoking only forgets it here. */
  revokeUrl?: string;
  /** Where to read who the account is, with the new access token. */
  userInfoUrl?: string;
  /** Scopes always asked for (identity, offline access). */
  baseScopes: string[];
  /** Extra query parameters on the authorize URL (`access_type=offline`, `prompt=consent`). */
  authorizeParams?: Record<string, string>;
  /** Environment variable names of the installation's OAuth client. */
  clientIdEnv: string;
  clientSecretEnv: string;
}

export interface ProviderDefinition {
  /** `google`, `microsoft`: lower case, the id stored on each connection. */
  id: string;
  name: string;
  authTypes: Array<"oauth" | "api_key">;
  oauth?: OAuthSpec;
  /** Named scope sets a kon or a person may ask for: `mail.read` → the provider's real scopes. */
  scopeSets: Record<string, { description: string; scopes: string[] }>;
  /** Hosts the token may be sent to (https only). */
  apiHosts: string[];
  /**
   * How an API key goes on a request. Default: `Authorization: Bearer <key>`. `encode` turns the key into
   * the header's value when a prefix is not enough (Mailgun: `Basic base64("api:" + key)`).
   */
  apiKeyHeader?: { name: string; prefix?: string; encode?: (key: string) => string };
  /** Reads `{ accountId, accountEmail }` from the user info response. */
  identity?(userInfo: Record<string, unknown>): { accountId: string | null; accountEmail: string | null };
}

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
};

function microsoftTenant(): string {
  const tenant = env("CONNECTIONS_MICROSOFT_TENANT") ?? "common";
  return /^[A-Za-z0-9.-]{1,100}$/.test(tenant) ? tenant : "common";
}

export const GOOGLE: ProviderDefinition = {
  id: "google",
  name: "Google",
  authTypes: ["oauth"],
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    baseScopes: ["openid", "email", "profile"],
    // Without both, Google gives no refresh token on a second consent.
    authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    clientIdEnv: "CONNECTIONS_GOOGLE_CLIENT_ID",
    clientSecretEnv: "CONNECTIONS_GOOGLE_CLIENT_SECRET",
  },
  scopeSets: {
    "mail.read": { description: "Read email", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
    "mail.send": { description: "Send email as the account", scopes: ["https://www.googleapis.com/auth/gmail.send"] },
    "calendar.read": {
      description: "Read calendars and events",
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    },
  },
  apiHosts: ["gmail.googleapis.com", "www.googleapis.com", "openidconnect.googleapis.com"],
  identity: (u) => ({
    accountId: typeof u.sub === "string" ? u.sub : null,
    accountEmail: typeof u.email === "string" ? u.email.toLowerCase() : null,
  }),
};

export const MICROSOFT: ProviderDefinition = {
  id: "microsoft",
  name: "Microsoft 365",
  authTypes: ["oauth"],
  get oauth(): OAuthSpec {
    const tenant = microsoftTenant();
    return {
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      userInfoUrl: "https://graph.microsoft.com/oidc/userinfo",
      baseScopes: ["openid", "email", "profile", "offline_access", "User.Read"],
      clientIdEnv: "CONNECTIONS_MICROSOFT_CLIENT_ID",
      clientSecretEnv: "CONNECTIONS_MICROSOFT_CLIENT_SECRET",
    };
  },
  scopeSets: {
    "mail.read": { description: "Read email", scopes: ["Mail.Read"] },
    "mail.send": { description: "Send email as the account", scopes: ["Mail.Send"] },
    "calendar.read": { description: "Read calendars and events", scopes: ["Calendars.Read"] },
  },
  apiHosts: ["graph.microsoft.com"],
  identity: (u) => ({
    accountId: typeof u.sub === "string" ? u.sub : null,
    accountEmail:
      typeof u.email === "string"
        ? u.email.toLowerCase()
        : typeof u.preferred_username === "string"
          ? u.preferred_username.toLowerCase()
          : null,
  }),
};

const PROVIDER_ID = /^[a-z][a-z0-9-]{1,39}$/;
const catalog = new Map<string, ProviderDefinition>([
  [GOOGLE.id, GOOGLE],
  [MICROSOFT.id, MICROSOFT],
]);

/** Why a definition cannot join the catalog, or `null`. */
export function providerProblem(p: ProviderDefinition): string | null {
  if (!PROVIDER_ID.test(p.id)) return `provider id "${p.id}" must be lower case letters, digits and "-"`;
  if (!p.name?.trim()) return `provider ${p.id} needs a name`;
  if (!p.authTypes?.length) return `provider ${p.id} needs at least one auth type`;
  if (p.authTypes.includes("oauth") && !p.oauth) return `provider ${p.id} says oauth but has no oauth spec`;
  if (!p.apiHosts?.length) return `provider ${p.id} must list the hosts its token may be sent to`;
  for (const host of p.apiHosts) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return `provider ${p.id}: "${host}" is not a host name`;
  }
  if (p.oauth) {
    for (const url of [p.oauth.authorizeUrl, p.oauth.tokenUrl, p.oauth.revokeUrl, p.oauth.userInfoUrl]) {
      if (url !== undefined && !url.startsWith("https://")) return `provider ${p.id}: ${url} is not https`;
    }
  }
  return null;
}

/**
 * Adds a provider (another kon's API key service, a self-hosted IdP). Replacing Google or Microsoft is
 * refused: a kon must not redirect everyone's tokens.
 */
export function registerProvider(p: ProviderDefinition): void {
  const problem = providerProblem(p);
  if (problem) throw new Error(`connections: ${problem}`);
  if (p.id === GOOGLE.id || p.id === MICROSOFT.id) throw new Error(`connections: ${p.id} is built in`);
  catalog.set(p.id, p);
}

export function providerOf(id: string): ProviderDefinition | null {
  return catalog.get(id) ?? null;
}

export function providers(): ProviderDefinition[] {
  return [...catalog.values()];
}

/** The installation's OAuth client, or `null` when it is not configured. */
export function oauthClientOf(p: ProviderDefinition): { clientId: string; clientSecret: string } | null {
  if (!p.oauth) return null;
  const clientId = env(p.oauth.clientIdEnv);
  const clientSecret = env(p.oauth.clientSecretEnv);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** `["mail.read", "calendar.read"]` → the provider's scopes, base scopes first, no repeats. */
export function resolveScopes(p: ProviderDefinition, sets: string[]): string[] {
  const unknown = sets.filter((s) => !p.scopeSets[s]);
  if (unknown.length) throw new Error(`unknown scope set for ${p.id}: ${unknown.join(", ")}`);
  return [...new Set([...(p.oauth?.baseScopes ?? []), ...sets.flatMap((s) => p.scopeSets[s]!.scopes)])];
}

/** Whether a connection's granted scopes cover these named sets. */
export function covers(p: ProviderDefinition, granted: string[], sets: string[]): boolean {
  const have = new Set(granted);
  return sets.every((s) => (p.scopeSets[s]?.scopes ?? [s]).every((scope) => have.has(scope)));
}

/** What the catalog says about a provider, for the panel: never a secret. */
export function describeProvider(p: ProviderDefinition) {
  return {
    id: p.id,
    name: p.name,
    authTypes: p.authTypes,
    configured: p.authTypes.includes("api_key") || oauthClientOf(p) !== null,
    scopeSets: Object.fromEntries(Object.entries(p.scopeSets).map(([k, v]) => [k, v.description])),
  };
}
