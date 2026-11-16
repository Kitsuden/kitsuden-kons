/**
 * kon-connections: connect, refresh, revoke, hand out a client, and keep people apart
 * ============================================================================
 *
 * Real Postgres (PGlite) with the kon's migration, as a NON-superuser role so row security filters. The
 * host's `ctx.secrets` is a double with the contract's shape (AES-256-GCM, every open recorded); the
 * provider is a `fetch` double that answers like Google's token, userinfo, revoke and Gmail endpoints.
 *
 * What these tests hold:
 *   - OAuth uses PKCE S256; the state is stored hashed, the verifier sealed, and a state works once;
 *   - no token or key is ever in a row readable, in a response, or on the client object;
 *   - without `ctx.secrets` the kon refuses to connect rather than store a credential readable;
 *   - a token close to expiry is refreshed; `invalid_grant` expires the connection, announced once;
 *   - revoking calls the provider, deletes the credential and keeps the row;
 *   - the client sends the credential only to the provider's hosts, and retries a 401 once;
 *   - a person sees only their own connections; an admin the organization's and not a person's;
 *     an agent cannot start a consent.
 */

import type { PGlite } from "@electric-sql/pglite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { allowedUrl, clientFor } from "../../kons/kon-connections/connections.client";
import { registerProvider } from "../../kons/kon-connections/connections.providers";
import { connConnections } from "../../kons/kon-connections/connections.schema";
import { eq } from "drizzle-orm";
import {
  addApiKey,
  completeOAuth,
  refreshConnection,
  revokeConnection,
  startOAuth,
  takeUnnotifiedExpired,
  type Secrets,
} from "../../kons/kon-connections/connections.service";
import { connectionsOperations, refreshTick } from "../../kons/kon-connections/index";
import { KON_ID } from "../../kons/kon-connections/operations";
import { registerConnectionsPolicy } from "../../kons/kon-connections/connections.policy";
import { operationsRouter } from "@kitsuden/engine";

import { ACTORS, APP_ROLE, AGENT_FUNCTIONS, dropToAppRole, requestAs, testAuth } from "./helpers/safe-kons-bench";
import { PGlite as PG } from "@electric-sql/pglite";

// ── The host's secrets, as a double ────────────────────────────────────────

const KEY = randomBytes(32);
const opened: Array<{ kon: string; purpose: string; subject?: string }> = [];
const secrets: Secrets = {
  seal(kon, plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", KEY, iv);
    cipher.setAAD(Buffer.from(kon));
    const valueEncrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
    return { v: 1, kon, valueEncrypted, iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
  },
  async open(kon, sealed, access) {
    if (sealed.kon !== kon) throw new Error("sealed for another kon");
    opened.push({ kon, purpose: access.purpose, subject: access.subject });
    const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(Buffer.from(kon));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.valueEncrypted, "base64")), decipher.final()]).toString("utf8");
  },
};

// ── The provider, as a double ──────────────────────────────────────────────

interface Call {
  url: string;
  init?: RequestInit;
}
const calls: Call[] = [];
let tokenAnswer: () => Response;
let gmailAnswers: number[] = [];
let tokenCounter = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const network = async (url: string, init?: RequestInit): Promise<Response> => {
  calls.push({ url, init });
  if (url === "https://oauth2.googleapis.com/token") return tokenAnswer();
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") return json({ sub: "g-123", email: "Ana@Gmail.example" });
  if (url === "https://oauth2.googleapis.com/revoke") return new Response("", { status: 200 });
  if (url.startsWith("https://gmail.googleapis.com/")) return json({ ok: true }, gmailAnswers.shift() ?? 200);
  return new Response("not found", { status: 404 });
};
const issued = (over: Record<string, unknown> = {}) => () =>
  json({
    access_token: `access-${++tokenCounter}`,
    refresh_token: "refresh-original",
    expires_in: 3600,
    scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
    token_type: "Bearer",
    ...over,
  });

// ── Database ───────────────────────────────────────────────────────────────

let client: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a drizzle over PGlite
let db: any;
const A = ACTORS.a.id;
const B = ACTORS.b.id;
const env: Record<string, string | undefined> = {};

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  await client.exec("RESET ROLE");
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.exec(`SET ROLE ${APP_ROLE}`);
  }
}

async function ex(sql: string): Promise<void> {
  await client.exec(`RESET ROLE; ${sql}; SET ROLE ${APP_ROLE};`);
}

/** The system (no user in the context) is what the app role is outside a request: no transaction needed. */
async function asActor<T>(actor: null, fn: () => Promise<T>): Promise<T> {
  void actor;
  return fn();
}

/** Raw SQL as a person, the way `withTransactionalRLS` sets the context. */
async function sqlAsPerson(actor: { id: string; role: string }, sql: string): Promise<void> {
  await client.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.current_user_role', $2, true)", [actor.id, actor.role]);
    await tx.query(sql);
  });
}

beforeAll(async () => {
  client = new PG();
  await client.exec(readFileSync(AGENT_FUNCTIONS, "utf8"));
  await client.exec(readFileSync(resolve(__dirname, "../../kons/kon-connections/migrations/0001_connections.sql"), "utf8"));
  await client.exec(`
    CREATE ROLE ${APP_ROLE} NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
  `);
  db = await dropToAppRole(client);
  registerConnectionsPolicy();
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  for (const k of ["CONNECTIONS_GOOGLE_CLIENT_ID", "CONNECTIONS_GOOGLE_CLIENT_SECRET", "ALLOWED_ORIGINS", "CONNECTIONS_RETURN_ORIGINS"]) env[k] = process.env[k];
  process.env.CONNECTIONS_GOOGLE_CLIENT_ID = "client-id.apps.example";
  process.env.CONNECTIONS_GOOGLE_CLIENT_SECRET = "client-secret-value";
  process.env.ALLOWED_ORIGINS = "https://site.example";
  delete process.env.CONNECTIONS_RETURN_ORIGINS;
  calls.length = 0;
  opened.length = 0;
  gmailAnswers = [];
  tokenCounter = 0;
  tokenAnswer = issued();
  await ex("DELETE FROM conn_connections; DELETE FROM conn_oauth_states");
});

afterEach(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const REDIRECT = "https://api.site.example/api/connections/oauth/callback";

async function connectAna(): Promise<string> {
  const { url } = await asActor(null, () =>
    startOAuth(db, secrets, { provider: "google", scope: "user", userId: A, scopeSets: ["mail.read"], redirectUri: REDIRECT })
  );
  const state = new URL(url).searchParams.get("state")!;
  const done = await asActor(null, () => completeOAuth(db, secrets, { state, code: "the-code", redirectUri: REDIRECT, fetch: network }));
  return done.connection.id;
}

describe("OAuth", () => {
  it("asks for consent with PKCE S256, and stores the state hashed and the verifier sealed", async () => {
    const { url } = await asActor(null, () =>
      startOAuth(db, secrets, { provider: "google", scope: "user", userId: A, scopeSets: ["mail.read", "calendar.read"], redirectUri: REDIRECT })
    );
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("scope")!.split(" ")).toEqual(
      expect.arrayContaining(["openid", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.readonly"])
    );
    const state = u.searchParams.get("state")!;
    const [row] = await q<{ state_hash: string; verifier: Record<string, unknown> }>("SELECT state_hash, verifier FROM conn_oauth_states");
    expect(row!.state_hash).toBe(createHash("sha256").update(state).digest("hex"));
    expect(row!.verifier).toMatchObject({ v: 1, kon: KON_ID });
  });

  it("the code is exchanged with the verifier that matches the challenge, and the credential is stored sealed", async () => {
    const { url } = await asActor(null, () =>
      startOAuth(db, secrets, { provider: "google", scope: "user", userId: A, scopeSets: ["mail.read"], redirectUri: REDIRECT })
    );
    const u = new URL(url);
    const done = await asActor(null, () =>
      completeOAuth(db, secrets, { state: u.searchParams.get("state")!, code: "the-code", redirectUri: REDIRECT, fetch: network })
    );
    const exchange = new URLSearchParams(String(calls.find((c) => c.url.endsWith("/token"))!.init!.body));
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(u.searchParams.get("code_challenge"));

    expect(done.created).toBe(true);
    expect(done.connection).toMatchObject({ provider: "google", scope: "user", ownerId: A, accountEmail: "ana@gmail.example", status: "active" });
    const raw = JSON.stringify(await q("SELECT * FROM conn_connections"));
    expect(raw).not.toContain("access-1");
    expect(raw).not.toContain("refresh-original");
  });

  it("a state works once, and not after ten minutes", async () => {
    const { url } = await asActor(null, () =>
      startOAuth(db, secrets, { provider: "google", scope: "user", userId: A, scopeSets: [], redirectUri: REDIRECT })
    );
    const state = new URL(url).searchParams.get("state")!;
    await asActor(null, () => completeOAuth(db, secrets, { state, code: "c", redirectUri: REDIRECT, fetch: network }));
    await expect(asActor(null, () => completeOAuth(db, secrets, { state, code: "c", redirectUri: REDIRECT, fetch: network }))).rejects.toMatchObject({
      status: 400,
      code: "INVALID_STATE",
    });

    const late = await asActor(null, () =>
      startOAuth(db, secrets, { provider: "google", scope: "user", userId: A, scopeSets: [], redirectUri: REDIRECT, now: new Date(Date.now() - 11 * 60_000) })
    );
    await expect(
      asActor(null, () => completeOAuth(db, secrets, { state: new URL(late.url).searchParams.get("state")!, code: "c", redirectUri: REDIRECT, fetch: network }))
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("connecting the same account again reconnects it, keeping the refresh token when none comes", async () => {
    const first = await connectAna();
    tokenAnswer = issued({ refresh_token: undefined });
    const second = await connectAna();
    expect(second).toBe(first);
    expect(await q("SELECT 1 FROM conn_connections")).toHaveLength(1);
    // Refreshing proves the old refresh token survived.
    const [row] = await asActor(null, () => db.select().from(connConnections));
    tokenAnswer = issued();
    await asActor(null, () => refreshConnection(db, secrets, row, { fetch: network, force: true }));
    const refresh = new URLSearchParams(String(calls.filter((c) => c.url.endsWith("/token")).at(-1)!.init!.body));
    expect(refresh.get("refresh_token")).toBe("refresh-original");
  });

  it("without the host's secrets, nothing is connected", async () => {
    await expect(
      asActor(null, () => startOAuth(db, null, { provider: "google", scope: "user", userId: A, scopeSets: [], redirectUri: REDIRECT }))
    ).rejects.toMatchObject({ status: 503, code: "SECRETS_UNAVAILABLE" });
    await expect(asActor(null, () => addApiKey(db, undefined, { provider: "google", scope: "user", userId: A, apiKey: "x".repeat(20) }))).rejects.toMatchObject({
      status: 503,
    });
  });

  it("a provider without its client id is not configured, and an unknown scope set is refused", async () => {
    delete process.env.CONNECTIONS_GOOGLE_CLIENT_ID;
    await expect(
      asActor(null, () => startOAuth(db, secrets, { provider: "google", scope: "user", userId: A, scopeSets: [], redirectUri: REDIRECT }))
    ).rejects.toMatchObject({ status: 503, code: "PROVIDER_NOT_CONFIGURED" });
    process.env.CONNECTIONS_GOOGLE_CLIENT_ID = "x";
    await expect(
      asActor(null, () => startOAuth(db, secrets, { provider: "google", scope: "user", userId: A, scopeSets: ["drive.everything"], redirectUri: REDIRECT }))
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("refresh, expiry and revoke", () => {
  it("refreshes a token about to run out, and leaves a fresh one alone", async () => {
    const id = await connectAna();
    const [row] = await asActor(null, () => db.select().from(connConnections).where(eq(connConnections.id, id)));
    expect((await asActor(null, () => refreshConnection(db, secrets, row, { fetch: network }))).outcome).toBe("not-needed");
    const soon = new Date(new Date(row.expiresAt).getTime() - 2 * 60_000);
    expect((await asActor(null, () => refreshConnection(db, secrets, row, { fetch: network, now: soon }))).outcome).toBe("refreshed");
  });

  it("invalid_grant expires the connection, drops its credential, and is announced once", async () => {
    await connectAna();
    tokenAnswer = () => json({ error: "invalid_grant" }, 400);
    const emitted: Array<{ name: string; data: Record<string, unknown> }> = [];
    const ctx = {
      db: { instance: db, asSystem: <T>(f: () => Promise<T>) => asActor(null, f) },
      secrets,
      events: { emit: (name: string, data: Record<string, unknown>) => emitted.push({ name, data }) },
      logger: { warn: () => undefined, info: () => undefined },
    } as never;
    const far = new Date(Date.now() + 2 * 3600_000);
    expect(await refreshTick(ctx, network, far)).toEqual({ refreshed: 0, expired: 1, failed: 0 });
    const [row] = await q<{ status: string; credentials: unknown }>("SELECT status, credentials FROM conn_connections");
    expect(row).toEqual({ status: "expired", credentials: null });
    expect(emitted.map((e) => e.name)).toEqual(["connections:connection.expired"]);
    await refreshTick(ctx, network, far);
    expect(emitted).toHaveLength(1);
    expect(await asActor(null, () => takeUnnotifiedExpired(db))).toEqual([]);
  });

  it("a provider that does not answer leaves the connection active, to retry", async () => {
    await connectAna();
    const [row] = await asActor(null, () => db.select().from(connConnections));
    const down = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await asActor(null, () => refreshConnection(db, secrets, row, { fetch: down, force: true }));
    expect(r.outcome).toBe("failed");
    expect(r.connection.status).toBe("active");
  });

  it("revoking calls the provider and deletes the credential, keeping the record", async () => {
    await connectAna();
    const [row] = await asActor(null, () => db.select().from(connConnections));
    const r = await asActor(null, () => revokeConnection(db, secrets, row, { fetch: network, actorUserId: A }));
    expect(r.atProvider).toBe(true);
    expect(new URLSearchParams(String(calls.find((c) => c.url.endsWith("/revoke"))!.init!.body)).get("token")).toBe("refresh-original");
    expect(await q("SELECT status, credentials FROM conn_connections")).toEqual([{ status: "revoked", credentials: null }]);
  });
});

describe("the client other kons get", () => {
  it("adds the credential for the provider's hosts and refuses any other host before sending", async () => {
    await connectAna();
    const gmail = await asActor(null, () => clientFor(db, secrets, { provider: "google", ownerId: A, scopeSets: ["mail.read"], purpose: "test: read mail" }, network));
    expect(JSON.stringify(gmail)).not.toMatch(/access-|refresh-/);
    const res = await asActor(null, () => gmail.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages"));
    expect(res.status).toBe(200);
    expect(new Headers(calls.at(-1)!.init!.headers).get("authorization")).toBe("Bearer access-1");
    expect(opened.at(-1)).toMatchObject({ kon: KON_ID, purpose: "test: read mail" });

    const sent = calls.length;
    await expect(asActor(null, () => gmail.fetch("https://evil.example/steal"))).rejects.toMatchObject({ status: 403, code: "HOST_NOT_ALLOWED" });
    await expect(asActor(null, () => gmail.fetch("http://gmail.googleapis.com/x"))).rejects.toMatchObject({ status: 403 });
    expect(calls.length).toBe(sent);
  });

  it("a 401 is retried once with a fresh token; a second 401 marks the connection in error", async () => {
    await connectAna();
    const gmail = await asActor(null, () => clientFor(db, secrets, { provider: "google", ownerId: A, purpose: "test" }, network));
    gmailAnswers = [401, 200];
    expect((await asActor(null, () => gmail.fetch("https://gmail.googleapis.com/gmail/v1/x"))).status).toBe(200);
    expect(new Headers(calls.at(-1)!.init!.headers).get("authorization")).toBe("Bearer access-2");
    gmailAnswers = [401, 401];
    expect((await asActor(null, () => gmail.fetch("https://gmail.googleapis.com/gmail/v1/x"))).status).toBe(401);
    expect(await q("SELECT status FROM conn_connections")).toEqual([{ status: "error" }]);
  });

  it("asks for a connection that covers the scopes, and says which is missing", async () => {
    await connectAna();
    await expect(asActor(null, () => clientFor(db, secrets, { provider: "google", ownerId: A, scopeSets: ["mail.send"], purpose: "x" }))).rejects.toMatchObject({
      status: 404,
      code: "NO_CONNECTION",
    });
    await expect(asActor(null, () => clientFor(db, secrets, { provider: "google", ownerId: B, purpose: "x" }))).rejects.toMatchObject({ status: 404 });
  });

  it("an API key provider registered by another kon puts the key in its own header", async () => {
    registerProvider({ id: "mailer-test", name: "Mailer", authTypes: ["api_key"], scopeSets: {}, apiHosts: ["api.mailer.example"], apiKeyHeader: { name: "x-api-key" } });
    await asActor(null, () => addApiKey(db, secrets, { provider: "mailer-test", scope: "organization", userId: ACTORS.admin.id, apiKey: "mk_live_abcdefgh" }));
    const mailer = await asActor(null, () => clientFor(db, secrets, { provider: "mailer-test", purpose: "send" }, network));
    await asActor(null, () => mailer.fetch("https://api.mailer.example/v1/send").catch(() => undefined));
    expect(new Headers(calls.at(-1)!.init!.headers).get("x-api-key")).toBe("mk_live_abcdefgh");
    expect(allowedUrl("mailer-test", "https://api.mailer.example.evil.example/")).toBe(false);
    expect(() => registerProvider({ id: "google", name: "Fake", authTypes: ["api_key"], scopeSets: {}, apiHosts: ["evil.example"] })).toThrow(/built in/);
  });
});

describe("people are kept apart", () => {
  let request: ReturnType<typeof requestAs>;

  beforeAll(async () => {
    const auth = testAuth();
    const host = rlsHost(db, auth);
    const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
    // The host puts its sealer on the context (Kitsuden's `ctx.secrets`); the test context has no slot for it.
    Object.assign(ctx, { secrets });
    request = requestAs(host.mount(operationsRouter(KON_ID, connectionsOperations(ctx, network), ctx)));
  });

  beforeEach(async () => {
    await ex(`
      INSERT INTO conn_connections (provider, scope, owner_id, auth_type, label, status) VALUES
        ('google', 'user', '${A}', 'oauth', 'Ana mail', 'active'),
        ('google', 'user', '${B}', 'oauth', 'Beto mail', 'active'),
        ('microsoft', 'organization', NULL, 'oauth', 'Company', 'active');
    `);
  });

  it("each person lists only their own; an admin the organization's and nobody's personal one", async () => {
    const labels = async (actor: "a" | "b" | "admin") =>
      ((await (await request(actor, "GET", "/connections")).json()) as { data: Array<{ label: string }> }).data.map((c) => c.label).sort();
    expect(await labels("a")).toEqual(["Ana mail"]);
    expect(await labels("b")).toEqual(["Beto mail"]);
    expect(await labels("admin")).toEqual(["Company"]);
  });

  it("someone else's connection is a 404, for reading, refreshing and revoking", async () => {
    const [beto] = await q<{ id: string }>(`SELECT id FROM conn_connections WHERE owner_id = '${B}'`);
    expect((await request("a", "GET", `/connections/${beto!.id}`)).status).toBe(404);
    expect((await request("a", "POST", `/connections/${beto!.id}/revoke`)).status).toBe(404);
    expect((await request("admin", "POST", `/connections/${beto!.id}/revoke`)).status).toBe(404);
    expect(await q(`SELECT status FROM conn_connections WHERE id = '${beto!.id}'`)).toEqual([{ status: "active" }]);
  });

  it("a person cannot write a connection for someone else or for the organization, even in SQL", async () => {
    const write = (sql: string) => sqlAsPerson({ id: A, role: "user" }, sql);
    await expect(write(`INSERT INTO conn_connections (provider, scope, owner_id, auth_type) VALUES ('google', 'user', '${B}', 'oauth')`)).rejects.toThrow(
      /row-level security/
    );
    await expect(write(`INSERT INTO conn_connections (provider, scope, owner_id, auth_type) VALUES ('google', 'organization', NULL, 'oauth')`)).rejects.toThrow(
      /row-level security/
    );
  });

  it("only an admin starts the organization's consent, and an agent starts none", async () => {
    expect((await request("a", "POST", "/oauth/start", { provider: "google", scope: "organization" })).status).toBe(403);
    expect((await request({ agent: ["connections:*"] }, "POST", "/oauth/start", { provider: "google" })).status).toBe(403);
    const ok = await request("a", "POST", "/oauth/start", { provider: "google", scopeSets: ["mail.read"], returnTo: "https://site.example/settings" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { url: string } }).data.url).toContain("accounts.google.com");
    expect((await request("a", "POST", "/oauth/start", { provider: "google", returnTo: "https://evil.example/" })).status).toBe(422);
  });

  it("the callback sends the person back to the site with the new connection", async () => {
    const started = await request("a", "POST", "/oauth/start", { provider: "google", scopeSets: ["mail.read"], returnTo: "https://site.example/settings" });
    const state = new URL(((await started.json()) as { data: { url: string } }).data.url).searchParams.get("state")!;
    const back = await request("anon", "GET", `/oauth/callback?state=${state}&code=abc`);
    expect(back.status).toBe(302);
    const to = new URL(back.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://site.example/settings");
    expect(to.searchParams.get("connection")).toMatch(/^[0-9a-f-]{36}$/);
    expect((await request("anon", "GET", `/oauth/callback?state=${state}&code=abc`)).status).toBe(400);
    expect((await request("anon", "GET", "/oauth/callback?error=access_denied")).status).toBe(400);
  });

  it("no response carries a credential", async () => {
    await connectAna();
    const body = await (await request("a", "GET", "/connections")).text();
    expect(body).not.toMatch(/access-|refresh-|valueEncrypted|credentials/);
  });
});
