/**
 * kon-newsletter seals consent with the IP the core resolved, never the one the client wrote
 * ============================================================================
 *
 * `cf-connecting-ip` and `x-forwarded-for` arrive as the sender typed them. The core resolves the
 * real address with `clientIp()` (TRUSTED_PROXY_HOPS) and sets it as `clientIp` on every /api
 * request; `consentIp` reads only that, and a host that does not set it gives no IP.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { consentIp } from "../../kons/kon-newsletter/newsletter.routes";

async function seen(headers: Record<string, string>, resolved?: string): Promise<string | null> {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (resolved !== undefined) c.set("clientIp" as never, resolved as never);
    await next();
  });
  app.get("/", (c) => c.json({ ip: consentIp(c) ?? null }));
  const res = await app.request("/", { headers });
  return ((await res.json()) as { ip: string | null }).ip;
}

describe("consentIp", () => {
  const spoofed = { "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "7.7.7.7, 10.0.0.1" };

  it("takes the address the core resolved, whatever the headers say", async () => {
    expect(await seen(spoofed, "203.0.113.9")).toBe("203.0.113.9");
  });

  it("without the core's value it records no IP, never a header", async () => {
    expect(await seen(spoofed)).toBeNull();
  });

  it("the core's `unknown` and an empty value are no IP", async () => {
    expect(await seen(spoofed, "unknown")).toBeNull();
    expect(await seen(spoofed, "")).toBeNull();
  });

  it("fits the 45-character column", async () => {
    expect((await seen({}, "a".repeat(80)))?.length).toBe(45);
  });
});
