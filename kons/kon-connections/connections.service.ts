/**
 * Connecting, refreshing and revoking
 * ============================================================================
 *
 * Everything that touches a credential lives here, and nothing here returns one: the routes and the other
 * kons get `PublicConnection`s and, through connections.client.ts, a `fetch` that adds the credential itself.
 *
 * ── THE CREDENTIAL ─────────────────────────────────────────────────────────
 *
 * Sealed with the host's `ctx.secrets` (`seal("kon-connections", json)`) before it is written, opened with a
 * stated purpose that the host records (`open(…, { purpose, subject, actorUserId })`). A host without
 * `ctx.secrets` (no secrets key, or an older Kitsuden) gets a 503 when connecting: the kon refuses to store a
 * credential readable rather than storing it anyway.
 *
 * ── OAUTH ──────────────────────────────────────────────────────────────────
 *
 * Authorization code with PKCE (S256). The `state` is 32 random bytes, stored hashed with the PKCE verifier
 * (sealed), the owner and the scope; it lasts ten minutes and is deleted the first time it is used, so a
 * callback replayed or forged finds nothing. The installation's client id and secret come from the
 * environment (connections.providers.ts).
 *
 * ── REFRESH AND EXPIRY ─────────────────────────────────────────────────────
 *
 * An access token is refreshed when it has less than five minutes left: by the worker before it runs out,
 * or by the client right before it is used. A refresh the provider answers with `invalid_grant` (consent
 * withdrawn, password changed, refresh token expired) leaves the connection `expired`, emptied of its
 * credential's access token, and announced once (`connections:connection.expired`). Other failures (the
 * provider down) are retried on the next tick and do not expire anything.
 */

import { createHash, randomBytes } from "node:crypto";

import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import {
  covers,
  oauthClientOf,
  providerOf,
  resolveScopes,
  type ProviderDefinition,
} from "./connections.providers";
import { connConnections, connOauthStates, type ConnectionRow, type SealedValue } from "./connections.schema";

export const KON_ID = "kon-connections";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Drizzle instance or transaction
export type Db = any;
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Kitsuden's `KonSecrets`, structurally: a host without it leaves `ctx.secrets` undefined. */
export interface Secrets {
  seal(konId: string, plaintext: string): SealedValue;
  open(konId: string, sealed: SealedValue, access: { purpose: string; subject?: string; actorUserId?: string | null }): Promise<string>;
}

/** What is inside the sealed `credentials`. */
export interface Credential {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  tokenType?: string;
}

export class ConnectionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 422 | 502 | 503,
    readonly code = "CONNECTION_ERROR"
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}

export const STATE_TTL_MS = 10 * 60_000;
/** Refresh when less than this is left. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const base64url = (buf: Buffer) => buf.toString("base64url");

function requireSecrets(secrets: Secrets | null | undefined): Secrets {
  if (!secrets) {
    throw new ConnectionError(
      "This Kitsuden cannot seal credentials (no secrets key): connections are refused rather than stored readable",
      503,
      "SECRETS_UNAVAILABLE"
    );
  }
  return secrets;
}

function requireProvider(id: string): ProviderDefinition {
  const provider = providerOf(id);
  if (!provider) throw new ConnectionError(`Unknown provider: ${id}`, 404, "UNKNOWN_PROVIDER");
  return provider;
}

function seal(secrets: Secrets, credential: Credential): SealedValue {
  return secrets.seal(KON_ID, JSON.stringify(credential));
}

export async function openCredential(
  secrets: Secrets,
  row: ConnectionRow,
  purpose: string,
  actorUserId: string | null
): Promise<Credential> {
  if (!row.credentials) throw new ConnectionError("This connection holds no credential", 409, "NO_CREDENTIAL");
  const text = await secrets.open(KON_ID, row.credentials, { purpose, subject: `connection:${row.id}`, actorUserId });
  return JSON.parse(text) as Credential;
}

// ── OAuth: start ────────────────────────────────────────────────────────────

export interface StartRequest {
  provider: string;
  scope: "user" | "organization";
  /** The person starting it: the owner of a `user` connection, the admin of an `organization` one. */
  userId: string;
  scopeSets: string[];
  redirectUri: string;
  returnTo?: string | null;
  label?: string;
  now?: Date;
}

export async function startOAuth(db: Db, secretsIn: Secrets | null | undefined, req: StartRequest): Promise<{ url: string; expiresAt: string }> {
  const secrets = requireSecrets(secretsIn);
  const provider = requireProvider(req.provider);
  if (!provider.oauth || !provider.authTypes.includes("oauth")) {
    throw new ConnectionError(`${provider.name} does not connect with OAuth`, 422, "NOT_OAUTH");
  }
  const client = oauthClientOf(provider);
  if (!client) {
    throw new ConnectionError(`${provider.name} is not configured on this installation`, 503, "PROVIDER_NOT_CONFIGURED");
  }
  let scopes: string[];
  try {
    scopes = resolveScopes(provider, req.scopeSets);
  } catch (err) {
    throw new ConnectionError((err as Error).message, 422, "UNKNOWN_SCOPE");
  }

  const state = base64url(randomBytes(32));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const now = req.now ?? new Date();
  const expiresAt = new Date(now.getTime() + STATE_TTL_MS);

  // Old round trips of the same person go: a forgotten tab is not a standing invitation.
  await db.delete(connOauthStates).where(lt(connOauthStates.expiresAt, now));
  await db.insert(connOauthStates).values({
    stateHash: sha256(state),
    provider: provider.id,
    scope: req.scope,
    ownerId: req.scope === "user" ? req.userId : null,
    userId: req.userId,
    requestedScopes: scopes,
    verifier: secrets.seal(KON_ID, verifier),
    returnTo: req.returnTo ?? null,
    label: (req.label ?? "").slice(0, 200),
    expiresAt,
  });

  const url = new URL(provider.oauth.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", req.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(provider.oauth.authorizeParams ?? {})) url.searchParams.set(k, v);
  return { url: url.toString(), expiresAt: expiresAt.toISOString() };
}

// ── OAuth: the provider sends the person back ──────────────────────────────

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(fetchFn: Fetch, provider: ProviderDefinition, form: Record<string, string>): Promise<TokenResponse> {
  const client = oauthClientOf(provider);
  if (!client || !provider.oauth) throw new ConnectionError(`${provider.name} is not configured`, 503, "PROVIDER_NOT_CONFIGURED");
  let res: Response;
  try {
    res = await fetchFn(provider.oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...form, client_id: client.clientId, client_secret: client.clientSecret }).toString(),
    });
  } catch {
    throw new ConnectionError(`${provider.name} did not answer`, 502, "PROVIDER_UNREACHABLE");
  }
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || body.error) return { ...body, error: body.error ?? `http_${res.status}` };
  return body;
}

export interface CompleteRequest {
  state: string;
  code: string;
  redirectUri: string;
  fetch: Fetch;
  now?: Date;
}

export interface Completed {
  connection: ConnectionRow;
  created: boolean;
  returnTo: string | null;
}

/** Runs as the system: the callback has no session, the `state` is what authenticates it. */
export async function completeOAuth(db: Db, secretsIn: Secrets | null | undefined, req: CompleteRequest): Promise<Completed> {
  const secrets = requireSecrets(secretsIn);
  const now = req.now ?? new Date();
  // Deleted as it is read: the same state works once.
  const [pending] = await db.delete(connOauthStates).where(eq(connOauthStates.stateHash, sha256(req.state || "-"))).returning();
  if (!pending || new Date(pending.expiresAt).getTime() < now.getTime()) {
    throw new ConnectionError("This connection link is unknown or expired: start again", 400, "INVALID_STATE");
  }
  const provider = requireProvider(pending.provider);
  const verifier = await secrets.open(KON_ID, pending.verifier, { purpose: "oauth-callback", subject: `provider:${provider.id}`, actorUserId: pending.userId });

  const tokens = await tokenRequest(req.fetch, provider, {
    grant_type: "authorization_code",
    code: req.code,
    redirect_uri: req.redirectUri,
    code_verifier: verifier,
  });
  if (tokens.error || !tokens.access_token) {
    throw new ConnectionError(`${provider.name} refused the connection (${tokens.error ?? "no token"})`, 502, "TOKEN_EXCHANGE_FAILED");
  }

  let identity: { accountId: string | null; accountEmail: string | null } = { accountId: null, accountEmail: null };
  if (provider.oauth?.userInfoUrl && provider.identity) {
    const info = await req
      .fetch(provider.oauth.userInfoUrl, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    identity = provider.identity(info as Record<string, unknown>);
  }

  const granted = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : (pending.requestedScopes as string[]);
  const values = {
    provider: provider.id,
    scope: pending.scope,
    ownerId: pending.ownerId,
    authType: "oauth" as const,
    label: pending.label || identity.accountEmail || provider.name,
    accountId: identity.accountId,
    accountEmail: identity.accountEmail,
    grantedScopes: granted,
    status: "active" as const,
    credentials: seal(secrets, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, tokenType: tokens.token_type }),
    expiresAt: tokens.expires_in ? new Date(now.getTime() + tokens.expires_in * 1000) : null,
    lastRefreshedAt: now,
    lastError: null,
    expiryNotifiedAt: null,
    revokedAt: null,
    updatedAt: now,
  };

  // The same account connected again by the same owner: reconnected, not duplicated. A reconnection that
  // brings no refresh token (Google omits it without `prompt=consent`) keeps the one it had.
  const [existing] = await db
    .select()
    .from(connConnections)
    .where(
      and(
        eq(connConnections.provider, provider.id),
        eq(connConnections.scope, pending.scope),
        pending.ownerId ? eq(connConnections.ownerId, pending.ownerId) : isNull(connConnections.ownerId),
        identity.accountId ? eq(connConnections.accountId, identity.accountId) : isNull(connConnections.accountId),
        sql`${connConnections.status} <> 'revoked'`
      )
    )
    .limit(1);
  if (existing) {
    if (!tokens.refresh_token && existing.credentials) {
      const old = await openCredential(secrets, existing, "reconnect", pending.userId).catch(() => ({}) as Credential);
      values.credentials = seal(secrets, { accessToken: tokens.access_token, refreshToken: old.refreshToken, tokenType: tokens.token_type });
    }
    const [row] = await db.update(connConnections).set(values).where(eq(connConnections.id, existing.id)).returning();
    return { connection: row, created: false, returnTo: pending.returnTo ?? null };
  }
  const [row] = await db.insert(connConnections).values({ ...values, createdBy: pending.userId }).returning();
  return { connection: row, created: true, returnTo: pending.returnTo ?? null };
}

// ── API keys ────────────────────────────────────────────────────────────────

export interface ApiKeyRequest {
  provider: string;
  scope: "user" | "organization";
  userId: string;
  apiKey: string;
  label?: string;
  accountId?: string | null;
}

export async function addApiKey(db: Db, secretsIn: Secrets | null | undefined, req: ApiKeyRequest): Promise<ConnectionRow> {
  const secrets = requireSecrets(secretsIn);
  const provider = requireProvider(req.provider);
  if (!provider.authTypes.includes("api_key")) {
    throw new ConnectionError(`${provider.name} does not take an API key`, 422, "NOT_API_KEY");
  }
  const key = req.apiKey.trim();
  if (key.length < 8 || key.length > 4096 || /\s/.test(key)) throw new ConnectionError("That does not look like an API key", 422, "BAD_API_KEY");
  const [row] = await db
    .insert(connConnections)
    .values({
      provider: provider.id,
      scope: req.scope,
      ownerId: req.scope === "user" ? req.userId : null,
      authType: "api_key",
      label: (req.label ?? provider.name).slice(0, 200),
      accountId: req.accountId ?? null,
      accountEmail: null,
      grantedScopes: [],
      status: "active",
      credentials: seal(secrets, { apiKey: key }),
      createdBy: req.userId,
    })
    .returning();
  return row;
}

// ── Refresh ─────────────────────────────────────────────────────────────────

export type RefreshOutcome = "refreshed" | "not-needed" | "expired" | "failed";

/** `invalid_grant` and friends: the provider will never accept this refresh token again. */
const FINAL_ERRORS = new Set(["invalid_grant", "unauthorized_client", "invalid_client"]);

export async function refreshConnection(
  db: Db,
  secretsIn: Secrets | null | undefined,
  row: ConnectionRow,
  options: { fetch: Fetch; now?: Date; force?: boolean; actorUserId?: string | null }
): Promise<{ outcome: RefreshOutcome; connection: ConnectionRow }> {
  const secrets = requireSecrets(secretsIn);
  const now = options.now ?? new Date();
  if (row.authType !== "oauth" || row.status !== "active") return { outcome: "not-needed", connection: row };
  const left = row.expiresAt ? new Date(row.expiresAt).getTime() - now.getTime() : Infinity;
  if (!options.force && left > REFRESH_MARGIN_MS) return { outcome: "not-needed", connection: row };

  const provider = requireProvider(row.provider);
  const credential = await openCredential(secrets, row, "refresh", options.actorUserId ?? null);
  if (!credential.refreshToken) {
    const [expired] = await db
      .update(connConnections)
      .set({ status: "expired", lastError: "No refresh token: connect again", updatedAt: now })
      .where(eq(connConnections.id, row.id))
      .returning();
    return { outcome: "expired", connection: expired };
  }

  let tokens: TokenResponse;
  try {
    tokens = await tokenRequest(options.fetch, provider, { grant_type: "refresh_token", refresh_token: credential.refreshToken });
  } catch (err) {
    const [failed] = await db
      .update(connConnections)
      .set({ lastError: (err as Error).message.slice(0, 500), updatedAt: now })
      .where(eq(connConnections.id, row.id))
      .returning();
    return { outcome: "failed", connection: failed };
  }

  if (tokens.error || !tokens.access_token) {
    const final = FINAL_ERRORS.has(tokens.error ?? "");
    const [changed] = await db
      .update(connConnections)
      .set({
        ...(final
          ? { status: "expired" as const, credentials: null }
          : {}),
        lastError: `${provider.name}: ${tokens.error ?? "no token"}`.slice(0, 500),
        updatedAt: now,
      })
      .where(eq(connConnections.id, row.id))
      .returning();
    return { outcome: final ? "expired" : "failed", connection: changed };
  }

  const [refreshed] = await db
    .update(connConnections)
    .set({
      credentials: seal(secrets, {
        accessToken: tokens.access_token,
        // Microsoft rotates the refresh token; Google keeps the old one valid and omits it.
        refreshToken: tokens.refresh_token ?? credential.refreshToken,
        tokenType: tokens.token_type ?? credential.tokenType,
      }),
      expiresAt: tokens.expires_in ? new Date(now.getTime() + tokens.expires_in * 1000) : null,
      grantedScopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : row.grantedScopes,
      lastRefreshedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(connConnections.id, row.id))
    .returning();
  return { outcome: "refreshed", connection: refreshed };
}

/** Active OAuth connections that run out within the margin (the worker's list). */
export async function dueForRefresh(db: Db, now = new Date(), limit = 50): Promise<ConnectionRow[]> {
  return db
    .select()
    .from(connConnections)
    .where(
      and(
        eq(connConnections.status, "active"),
        eq(connConnections.authType, "oauth"),
        lt(connConnections.expiresAt, new Date(now.getTime() + REFRESH_MARGIN_MS))
      )
    )
    .limit(limit);
}

/** Expired connections nobody was told about yet; marks them told. */
export async function takeUnnotifiedExpired(db: Db, now = new Date()): Promise<ConnectionRow[]> {
  return db
    .update(connConnections)
    .set({ expiryNotifiedAt: now })
    .where(and(eq(connConnections.status, "expired"), isNull(connConnections.expiryNotifiedAt)))
    .returning();
}

// ── Revoke ──────────────────────────────────────────────────────────────────

/**
 * Revoked at the provider when it has a revoke endpoint (best effort: a provider that does not answer does
 * not keep the credential here), then the credential is deleted and the row kept, `revoked`, for the record.
 */
export async function revokeConnection(
  db: Db,
  secrets: Secrets | null | undefined,
  row: ConnectionRow,
  options: { fetch: Fetch; actorUserId: string | null; now?: Date }
): Promise<{ connection: ConnectionRow; atProvider: boolean }> {
  const now = options.now ?? new Date();
  if (row.status === "revoked") return { connection: row, atProvider: false };
  let atProvider = false;
  const provider = providerOf(row.provider);
  if (secrets && row.credentials && provider?.oauth?.revokeUrl) {
    try {
      const credential = await openCredential(secrets, row, "revoke", options.actorUserId);
      const token = credential.refreshToken ?? credential.accessToken;
      if (token) {
        const res = await options.fetch(provider.oauth.revokeUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
        });
        atProvider = res.ok;
      }
    } catch {
      atProvider = false;
    }
  }
  const [revoked] = await db
    .update(connConnections)
    .set({ status: "revoked", credentials: null, revokedAt: now, updatedAt: now, lastError: null })
    .where(eq(connConnections.id, row.id))
    .returning();
  return { connection: revoked, atProvider };
}

// ── Finding a connection ───────────────────────────────────────────────────

export interface Wanted {
  provider: string;
  /** A person's own connection; without it, the organization's. */
  ownerId?: string | null;
  /** Named scope sets the connection must cover (`mail.read`). */
  scopeSets?: string[];
  connectionId?: string;
}

/** The best active connection for a need, or `null`. Runs as the caller: RLS decides what it may see. */
export async function findConnection(db: Db, wanted: Wanted): Promise<ConnectionRow | null> {
  const provider = requireProvider(wanted.provider);
  const conditions = [eq(connConnections.provider, provider.id), or(eq(connConnections.status, "active"), eq(connConnections.status, "expired"))];
  if (wanted.connectionId) conditions.push(eq(connConnections.id, wanted.connectionId));
  else if (wanted.ownerId) conditions.push(and(eq(connConnections.scope, "user"), eq(connConnections.ownerId, wanted.ownerId)));
  else conditions.push(eq(connConnections.scope, "organization"));
  const rows: ConnectionRow[] = await db.select().from(connConnections).where(and(...conditions)).limit(20);
  const usable = rows.filter((r) => covers(provider, r.grantedScopes ?? [], wanted.scopeSets ?? []));
  return usable.find((r) => r.status === "active") ?? usable[0] ?? null;
}
