/**
 * @kitsuden/kon-connections
 * ============================================================================
 *
 * Accounts at other services, connected once and used by every kon that needs them: a person's Google or
 * Microsoft mailbox and calendar for kon-inbox, the organization's account for a newsletter or payments
 * provider. Other kons never see a token: they ask for a client (connections.client.ts).
 *
 *   providers.ts   the catalog (Google, Microsoft, and what another kon registers)
 *   service.ts     connect (OAuth with PKCE, or an API key), refresh, revoke; every credential sealed
 *   client.ts      `connectedClient(ctx, …)`: a `fetch` that carries the credential to the provider only
 *   policy.ts      a person's own connections, an admin the organization's
 *
 * Events (after the commit, in this process):
 *   connections:connection.created   { connectionId, provider, scope, ownerId }
 *   connections:connection.expired   { connectionId, provider, scope, ownerId, reason }
 *   connections:connection.revoked   { connectionId, provider, scope, ownerId }
 *
 * A worker refreshes access tokens before they run out, every five minutes; a connection the provider
 * will no longer refresh becomes `expired` and is announced once, so a rule or the owner's panel can ask
 * them to connect again.
 */

import { AppError, defineKonSdk, operationsRouter, type AnyOperation, type AuthzUser } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "@kitsuden/engine/zod";

import { secretsOf } from "./connections.client";
import "./connections.policy";
import { describeProvider, providers } from "./connections.providers";
import { connConnections, publicConnection, type ConnectionRow } from "./connections.schema";
import {
  ConnectionError,
  addApiKey,
  completeOAuth,
  dueForRefresh,
  refreshConnection,
  revokeConnection,
  startOAuth,
  takeUnnotifiedExpired,
  type Fetch,
} from "./connections.service";
import manifest from "./kon.json" with { type: "json" };
import { KON_ID, ORGANIZATION, OWN, registry } from "./operations";

export * from "./connections.schema";
export { connectedClient, clientFor, allowedUrl, type ClientRequest, type ConnectedClient } from "./connections.client";
export { registerProvider, providerOf, covers, type ProviderDefinition } from "./connections.providers";

/**
 * A connection as the CALLER sees it (row security decides: their own, or the organization's for an admin),
 * without its credential; `null` when they may not see it. For another kon that lets a person pick one of
 * their connections (kon-inbox's `add-mailbox`).
 */
export async function visibleConnection(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Drizzle instance, the request's
  db: any,
  id: string
): Promise<import("./connections.schema").PublicConnection | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(connConnections).where(eq(connConnections.id, id)).limit(1);
  return row ? publicConnection(row) : null;
}
export { ConnectionError } from "./connections.service";

const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

// ── Schemas ─────────────────────────────────────────────────────────────────

const Scope = z.enum(["user", "organization"]).describe("`user`: your own account. `organization`: the installation's (admin)");
const Start = z
  .object({
    provider: z.string().min(1).max(40).describe("`google` or `microsoft` (GET /providers lists them)"),
    scope: Scope.default("user"),
    scopeSets: z.array(z.string().min(1).max(60)).max(20).default([]).describe("What to ask for: `mail.read`, `mail.send`, `calendar.read`"),
    returnTo: z.string().url().max(2000).optional().describe("Where to send the person after consenting: one of the site's origins"),
    label: z.string().max(200).optional(),
  })
  .strict();
const ApiKey = z
  .object({
    provider: z.string().min(1).max(40),
    scope: Scope.default("organization"),
    apiKey: z.string().min(8).max(4096).describe("Stored sealed; never returned"),
    label: z.string().max(200).optional(),
    accountId: z.string().max(200).optional(),
  })
  .strict();
const Callback = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(4000).optional(),
  error: z.string().max(200).optional(),
});
const ParamId = z.object({ id: z.string().uuid().describe("The connection") });
const Row = z.object({ data: z.object({}).passthrough() });
const List = z.object({ data: z.array(z.object({}).passthrough()) });

// ── Helpers ─────────────────────────────────────────────────────────────────

const who = (c: { get: (k: string) => unknown }) => (c.get("user") ?? null) as AuthzUser | null;

function toAppError(err: unknown): never {
  if (err instanceof ConnectionError) {
    if (err.status === 404) throw AppError.notFound(err.message, { code: err.code });
    if (err.status === 403) throw AppError.forbidden(err.message, { code: err.code });
    if (err.status === 409) throw AppError.conflict(err.message, { code: err.code });
    if (err.status === 422) throw AppError.validation(err.message, { code: err.code });
    if (err.status === 400) throw AppError.badRequest(err.message, { code: err.code });
    throw new AppError("INTERNAL", err.message, { status: err.status, expose: true, details: { code: err.code } });
  }
  throw err;
}

/** Origins a person may be sent back to after consenting: `CONNECTIONS_RETURN_ORIGINS`, else `ALLOWED_ORIGINS`. */
export function allowedReturn(url: string | null | undefined, env = process.env): boolean {
  if (!url) return false;
  const origins = new Set<string>();
  for (const part of [env.CONNECTIONS_RETURN_ORIGINS, env.ALLOWED_ORIGINS].filter(Boolean).join(",").split(",")) {
    try {
      const u = new URL(part.trim());
      if (u.protocol === "https:" || u.protocol === "http:") origins.add(u.origin);
    } catch {
      /* malformed: ignored */
    }
  }
  try {
    const u = new URL(url);
    return !u.username && !u.password && origins.has(u.origin);
  } catch {
    return false;
  }
}

/** Where the provider sends the person back: `CONNECTIONS_CALLBACK_URL`, else this API's own route. */
export function callbackUrl(ctx: KonContext, env = process.env): string {
  if (env.CONNECTIONS_CALLBACK_URL) return env.CONNECTIONS_CALLBACK_URL;
  const base = (env.BETTER_AUTH_URL || env.API_URL || ctx.config.siteUrl || "").replace(/\/$/, "");
  return `${base}${manifest.mount.path}/oauth/callback`;
}

function announce(ctx: KonContext, what: "created" | "expired" | "revoked", row: ConnectionRow, extra: Record<string, unknown> = {}): void {
  ctx.events?.emit?.(`connections:connection.${what}`, {
    connectionId: row.id,
    provider: row.provider,
    scope: row.scope,
    ownerId: row.ownerId ?? null,
    ...extra,
  });
}

// ── Operations ──────────────────────────────────────────────────────────────

export function connectionsOperations(ctx: KonContext, network: Fetch = (u, i) => fetch(u, i)): AnyOperation[] {
  const app = registry();
  const db = () => ctx.db.instance;
  const asSystem = <T>(fn: () => Promise<T>): Promise<T> => (ctx.db.asSystem ? ctx.db.asSystem(fn) : fn());

  /** A connection the caller may see (RLS), or 404. */
  const visible = async (id: string): Promise<ConnectionRow> => {
    const [row] = await db().select().from(connConnections).where(eq(connConnections.id, id)).limit(1);
    if (!row) throw AppError.notFound("Connection not found");
    return row as ConnectionRow;
  };

  app.get(
    "/providers",
    {
      id: "list-providers",
      summary: "The providers you can connect",
      description:
        "Each provider in the catalog: `id`, `name`, how it connects (`oauth`, `api_key`), whether this installation has it `configured`, and the scope sets you can ask for (`mail.read`…). Never a secret. Signed-in people.",
      access: "session",
      permission: OWN,
      output: { schema: List },
    },
    async (c) => c.json({ data: providers().map(describeProvider) })
  );

  app.get(
    "/connections",
    {
      id: "list-connections",
      summary: "Your connections",
      description:
        "Your own connected accounts, and the organization's if you are an admin: provider, account, granted scopes, status (`active`, `expired`, `revoked`, `error`), expiry and last use. Never a token or a key. Nobody sees another person's connections, an admin included.",
      access: "session",
      permission: OWN,
      output: { schema: List },
    },
    async (c) => {
      const rows = await db().select().from(connConnections).orderBy(desc(connConnections.createdAt)).limit(200);
      return c.json({ data: (rows as ConnectionRow[]).map(publicConnection) });
    }
  );

  app.get(
    "/connections/:id",
    {
      id: "get-connection",
      summary: "One connection and its status",
      description: "One of your connections (or an organization's, for an admin), without its credential. 404 if it is not yours.",
      access: "session",
      permission: OWN,
      input: { params: ParamId },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => c.json({ data: publicConnection(await visible(c.req.param("id"))) })
  );

  app.post(
    "/oauth/start",
    {
      id: "start-connection",
      summary: "Start connecting an account (OAuth)",
      description:
        "Returns the provider's consent `url` to send the person to; it is valid for ten minutes and works once. `scope: organization` is admin only. `returnTo` must be one of the site's origins (CONNECTIONS_RETURN_ORIGINS or ALLOWED_ORIGINS). 404 for an unknown provider, 422 for an unknown scope set, 503 when the provider is not configured here or this Kitsuden cannot seal credentials. A person only: an agent cannot consent for anyone.",
      access: "session",
      permission: ORGANIZATION,
      input: { body: Start },
      output: { schema: z.object({ data: z.object({ url: z.string(), expiresAt: z.string() }) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const user = who(c);
      if (!user?.id || user.role === "agent") throw AppError.forbidden("Connecting an account is a person's decision");
      const body = input.body as z.infer<typeof Start>;
      if (body.scope === "organization" && user.role !== "admin") throw AppError.forbidden("Only an admin connects the organization's account");
      if (body.returnTo && !allowedReturn(body.returnTo)) throw AppError.validation("returnTo is not one of the site's origins");
      try {
        const started = await startOAuth(db(), secretsOf(ctx), {
          provider: body.provider,
          scope: body.scope,
          userId: user.id,
          scopeSets: body.scopeSets,
          redirectUri: callbackUrl(ctx),
          returnTo: body.returnTo ?? null,
          label: body.label,
        });
        return c.json({ data: started });
      } catch (err) {
        toAppError(err);
      }
    }
  );

  app.get(
    "/oauth/callback",
    {
      id: "finish-connection",
      summary: "Where the provider sends the person back",
      description:
        "The provider's redirect after consent. The `state` authenticates it (one use, ten minutes); no session is needed. Exchanges the code, stores the credential sealed, and redirects to `returnTo` with `?connection=<id>` (or `?connection_error=<reason>`), or answers JSON without one. 400 for an unknown or used state.",
      access: "public",
      input: { query: Callback },
      output: { schema: z.object({}).passthrough() },
    },
    async (c, input) => {
      const q = input.query as z.infer<typeof Callback>;
      try {
        if (q.error || !q.code || !q.state) {
          throw new ConnectionError(`The provider did not connect the account (${q.error ?? "no code"})`, 400, "CONSENT_DENIED");
        }
        const done = await asSystem(() =>
          completeOAuth(db(), secretsOf(ctx), { state: q.state!, code: q.code!, redirectUri: callbackUrl(ctx), fetch: network })
        );
        if (done.created) announce(ctx, "created", done.connection);
        if (done.returnTo && allowedReturn(done.returnTo)) {
          const to = new URL(done.returnTo);
          to.searchParams.set("connection", done.connection.id);
          return c.redirect(to.toString(), 302);
        }
        return c.json({ data: publicConnection(done.connection) });
      } catch (err) {
        toAppError(err);
      }
    }
  );

  app.post(
    "/api-keys",
    {
      id: "add-api-key",
      summary: "Connect a provider with an API key",
      description:
        "Stores an API key for a provider that takes one, sealed; it is never returned. `scope: organization` (the default) is admin only; `user` is your own. 404 for an unknown provider, 422 for a provider that connects with OAuth or a key that does not look like one, 503 when this Kitsuden cannot seal credentials. A person only.",
      access: "session",
      permission: ORGANIZATION,
      input: { body: ApiKey },
      output: { schema: Row },
    },
    async (c, input) => {
      const user = who(c);
      if (!user?.id || user.role === "agent") throw AppError.forbidden("Storing a key is a person's decision");
      const body = input.body as z.infer<typeof ApiKey>;
      if (body.scope === "organization" && user.role !== "admin") throw AppError.forbidden("Only an admin connects the organization's account");
      try {
        const row = await addApiKey(db(), secretsOf(ctx), { ...body, userId: user.id });
        announce(ctx, "created", row);
        return c.json({ data: publicConnection(row) }, 201);
      } catch (err) {
        toAppError(err);
      }
    }
  );

  app.post(
    "/connections/:id/refresh",
    {
      id: "refresh-connection",
      summary: "Check a connection and refresh its token now",
      description:
        "Refreshes an OAuth connection's access token now and returns its status: `refreshed`, `expired` (connect again) or `failed` (the provider did not answer; try later). An API key answers `not-needed`. 404 if it is not yours.",
      access: "session",
      permission: OWN,
      input: { params: ParamId },
      output: { schema: z.object({ data: z.object({}).passthrough(), outcome: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const row = await visible(c.req.param("id"));
      try {
        const r = await refreshConnection(db(), secretsOf(ctx), row, { fetch: network, force: true, actorUserId: who(c)?.id ?? null });
        if (r.outcome === "expired") announce(ctx, "expired", r.connection, { reason: r.connection.lastError });
        return c.json({ data: publicConnection(r.connection), outcome: r.outcome });
      } catch (err) {
        toAppError(err);
      }
    }
  );

  app.post(
    "/connections/:id/revoke",
    {
      id: "revoke-connection",
      summary: "Disconnect an account",
      description:
        "Revokes the token at the provider when it allows it, deletes the credential, and keeps the connection as `revoked` for the record. Kons using it stop at once, and kon-inbox deletes what it synced from it. Cannot be undone: connect again instead. 404 if it is not yours.",
      access: "session",
      permission: OWN,
      input: { params: ParamId },
      output: { schema: z.object({ data: z.object({}).passthrough(), atProvider: z.boolean() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const row = await visible(c.req.param("id"));
      const r = await revokeConnection(db(), secretsOf(ctx), row, { fetch: network, actorUserId: who(c)?.id ?? null });
      if (row.status !== "revoked") announce(ctx, "revoked", r.connection);
      return c.json({ data: publicConnection(r.connection), atProvider: r.atProvider });
    }
  );

  return app.ops;
}

// ── The refresh worker ──────────────────────────────────────────────────────

/** One pass: refresh what runs out soon, announce what expired. Exported for tests and for a manual run. */
export async function refreshTick(ctx: KonContext, network: Fetch = (u, i) => fetch(u, i), now = new Date()) {
  const asSystem = <T>(fn: () => Promise<T>): Promise<T> => (ctx.db.asSystem ? ctx.db.asSystem(fn) : fn());
  const secrets = secretsOf(ctx);
  const result = { refreshed: 0, expired: 0, failed: 0 };
  if (!secrets) return result;
  const due = await asSystem(() => dueForRefresh(ctx.db.instance, now));
  for (const row of due) {
    try {
      const r = await asSystem(() => refreshConnection(ctx.db.instance, secrets, row, { fetch: network, now }));
      if (r.outcome === "refreshed") result.refreshed++;
      else if (r.outcome === "expired") result.expired++;
      else if (r.outcome === "failed") result.failed++;
    } catch (err) {
      result.failed++;
      ctx.logger.warn("[connections] refresh failed", { connectionId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const row of await asSystem(() => takeUnnotifiedExpired(ctx.db.instance, now))) {
    announce(ctx, "expired", row, { reason: row.lastError });
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

function startWorker(ctx: KonContext): void {
  if (timer) return;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await refreshTick(ctx);
    } catch (err) {
      ctx.logger.warn("[connections] refresh pass failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      busy = false;
    }
  }, 5 * 60_000);
  timer.unref?.();
}

function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function createKonConnections(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, connectionsOperations(ctx), ctx);
}

const events = {
  emits: {
    "connections:connection.created": {
      description: "An account was connected (or an API key stored).",
      payload: { connectionId: "id", provider: "google, microsoft…", scope: "user or organization", ownerId: "the person, for a user connection" },
    },
    "connections:connection.expired": {
      description: "A connection can no longer be refreshed: its owner must connect it again.",
      payload: { connectionId: "id", provider: "provider", scope: "user or organization", ownerId: "the person", reason: "what the provider said" },
    },
    "connections:connection.revoked": {
      description: "A connection was disconnected and its credential deleted.",
      payload: { connectionId: "id", provider: "provider", scope: "user or organization", ownerId: "the person" },
    },
  },
  listens: [],
};

const definition = defineKonSdk({
  id: KON_ID,
  name: "Connections",
  version: manifest.version,
  description: "Accounts at Google, Microsoft and other services, connected once and used by every kon",
  icon: "Link",
  mountPath: manifest.mount.path,
  operations: (ctx: KonContext) => connectionsOperations(ctx),
  tables: konTables,
  admin: {
    category: manifest.admin.category as "tools",
    views: manifest.admin.views.map((v) => ({ id: v.id, type: v.type as "grid", title: v.title, table: v.table })),
  },
  dependencies: { kons: [], core: ["auth"] },
  rateLimits: [{ path: "/oauth/callback", limit: 30, window: 60, message: "Too many attempts. Try again in a minute." }],
  hooks: {
    onStartup: async (ctx) => {
      for (const table of konTables) {
        if (!(await ctx.db.tableExists(table))) {
          ctx.logger.warn("[connections] tables missing: run the kon's migrations", { table });
          return;
        }
      }
      if (!secretsOf(ctx)) {
        ctx.logger.warn("[connections] this Kitsuden cannot seal credentials (ctx.secrets): new connections are refused");
      }
      startWorker(ctx);
      ctx.logger.info("[connections] ready");
    },
    onDisable: async () => stopWorker(),
  },
});

/**
 * Secrets this kon stores, so the host re-encrypts them on a key rotation (`secretColumns`), and the events
 * it emits (`events`). Set after `defineKonSdk`: a Kitsuden without these fields ignores them.
 */
const secretColumns = [
  { table: "conn_connections", column: "credentials" },
  { table: "conn_oauth_states", column: "verifier", idColumn: "state_hash" },
];

export const kon = { ...definition, ...({ events, secretColumns } as object) } as typeof definition;

export default kon;
