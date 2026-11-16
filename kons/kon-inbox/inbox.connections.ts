/**
 * The mailbox's account, through Kitsuden's connections (`ctx.connections`, docs/connections.md)
 * ============================================================================
 *
 * The core keeps the person's Google or Microsoft account: the credential is sealed there and this kon
 * never sees it. It asks for a client whose `fetch` adds the credential and only reaches the provider's
 * hosts. The types are written here, structurally, so the kon builds against a Kitsuden that does not
 * have the battery yet; on such a host `connectionsOf` is `null` and nothing can be synced.
 */

import type { KonContext } from "@kitsuden/shared";

export interface PublicConnection {
  id: string;
  provider: string;
  scope: "user" | "organization";
  ownerId: string | null;
  accountEmail: string | null;
  grantedScopes: string[];
  status: "active" | "expired" | "revoked" | "error";
}

export interface ConnectionRequest {
  provider: string;
  ownerId?: string | null;
  connectionId?: string;
  scopeSets?: string[];
  purpose: string;
  actorUserId?: string | null;
}

export interface ConnectedClient {
  connection: PublicConnection;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface Connections {
  client(konId: string, request: ConnectionRequest): Promise<ConnectedClient>;
  visible(konId: string, connectionId: string): Promise<PublicConnection | null>;
  covers(provider: string, grantedScopes: string[], scopeSets: string[]): boolean;
}

export const KON = "kon-inbox";

export function connectionsOf(ctx: KonContext): Connections | null {
  const c = (ctx as unknown as { connections?: Partial<Connections> }).connections;
  return c && typeof c.client === "function" && typeof c.visible === "function" ? (c as Connections) : null;
}

/** The core's `ConnectionError` (and anything shaped like it): a status and a code. */
export function connectionErrorOf(err: unknown): { status: number; code: string; message: string } | null {
  const e = err as { status?: unknown; code?: unknown; message?: unknown; name?: unknown } | null;
  if (!e || e.name !== "ConnectionError" || typeof e.status !== "number") return null;
  return { status: e.status, code: String(e.code ?? ""), message: String(e.message ?? "") };
}
