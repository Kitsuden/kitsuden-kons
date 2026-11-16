import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Connections to third-party accounts
 * ============================================================================
 *
 * `conn_connections`: one connected account (a Google mailbox, a Microsoft 365 tenant, an API key). The
 * credential is a `SealedSecret` in `credentials`, sealed by the host for this kon (`ctx.secrets`); nothing
 * here, and no route, holds or returns it readable. Row security: a person sees their own `user`
 * connections, an admin the `organization` ones, and the system all (migrations/0001_connections.sql).
 *
 * `conn_oauth_states`: one OAuth round trip in flight, ten minutes at most. The `state` is stored hashed,
 * the PKCE verifier sealed.
 */

/** What `ctx.secrets.seal` returns (Kitsuden's `SealedSecret`). */
export interface SealedValue {
  v: 1;
  kon: string;
  valueEncrypted: string;
  iv: string;
  authTag: string;
}

export const connConnections = pgTable(
  "conn_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    scope: text("scope").$type<"user" | "organization">().notNull(),
    ownerId: text("owner_id"),
    authType: text("auth_type").$type<"oauth" | "api_key">().notNull(),
    label: text("label").notNull().default(""),
    accountId: text("account_id"),
    accountEmail: text("account_email"),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default([]),
    status: text("status").$type<"active" | "expired" | "revoked" | "error">().notNull().default("active"),
    credentials: jsonb("credentials").$type<SealedValue | null>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastError: text("last_error"),
    expiryNotifiedAt: timestamp("expiry_notified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("conn_connections_owner_idx").on(t.ownerId, t.provider)]
);

export const connOauthStates = pgTable("conn_oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  provider: text("provider").notNull(),
  scope: text("scope").$type<"user" | "organization">().notNull(),
  ownerId: text("owner_id"),
  userId: text("user_id").notNull(),
  requestedScopes: jsonb("requested_scopes").$type<string[]>().notNull().default([]),
  verifier: jsonb("verifier").$type<SealedValue>().notNull(),
  returnTo: text("return_to"),
  label: text("label").notNull().default(""),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ConnectionRow = typeof connConnections.$inferSelect;

/** A connection as every route and every other kon sees it: no credential, ever. */
export interface PublicConnection {
  id: string;
  provider: string;
  scope: "user" | "organization";
  ownerId: string | null;
  authType: "oauth" | "api_key";
  label: string;
  accountId: string | null;
  accountEmail: string | null;
  grantedScopes: string[];
  status: "active" | "expired" | "revoked" | "error";
  expiresAt: string | null;
  lastRefreshedAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export function publicConnection(row: ConnectionRow): PublicConnection {
  return {
    id: row.id,
    provider: row.provider,
    scope: row.scope,
    ownerId: row.ownerId ?? null,
    authType: row.authType,
    label: row.label,
    accountId: row.accountId ?? null,
    accountEmail: row.accountEmail ?? null,
    grantedScopes: row.grantedScopes ?? [],
    status: row.status,
    expiresAt: iso(row.expiresAt),
    lastRefreshedAt: iso(row.lastRefreshedAt),
    lastUsedAt: iso(row.lastUsedAt),
    lastError: row.lastError ?? null,
    createdAt: iso(row.createdAt)!,
  };
}
