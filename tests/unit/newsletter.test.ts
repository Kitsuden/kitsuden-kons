/**
 * kon-newsletter — non-negotiable rules
 * ============================================================================
 * Tests the decisions whose failure has real consequences: writing to
 * someone who asked not to receive, suppressing someone over a full mailbox, or duplicating a
 * send on resume. The rest (CRUD) needs no tests of its own.
 *
 * These tests are deterministic and database-free: they test the pure
 * functions and the adapters, which is where the delicate logic lives.
 */

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { mailgunFeedback } from "../../kons/kon-newsletter/feedback/mailgun";
import { newsletterRateLimits } from "../../kons/kon-newsletter/newsletter.limits";
import { postmarkFeedback } from "../../kons/kon-newsletter/feedback/postmark";
import { resendFeedback } from "../../kons/kon-newsletter/feedback/resend";
import {
  clickToken,
  injectPixel,
  openToken,
  parseClickToken,
  parseOpenToken,
  rewriteLinks,
  sign,
  trackingConfigFromEnv,
  verify,
  type TrackingConfig,
} from "../../kons/kon-newsletter/newsletter.tracking";
import {
  normalizeEmail,
  syntheticId,
  timingSafeEqual,
  unsubscribeHeaders,
} from "../../kons/kon-newsletter/newsletter.types";
import { driverTransport } from "../../kons/kon-newsletter/transports/smtp";

// ── Unsubscribe headers (RFC 8058) ───────────────────────────────────────────

describe("unsubscribe headers", () => {
  it("emits List-Unsubscribe and List-Unsubscribe-Post", () => {
    // Without BOTH, Gmail and Yahoo do not recognize one-click and the email goes to
    // spam no matter how clean the list is.
    const headers = unsubscribeHeaders("https://ejemplo.com/api/newsletter/unsubscribe?token=abc");

    expect(headers["List-Unsubscribe"]).toBe(
      "<https://ejemplo.com/api/newsletter/unsubscribe?token=abc>"
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("wraps the URL in <> as RFC 2369 requires", () => {
    const headers = unsubscribeHeaders("https://x.dev/u?token=t");
    expect(headers["List-Unsubscribe"]!.startsWith("<")).toBe(true);
    expect(headers["List-Unsubscribe"]!.endsWith(">")).toBe(true);
  });
});

// ── Utilities ────────────────────────────────────────────────────────────────

describe("utilidades", () => {
  it("normalizes addresses to lowercase and without spaces", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  it("compares signatures in constant time without false positives", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("generates deterministic synthetic ids", () => {
    // Same event → same key → the unique index deduplicates it.
    const a = syntheticId("ses", "bounced", "Ada@Example.com", "2026-07-27T10:00:00Z");
    const b = syntheticId("ses", "bounced", "ada@example.com", "2026-07-27T10:00:00Z");
    expect(a).toBe(b);

    // Different instant → different key → two real events count as two.
    const c = syntheticId("ses", "bounced", "ada@example.com", "2026-07-27T10:00:01Z");
    expect(c).not.toBe(a);
  });
});

// ── Signature verification: Mailgun ──────────────────────────────────────────

describe("Mailgun feedback", () => {
  const key = "clave-de-firma";
  const adapter = mailgunFeedback({ MAILGUN_WEBHOOK_SIGNING_KEY: key } as NodeJS.ProcessEnv);

  function signedPayload(event: string, extra: Record<string, unknown> = {}) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = "token-de-prueba";
    const signature = createHmac("sha256", key)
      .update(timestamp + token)
      .digest("hex");

    return JSON.stringify({
      signature: { timestamp, token, signature },
      "event-data": {
        id: `evt-${event}`,
        event,
        timestamp: Number(timestamp),
        recipient: "Ada@Example.com",
        ...extra,
      },
    });
  }

  it("rejects an invalid signature", async () => {
    const body = JSON.stringify({
      signature: { timestamp: "1", token: "t", signature: "0".repeat(64) },
      "event-data": { event: "failed", recipient: "ada@example.com" },
    });
    // null = invalid signature. The route answers 400 and processes nothing.
    expect(await adapter.parse(body, {})).toBeNull();
  });

  it("rejects an old webhook even if the signature is correct", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 5000);
    const token = "t";
    const signature = createHmac("sha256", key)
      .update(timestamp + token)
      .digest("hex");
    const body = JSON.stringify({
      signature: { timestamp, token, signature },
      "event-data": { event: "failed", recipient: "ada@example.com" },
    });
    expect(await adapter.parse(body, {})).toBeNull();
  });

  it("marks a permanent bounce as HARD", async () => {
    const events = await adapter.parse(signedPayload("failed", { severity: "permanent" }), {});
    expect(events).toHaveLength(1);
    expect(events![0]!.type).toBe("bounced");
    expect(events![0]!.hard).toBe(true);
    expect(events![0]!.email).toBe("ada@example.com");
  });

  it("does NOT mark a temporary bounce as hard", async () => {
    // A full mailbox is temporary. Suppressing for this loses legitimate
    // subscribers and is the classic mistake of homegrown systems.
    const events = await adapter.parse(signedPayload("failed", { severity: "temporary" }), {});
    expect(events![0]!.hard).toBe(false);
  });

  it("ignores events that are not of interest", async () => {
    expect(await adapter.parse(signedPayload("accepted"), {})).toBeUndefined();
  });

  it("it is not enabled without a configured key", () => {
    expect(mailgunFeedback({} as NodeJS.ProcessEnv).isConfigured()).toBe(false);
  });
});

// ── Signature verification: Resend (Svix) ────────────────────────────────────

describe("Resend feedback", () => {
  const rawSecret = Buffer.from("secreto-de-webhook").toString("base64");
  const adapter = resendFeedback({
    RESEND_WEBHOOK_SECRET: `whsec_${rawSecret}`,
  } as NodeJS.ProcessEnv);

  function sign(body: string, id = "msg_1") {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", Buffer.from(rawSecret, "base64"))
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    return {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    };
  }

  it("validates the Svix signature and normalizes the event", async () => {
    const body = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-07-27T10:00:00Z",
      data: { email_id: "e1", to: ["Ada@Example.com"], bounce: { type: "Permanent" } },
    });

    const events = await adapter.parse(body, sign(body));
    expect(events).toHaveLength(1);
    expect(events![0]!.type).toBe("bounced");
    expect(events![0]!.hard).toBe(true);
    expect(events![0]!.email).toBe("ada@example.com");
    // The svix-id is stable across retries: it serves as an idempotency key.
    expect(events![0]!.externalId).toBe("msg_1");
  });

  it("rejects a body altered after signing", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { to: ["a@b.com"] } });
    const headers = sign(body);
    const tampered = JSON.stringify({ type: "email.bounced", data: { to: ["otro@b.com"] } });
    expect(await adapter.parse(tampered, headers)).toBeNull();
  });

  it("rejects if Svix headers are missing", async () => {
    expect(await adapter.parse("{}", {})).toBeNull();
  });

  it("treats a bounce without a permanent subtype as SOFT", async () => {
    const body = JSON.stringify({
      type: "email.bounced",
      data: { email_id: "e2", to: ["x@y.com"], bounce: { type: "Transient" } },
    });
    const events = await adapter.parse(body, sign(body, "msg_2"));
    expect(events![0]!.hard).toBe(false);
  });
});

// ── Token verification: Postmark ─────────────────────────────────────────────

describe("Postmark feedback", () => {
  const adapter = postmarkFeedback({ POSTMARK_WEBHOOK_TOKEN: "secreto" } as NodeJS.ProcessEnv);

  it("rejects without the right token", async () => {
    const body = JSON.stringify({ RecordType: "Bounce", Email: "a@b.com", Type: "HardBounce" });
    expect(await adapter.parse(body, { "x-kitsuden-token": "malo" })).toBeNull();
    expect(await adapter.parse(body, {})).toBeNull();
  });

  it("classifies HardBounce as hard", async () => {
    const body = JSON.stringify({
      RecordType: "Bounce",
      MessageID: "m1",
      Email: "a@b.com",
      Type: "HardBounce",
      BouncedAt: "2026-07-27T10:00:00Z",
    });
    const events = await adapter.parse(body, { "x-kitsuden-token": "secreto" });
    expect(events![0]!.hard).toBe(true);
  });

  it("ignores a subscription reactivation", async () => {
    // SubscriptionChange also arrives on REACTIVATE. Treating it as an unsubscribe would
    // unsubscribe someone who has just come back.
    const body = JSON.stringify({
      RecordType: "SubscriptionChange",
      Email: "a@b.com",
      SuppressSending: false,
    });
    expect(await adapter.parse(body, { "x-kitsuden-token": "secreto" })).toBeUndefined();
  });
});

// ── Generic transport ────────────────────────────────────────────────────────

describe("generic transport over a MailDriver", () => {
  function fakeDriver(behavior: (to: string) => void = () => {}) {
    const sent: string[] = [];
    return {
      sent,
      driver: {
        name: "fake",
        async send(message: { to: string[] }) {
          const to = message.to[0]!;
          behavior(to);
          sent.push(to);
          return { messageId: `id-${to}` };
        },
      },
    };
  }

  function message(to: string) {
    return {
      mailable: "test",
      to: [to],
      from: "n@x.dev",
      cc: [],
      bcc: [],
      subject: "s",
      html: "<p>h</p>",
      text: "h",
      attachments: [],
      headers: {},
      locale: "es",
      sentAt: new Date().toISOString(),
    };
  }

  it("delivers all messages and returns a result per recipient", async () => {
    const { driver, sent } = fakeDriver();
    const transport = driverTransport(driver as never);

    const results = await transport.sendBatch([message("a@x.dev"), message("b@x.dev")] as never);

    expect(sent).toEqual(["a@x.dev", "b@x.dev"]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]!.messageId).toBe("id-a@x.dev");
  });

  it("isolates one recipient's failure without bringing down the batch", async () => {
    // It is the difference between losing one email and losing the whole campaign.
    const { driver } = fakeDriver((to) => {
      if (to === "malo@x.dev") throw new Error("buzón rechazado");
    });
    const transport = driverTransport(driver as never);

    const results = await transport.sendBatch([
      message("bueno@x.dev"),
      message("malo@x.dev"),
      message("otro@x.dev"),
    ] as never);

    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]!.error).toContain("buzón rechazado");
  });

  it("keeps the input order in the results", async () => {
    // The service matches `results[i]` with `order[i]`: if the order broke,
    // the wrong rows would be marked as sent.
    const { driver } = fakeDriver();
    const transport = driverTransport(driver as never, { concurrency: 2 });

    const emails = ["1@x.dev", "2@x.dev", "3@x.dev", "4@x.dev", "5@x.dev"];
    const results = await transport.sendBatch(emails.map(message) as never);

    expect(results.map((r) => r.email)).toEqual(emails);
  });

  it("declares batchSize 1 — SMTP delivers one at a time", () => {
    const { driver } = fakeDriver();
    expect(driverTransport(driver as never).batchSize).toBe(1);
  });
});

// ── Tracking: signature and rewriting ────────────────────────────────────────

describe("seguimiento", () => {
  const SECRET = "a-secret-suficientemente-largo";

  function config(overrides: Partial<TrackingConfig> = {}): TrackingConfig {
    return {
      opens: true,
      clicks: true,
      secret: SECRET,
      appUrl: "https://ejemplo.com",
      ...overrides,
    };
  }

  it("comes DISABLED by default", () => {
    // It is a decision: the open pixel is personal data in the EU and
    // consent to receive does not cover being tracked.
    const cfg = trackingConfigFromEnv("https://ejemplo.com", {
      AUTH_SECRET: SECRET,
    } as NodeJS.ProcessEnv);
    expect(cfg.opens).toBe(false);
    expect(cfg.clicks).toBe(false);
  });

  it("it is NOT enabled without a secret, even if the variables say yes", () => {
    // Without a signature the redirector would be open: we prefer to lose the metric.
    const cfg = trackingConfigFromEnv("https://ejemplo.com", {
      NEWSLETTER_TRACK_OPENS: "true",
      NEWSLETTER_TRACK_CLICKS: "true",
      AUTH_SECRET: "corto",
    } as NodeJS.ProcessEnv);
    expect(cfg.opens).toBe(false);
    expect(cfg.clicks).toBe(false);
  });

  it("signs and verifies round trip", () => {
    const token = sign("hola|mundo", SECRET);
    expect(verify(token, SECRET)).toBe("hola|mundo");
  });

  it("rejects a signature made with another secret", () => {
    expect(verify(sign("dato", SECRET), "otro-secreto-distinto")).toBeNull();
  });

  it("rejects a tampered token", () => {
    const token = sign("o|entrega-1", SECRET);
    const [data, mac] = token.split(".");
    // Changing the data while keeping the signature must not get through.
    const forged = `${Buffer.from("o|entrega-999").toString("base64url")}.${mac}`;
    expect(verify(forged, SECRET)).toBeNull();
    expect(data).toBeTruthy();
  });

  it("recovers the delivery id from an open token", () => {
    const parsed = parseOpenToken(openToken("entrega-42", SECRET), SECRET);
    expect(parsed?.deliveryId).toBe("entrega-42");
  });

  it("does not confuse a click token with an open one", () => {
    // The o|/c| prefixes prevent reusing a token on the other endpoint.
    const asClick = clickToken("e1", "https://destino.com", SECRET);
    expect(parseOpenToken(asClick, SECRET)).toBeNull();
    expect(parseClickToken(openToken("e1", SECRET), SECRET)).toBeNull();
  });

  it("carries the destination INSIDE the signature", () => {
    const parsed = parseClickToken(clickToken("e1", "https://destino.com/x", SECRET), SECRET);
    expect(parsed?.url).toBe("https://destino.com/x");
    expect(parsed?.deliveryId).toBe("e1");
  });

  it("never redirects to a scheme that is not http(s)", () => {
    // Even if the token is properly signed — if the secret leaked, this
    // still prevents turning the domain into a phishing redirector.
    const malicious = sign("c|e1|javascript:alert(1)", SECRET);
    expect(parseClickToken(malicious, SECRET)).toBeNull();
    expect(parseClickToken(sign("c|e1|data:text/html,x", SECRET), SECRET)).toBeNull();
  });

  it("rewrites the links except the unsubscribe one", () => {
    const unsub = "https://ejemplo.com/api/newsletter/unsubscribe?token=abc";
    const html =
      `<a href="https://destino.com/post">Leer</a>` +
      `<a href="${unsub}">Baja</a>` +
      `<a href="mailto:hola@ejemplo.com">Escribir</a>`;

    const out = rewriteLinks(html, "e1", config(), unsub);

    expect(out).toContain("https://ejemplo.com/api/newsletter/t/c/");
    // Breaking unsubscribe because of a tracking failure would be the worst possible bug.
    expect(out).toContain(`href="${unsub}"`);
    expect(out).toContain(`href="mailto:hola@ejemplo.com"`);
  });

  it("touches nothing if click tracking is off", () => {
    const html = `<a href="https://destino.com">x</a>`;
    expect(rewriteLinks(html, "e1", config({ clicks: false }), "")).toBe(html);
  });

  it("injects the pixel before </body> and only if it is active", () => {
    const html = "<html><body><p>hola</p></body></html>";
    const withPixel = injectPixel(html, "e1", config());
    expect(withPixel).toContain("/api/newsletter/t/o/");
    expect(withPixel.indexOf("<img")).toBeLessThan(withPixel.indexOf("</body>"));

    expect(injectPixel(html, "e1", config({ opens: false }))).toBe(html);
  });

  it("the rewritten destination survives the complete round trip", () => {
    const target = "https://destino.com/articulo?utm=news&x=1";
    const out = rewriteLinks(`<a href="${target}">x</a>`, "e7", config(), "");
    const token = out.match(/t\/c\/([^"]+)"/)?.[1];
    expect(token).toBeTruthy();

    const parsed = parseClickToken(token!, SECRET);
    expect(parsed?.url).toBe(target);
    expect(parsed?.deliveryId).toBe("e7");
  });
});

// ── Request limits declared by the kon ─────────────────────────────────────

describe("kon rate limits", () => {
  it("declares a strict, fail-closed limit on /subscribe", async () => {
    // The host's global one is 300/min, calibrated for reading. On an
    // endpoint that sends an email per request that is 18,000 emails/hour
    // from your domain: textbook subscription bombing.
    const subscribe = newsletterRateLimits.find((r) => r.path === "/subscribe");

    expect(subscribe).toBeDefined();
    expect(subscribe!.limit).toBeLessThanOrEqual(10);
    // With Valkey down, sign-up is rejected rather than being left without a brake.
    expect(subscribe!.failClosed).toBe(true);
  });

  it("does NOT throttle unsubscribe as hard as sign-up", async () => {
    // An unsubscribe link that returns 429 is a spam complaint.
    const unsub = newsletterRateLimits.find((r) => r.path === "/unsubscribe")!;
    const subscribe = newsletterRateLimits.find((r) => r.path === "/subscribe")!;

    const unsubPerSecond = unsub.limit / unsub.window;
    const subPerSecond = subscribe.limit / subscribe.window;
    expect(unsubPerSecond).toBeGreaterThan(subPerSecond);
    expect(unsub.failClosed).toBeFalsy();
  });

  it("all declared routes are relative to the mountPath", () => {
    // A kon must not know where it ends up mounted: if it declared
    // absolute routes, remounting it under another prefix would leave the limits dangling.
    for (const rule of newsletterRateLimits) {
      expect(rule.path.startsWith("/")).toBe(true);
      expect(rule.path).not.toContain("/api/");
    }
  });
});
