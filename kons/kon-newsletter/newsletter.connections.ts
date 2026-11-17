/**
 * Newsletter sending services configured in Kitsuden's connections
 * ============================================================================
 *
 * A provider's API key can come from the environment (`RESEND_API_KEY`…), as always, or from an
 * ORGANIZATION connection an admin stored in Kitsuden (`POST /api/connections/api-keys`,
 * provider `resend` or `mailgun`). Then the key is sealed by the host, opened only to make
 * the request, and never reaches this kon: the provider is built with the connection's client as its
 * `http`, which adds the key itself and only to the provider's own API host.
 *
 * The environment wins when both are set. Mailgun's domain and the webhook signing keys stay in the
 * environment: a signature can only be checked with the secret in hand.
 *
 * The connections battery is the host's (`ctx.connections`, docs/connections.md). On a Kitsuden without it,
 * nothing here does anything and the keys come from the environment as always.
 */

import type { KonContext } from "@kitsuden/shared";

export interface Http {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export const CONNECTABLE = [
  { id: "resend", name: "Resend", env: "RESEND_API_KEY", apiHosts: ["api.resend.com"] },
  { id: "mailgun", name: "Mailgun", env: "MAILGUN_API_KEY", apiHosts: ["api.mailgun.net", "api.eu.mailgun.net"] },
] as const;

const connected = new Map<string, Http>();

/** The connection's client for a provider, when one is active and the environment has no key. */
export function connectedHttp(provider: string): Http | undefined {
  return connected.get(provider);
}

/** Kitsuden's `ctx.connections`, structurally: the kon builds against a host without it. */
export interface ConnectionsBattery {
  registerProvider(konId: string, provider: {
    id: string;
    name: string;
    authTypes: ["api_key"];
    scopeSets: Record<string, never>;
    apiHosts: string[];
    apiKeyHeader?: { name: string; prefix?: string; encode?: (key: string) => string };
  }): void;
  client(konId: string, request: { provider: string; purpose: string }): Promise<Http>;
}

const KON = "kon-newsletter";

function batteryOf(ctx: KonContext): ConnectionsBattery | null {
  const c = (ctx as unknown as { connections?: Partial<ConnectionsBattery> }).connections;
  return c && typeof c.client === "function" && typeof c.registerProvider === "function" ? (c as ConnectionsBattery) : null;
}

/** Registers the providers in the catalog and opens a client for each one connected. Returns the ids found. */
export async function refreshConnectedProviders(ctx: KonContext, env = process.env): Promise<string[]> {
  const connections = batteryOf(ctx);
  if (!connections) return [];
  const found: string[] = [];
  for (const p of CONNECTABLE) {
    connections.registerProvider(KON, {
      id: p.id,
      name: p.name,
      authTypes: ["api_key"],
      scopeSets: {},
      apiHosts: [...p.apiHosts],
      // Mailgun authenticates with HTTP Basic, user "api" and the key as password.
      ...(p.id === "mailgun" ? { apiKeyHeader: { name: "authorization", encode: (key: string) => `Basic ${btoa(`api:${key}`)}` } } : {}),
    });
    if (env[p.env]) {
      connected.delete(p.id);
      continue;
    }
    try {
      connected.set(p.id, await connections.client(KON, { provider: p.id, purpose: `${p.name} API` }));
      found.push(p.id);
    } catch {
      connected.delete(p.id);
    }
  }
  return found;
}

const listening = new WeakSet<object>();

/** A connection stored, expired or revoked for one of these providers: look again. */
export function followConnections(ctx: KonContext): void {
  if (!ctx.events?.on || listening.has(ctx.events)) return;
  listening.add(ctx.events);
  const ids = new Set<string>(CONNECTABLE.map((p) => p.id));
  for (const what of ["created", "expired", "revoked"]) {
    ctx.events.on(`connections:connection.${what}`, (data: unknown) => {
      if (ids.has(String((data as { provider?: string } | null)?.provider))) void refreshConnectedProviders(ctx).catch(() => undefined);
    });
  }
}
