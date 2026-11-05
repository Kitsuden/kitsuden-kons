/**
 * Kitsuden Newsletter — Opens and clicks
 * ============================================================================
 *
 * DISABLED BY DEFAULT, and that is a decision, not an oversight.
 *
 * The open pixel records that a specific person opened an email, with
 * their IP and time. In the EU that is personal data and needs its own legal basis:
 * consent to *receive* the newsletter does not cover *monitoring* whether you
 * read it. Ghost ships it on; here it is turned on by hand and knowingly:
 *
 *   NEWSLETTER_TRACK_OPENS=true
 *   NEWSLETTER_TRACK_CLICKS=true
 *
 * It is the same stance as the rest of the project: deny by default.
 *
 * SIGNATURE
 *
 * Tracking links are SIGNED with HMAC. Without a signature, `/t/o/<uuid>`
 * would be an endpoint where anyone marks other people's opens —skewing
 * the metrics— and worse: the click one would be an open redirector, which is a gift
 * for phishing (`yourdomain.com/...` redirecting to a malicious site, with
 * your domain reputation behind it).
 *
 * The secret comes from NEWSLETTER_TRACKING_SECRET, or from AUTH_SECRET as
 * a fallback. With neither, tracking is NOT enabled even if the
 * variables say so.
 */

import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

// ── Configuration ────────────────────────────────────────────────────────────

export interface TrackingConfig {
  opens: boolean;
  clicks: boolean;
  secret: string;
  /** Absolute base for building the tracking URLs. */
  appUrl: string;
}

export function trackingConfigFromEnv(appUrl: string, env = process.env): TrackingConfig {
  const secret = env.NEWSLETTER_TRACKING_SECRET ?? env.AUTH_SECRET ?? "";

  // Without a secret there is no signing, and without signing there is no tracking. We prefer losing the
  // metric to exposing an open redirector.
  const usable = secret.length >= 16;

  return {
    opens: usable && env.NEWSLETTER_TRACK_OPENS === "true",
    clicks: usable && env.NEWSLETTER_TRACK_CLICKS === "true",
    secret,
    appUrl: appUrl.replace(/\/$/, ""),
  };
}

// ── Signature ────────────────────────────────────────────────────────────────

/**
 * Signs a payload and packs it as `<data>.<signature>` in base64url.
 *
 * The signature is truncated to 16 bytes: enough against forgery (2^128) and
 * keeps the URL short, which matters because some mail clients split
 * long lines and break the link.
 */
export function sign(payload: string, secret: string): string {
  const data = Buffer.from(payload, "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(data).digest("base64url").slice(0, 22);
  return `${data}.${mac}`;
}

/** Verifies and returns the payload, or `null` if the signature does not validate. */
export function verify(token: string, secret: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const data = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(data).digest("base64url").slice(0, 22);

  if (mac.length !== expected.length) return null;
  try {
    if (!nodeTimingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

// ── Tracking tokens ──────────────────────────────────────────────────────────

export interface OpenToken {
  deliveryId: string;
}

export interface ClickToken {
  deliveryId: string;
  /** Real destination. It goes INSIDE the signature: so it cannot be changed. */
  url: string;
}

export function openToken(deliveryId: string, secret: string): string {
  return sign(`o|${deliveryId}`, secret);
}

export function parseOpenToken(token: string, secret: string): OpenToken | null {
  const payload = verify(token, secret);
  if (!payload?.startsWith("o|")) return null;
  return { deliveryId: payload.slice(2) };
}

export function clickToken(deliveryId: string, url: string, secret: string): string {
  return sign(`c|${deliveryId}|${url}`, secret);
}

export function parseClickToken(token: string, secret: string): ClickToken | null {
  const payload = verify(token, secret);
  if (!payload?.startsWith("c|")) return null;

  const rest = payload.slice(2);
  const sep = rest.indexOf("|");
  if (sep < 0) return null;

  const url = rest.slice(sep + 1);
  // Belt and braces: even though the URL is signed, it only redirects to
  // http(s). If the secret leaked, this still prevents `javascript:`
  // y `data:`.
  if (!/^https?:\/\//i.test(url)) return null;

  return { deliveryId: rest.slice(0, sep), url };
}

// ── HTML rewriting ───────────────────────────────────────────────────────────

/** Transparent 1×1 GIF, the smallest possible (43 bytes). */
export const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

/**
 * Rewrites the `href`s so they go through the signed redirector.
 *
 * NOT touched:
 * · the unsubscribe link — breaking it because of a tracking failure would be
 *   exactly the worst possible bug in a newsletter;
 * · `mailto:`, `tel:` and internal anchors;
 * · those that already point to the tracking domain itself.
 */
export function rewriteLinks(
  html: string,
  deliveryId: string,
  config: TrackingConfig,
  unsubscribeUrl: string
): string {
  if (!config.clicks) return html;

  return html.replace(/href\s*=\s*"([^"]*)"/gi, (match, url: string) => {
    if (!/^https?:\/\//i.test(url)) return match;
    if (url === unsubscribeUrl) return match;
    if (url.startsWith(`${config.appUrl}/api/newsletter/t/`)) return match;

    const token = clickToken(deliveryId, url, config.secret);
    return `href="${config.appUrl}/api/newsletter/t/c/${token}"`;
  });
}

/**
 * Adds the open pixel at the end of the body.
 *
 * It goes at the END on purpose: if the client clips the email (Gmail does it
 * at 102 KB), the pixel is the first thing lost, and losing a metric is
 * better than losing content.
 */
export function injectPixel(html: string, deliveryId: string, config: TrackingConfig): string {
  if (!config.opens) return html;

  const token = openToken(deliveryId, config.secret);
  const pixel =
    `<img src="${config.appUrl}/api/newsletter/t/o/${token}.gif" ` +
    `width="1" height="1" alt="" style="display:none;width:1px;height:1px" />`;

  return html.includes("</body>") ? html.replace("</body>", `${pixel}</body>`) : html + pixel;
}
