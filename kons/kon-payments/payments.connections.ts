/**
 * Payment providers configured in kon-connections
 * ============================================================================
 *
 * A provider's API key can come from the environment (`STRIPE_SECRET_KEY`…), as always, or from an
 * ORGANIZATION connection an admin stored in kon-connections (`POST /api/connections/api-keys`,
 * provider `stripe`, `lemonsqueezy` or `paddle`). Then the key is sealed by the host, opened only to make
 * the request, and never reaches this kon: the provider is built with the connection's client as its
 * `http`, which adds the key itself and only to the provider's own API host.
 *
 * The environment wins when both are set. Webhook signing secrets stay in the environment: a signature
 * can only be checked with the secret in hand.
 *
 * kon-connections is optional. It is reached at runtime as a sibling, the way kon-ecommerce reaches this
 * kon; without it nothing here does anything.
 */

import type { KonContext } from "@kitsuden/shared";

export interface Http {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export const CONNECTABLE = [
  { id: "stripe", name: "Stripe", env: "STRIPE_SECRET_KEY", apiHosts: ["api.stripe.com"] },
  { id: "lemonsqueezy", name: "Lemon Squeezy", env: "LEMONSQUEEZY_API_KEY", apiHosts: ["api.lemonsqueezy.com"] },
  { id: "paddle", name: "Paddle", env: "PADDLE_API_KEY", apiHosts: ["api.paddle.com", "sandbox-api.paddle.com"] },
] as const;

const connected = new Map<string, Http>();

/** The connection's client for a provider, when one is active and the environment has no key. */
export function connectedHttp(provider: string): Http | undefined {
  return connected.get(provider);
}

interface ConnectionsKon {
  registerProvider(p: { id: string; name: string; authTypes: ["api_key"]; scopeSets: Record<string, never>; apiHosts: string[] }): void;
  connectedClient(ctx: KonContext, req: { provider: string; purpose: string }): Promise<Http>;
}

async function connectionsKon(): Promise<ConnectionsKon | null> {
  try {
    const specifier = "../kon-connections/index";
    return (await import(/* @vite-ignore */ specifier)) as ConnectionsKon;
  } catch {
    return null;
  }
}

/** Registers the providers in the catalog and opens a client for each one connected. Returns the ids found. */
export async function refreshConnectedProviders(ctx: KonContext, kon?: ConnectionsKon | null, env = process.env): Promise<string[]> {
  const connections = kon === undefined ? await connectionsKon() : kon;
  if (!connections) return [];
  const found: string[] = [];
  for (const p of CONNECTABLE) {
    connections.registerProvider({ id: p.id, name: p.name, authTypes: ["api_key"], scopeSets: {}, apiHosts: [...p.apiHosts] });
    if (env[p.env]) {
      connected.delete(p.id);
      continue;
    }
    try {
      connected.set(p.id, await connections.connectedClient(ctx, { provider: p.id, purpose: `kon-payments: ${p.name} API` }));
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
