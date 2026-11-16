/**
 * kon-payments and kon-newsletter take their providers' keys from kon-connections
 * ============================================================================
 *
 * kon-connections is a double with its contract (`registerProvider`, `connectedClient`); its own suite
 * checks the real one. What these tests hold:
 *   - an organization's connection makes Stripe (or Resend) available without a key in the environment,
 *     and the provider's requests go through the connection's client, never carrying a key of their own;
 *   - a key in the environment wins over a connection;
 *   - Mailgun's key travels as HTTP Basic (`api:<key>`), the way Mailgun asks for it;
 *   - without kon-connections, nothing changes.
 */

import { afterEach, describe, expect, it } from "vitest";

import { buildTransport } from "../../kons/kon-newsletter/index";
import { refreshConnectedProviders as newsletterRefresh } from "../../kons/kon-newsletter/newsletter.connections";
import { buildProviders } from "../../kons/kon-payments/index";
import { refreshConnectedProviders as paymentsRefresh } from "../../kons/kon-payments/payments.connections";

type Registered = { id: string; apiHosts: string[]; apiKeyHeader?: { encode?: (k: string) => string } };

function fakeConnections(connected: string[]) {
  const registered: Registered[] = [];
  const calls: Array<{ provider: string; url: string; init?: RequestInit }> = [];
  return {
    registered,
    calls,
    kon: {
      registerProvider: (p: Registered) => registered.push(p),
      connectedClient: async (_ctx: unknown, req: { provider: string }) => {
        if (!connected.includes(req.provider)) throw new Error("NO_CONNECTION");
        return {
          fetch: async (url: string, init?: RequestInit) => {
            calls.push({ provider: req.provider, url, init });
            return new Response(JSON.stringify({ id: "cs_test", url: "https://checkout.stripe.com/c/1", data: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        };
      },
    },
  };
}

const ctx = {} as never;
const env = (over: Record<string, string>) => ({ ...over }) as NodeJS.ProcessEnv;

afterEach(async () => {
  // Leave both kons as if kon-connections were not installed.
  await paymentsRefresh(ctx, null);
  await newsletterRefresh(ctx, null);
});

describe("kon-payments", () => {
  it("an organization's Stripe connection makes Stripe available, and requests go through it", async () => {
    const f = fakeConnections(["stripe"]);
    expect(await paymentsRefresh(ctx, f.kon as never, env({}))).toEqual(["stripe"]);
    expect(f.registered.map((p) => p.id)).toEqual(["stripe", "lemonsqueezy", "paddle"]);
    expect(f.registered[0]!.apiHosts).toEqual(["api.stripe.com"]);

    const providers = buildProviders(env({}));
    expect([...providers.keys()]).toEqual(["stripe"]);
    await providers
      .get("stripe")!
      .createCheckout({ planId: "price_1", successUrl: "https://site.example/ok", metadata: {} } as never)
      .catch(() => undefined);
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls[0]!.url.startsWith("https://api.stripe.com/")).toBe(true);
    // The provider puts an empty key; the connection's client is what fills it.
    expect(new Headers(f.calls[0]!.init!.headers).get("authorization")).toMatch(/^Bearers*$/);
  });

  it("a key in the environment wins over the connection", async () => {
    const f = fakeConnections(["stripe"]);
    expect(await paymentsRefresh(ctx, f.kon as never, env({ STRIPE_SECRET_KEY: "sk_env" }))).toEqual([]);
  });

  it("without kon-connections nothing changes", async () => {
    expect(await paymentsRefresh(ctx, null)).toEqual([]);
    expect([...buildProviders(env({})).keys()]).toEqual([]);
  });
});

describe("kon-newsletter", () => {
  it("a Resend connection becomes the sending service, and sends through the connection", async () => {
    const f = fakeConnections(["resend"]);
    expect(await newsletterRefresh(ctx, f.kon as never, env({}))).toEqual(["resend"]);
    const transport = buildTransport(env({}), { send: async () => undefined } as never);
    expect(transport.name).toBe("resend");
    await transport.sendBatch([{ to: "a@b.example", from: "news@site.example", subject: "s", html: "<p>h</p>", text: "h" } as never]).catch(() => undefined);
    expect(f.calls[0]!.url).toBe("https://api.resend.com/emails/batch");
  });

  it("Mailgun's key is sent as HTTP Basic api:<key>", async () => {
    const f = fakeConnections([]);
    await newsletterRefresh(ctx, f.kon as never, env({}));
    const mailgun = f.registered.find((p) => p.id === "mailgun")!;
    expect(mailgun.apiHosts).toEqual(["api.mailgun.net", "api.eu.mailgun.net"]);
    expect(mailgun.apiKeyHeader!.encode!("key-123")).toBe(`Basic ${btoa("api:key-123")}`);
  });
});
