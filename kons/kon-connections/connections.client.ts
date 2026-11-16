/**
 * What another kon gets: a client, never a token
 * ============================================================================
 *
 *   import { connectedClient } from "@kitsuden/kon-connections";
 *
 *   const gmail = await connectedClient(ctx, {
 *     provider: "google",
 *     ownerId: userId,                 // that person's own connection; omit for the organization's
 *     scopeSets: ["mail.read"],
 *     purpose: "kon-inbox: sync mail", // recorded by the host every time the credential is opened
 *   });
 *   const res = await gmail.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages");
 *
 * `fetch` adds the credential itself, refreshes it first when it is about to run out, and refuses any URL
 * whose host is not on the provider's list (connections.providers.ts): a URL built from data cannot carry
 * the token elsewhere. The token is a local of `fetch`; it is not on the client object, not in an error, not
 * in a log.
 *
 * The connection is looked up as the system (another kon calls this from a worker, without a request), so
 * the caller is responsible for asking for the right `ownerId`: kon-inbox asks for the mailbox owner's own.
 *
 * A 401 from the provider is answered once with a forced refresh and a retry; a second 401 marks the
 * connection `error` and is returned to the caller as is.
 */

import type { KonContext } from "@kitsuden/shared";
import { eq } from "drizzle-orm";

import { providerOf } from "./connections.providers";
import { connConnections, publicConnection, type ConnectionRow, type PublicConnection } from "./connections.schema";
import {
  ConnectionError,
  findConnection,
  openCredential,
  refreshConnection,
  type Credential,
  type Fetch,
  type Secrets,
  type Wanted,
} from "./connections.service";

export interface ClientRequest extends Wanted {
  /** Why the credential is opened, as the host's access log will show it. */
  purpose: string;
  /** The person the work is done for, if any (the log's actor). */
  actorUserId?: string | null;
}

export interface ConnectedClient {
  connection: PublicConnection;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export function secretsOf(ctx: KonContext): Secrets | null {
  return ((ctx as unknown as { secrets?: Secrets }).secrets ?? null) || null;
}

function authorize(row: ConnectionRow, credential: Credential, headers: Headers): void {
  if (row.authType === "api_key") {
    const provider = providerOf(row.provider);
    const header = provider?.apiKeyHeader ?? { name: "authorization", prefix: "Bearer " };
    headers.set(header.name, `${header.prefix ?? ""}${credential.apiKey ?? ""}`);
    return;
  }
  headers.set("authorization", `Bearer ${credential.accessToken ?? ""}`);
}

/** Whether the token may be sent to this URL: https, on one of the provider's hosts. */
export function allowedUrl(providerId: string, url: string): boolean {
  const provider = providerOf(providerId);
  if (!provider) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && !parsed.username && !parsed.password && provider.apiHosts.includes(parsed.hostname);
}

/**
 * The same, with the pieces given: tests and the host's worker pass their own `db`, `secrets` and `fetch`.
 */
export async function clientFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Drizzle instance
  db: any,
  secrets: Secrets | null,
  request: ClientRequest,
  network: Fetch = (url, init) => fetch(url, init)
): Promise<ConnectedClient> {
  if (!secrets) throw new ConnectionError("This Kitsuden cannot open credentials (no secrets key)", 503, "SECRETS_UNAVAILABLE");
  let row = await findConnection(db, request);
  if (!row) {
    throw new ConnectionError(
      `No ${request.provider} connection${request.ownerId ? " of that person" : " of the organization"} covers ${(request.scopeSets ?? []).join(", ") || "this"}`,
      404,
      "NO_CONNECTION"
    );
  }
  if (row.status !== "active") {
    throw new ConnectionError(`The ${row.provider} connection is ${row.status}: it must be connected again`, 409, "CONNECTION_" + row.status.toUpperCase());
  }

  const send = async (url: string, init: RequestInit | undefined, force: boolean): Promise<Response> => {
    if (row!.authType === "oauth") {
      const r = await refreshConnection(db, secrets, row!, { fetch: network, force, actorUserId: request.actorUserId ?? null });
      row = r.connection;
      if (row.status !== "active") {
        throw new ConnectionError(`The ${row.provider} connection expired: it must be connected again`, 409, "CONNECTION_EXPIRED");
      }
    }
    const credential = await openCredential(secrets, row!, request.purpose, request.actorUserId ?? null);
    const headers = new Headers(init?.headers);
    authorize(row!, credential, headers);
    return network(url, { ...init, headers, redirect: "manual" });
  };

  return {
    connection: publicConnection(row),
    async fetch(url, init) {
      if (!allowedUrl(row!.provider, url)) {
        throw new ConnectionError(`The ${row!.provider} connection is not sent to ${safeHost(url)}`, 403, "HOST_NOT_ALLOWED");
      }
      let res = await send(url, init, false);
      if (res.status === 401 && row!.authType === "oauth") res = await send(url, init, true);
      const now = new Date();
      await db
        .update(connConnections)
        .set(res.status === 401 ? { status: "error", lastError: "The provider refused the credential (401)", updatedAt: now } : { lastUsedAt: now })
        .where(eq(connConnections.id, row!.id));
      return res;
    },
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname || "that address";
  } catch {
    return "that address";
  }
}

/** For another kon, from its `ctx`: looked up and opened as the system. */
export async function connectedClient(ctx: KonContext, request: ClientRequest): Promise<ConnectedClient> {
  const asSystem = ctx.db.asSystem ?? (<T>(f: () => Promise<T>) => f());
  const client = await asSystem(() => clientFor(ctx.db.instance, secretsOf(ctx), request));
  return {
    connection: client.connection,
    // Each request also as the system: it reads and updates the connection row.
    fetch: (url, init) => asSystem(() => client.fetch(url, init)),
  };
}
