/**
 * Kitsuden Newsletter — Request limits
 * ============================================================================
 *
 * The host applies a generous global limit (300 req/min) calibrated for
 * READING. Here it would be a gift: `/subscribe` is public and sends one email per
 * request, so 300/min is 18,000 emails an hour leaving your domain
 * toward unverified addresses. That is "subscription bombing", and it burns the
 * domain's reputation even if your list is impeccable.
 *
 * TWO DIFFERENT LIDS, BECAUSE THEY ARE TWO DIFFERENT ATTACKS
 *
 * · These limits are PER IP: they stop whoever hammers the endpoint.
 * · The 5-minute wait per address (in the service) stops whoever rotates
 *   IPs to bombard one victim.
 *
 * Neither works alone.
 *
 * It lives in its own module, with no imports, on purpose: it is a declaration
 * of data, not behavior, and so it can be read and tested without dragging in the
 * mail engine or the host runtime.
 */

import type { KonRateLimit } from "@kitsuden/shared";

export const newsletterRateLimits: KonRateLimit[] = [
  {
    // 5 every 5 minutes: an office behind a shared NAT may register
    // several people, and the attack stops making sense.
    path: "/subscribe",
    limit: 5,
    window: 300,
    message: "Too many sign-ups from this connection. Try again in a few minutes.",
    // With Valkey down I prefer rejecting sign-ups to being left with no brake at all
    // while sending email.
    failClosed: true,
  },
  {
    // Confirming triggers the welcome email: cheaper than sign-up, but
    // not free either.
    path: "/confirm",
    limit: 20,
    window: 300,
    failClosed: true,
  },
  {
    // Unsubscribing is NOT throttled the same way. An unsubscribe link that returns 429 is
    // a spam report, which is exactly what we are trying to avoid. The
    // limit exists only against brute abuse, and never fails closed.
    path: "/unsubscribe",
    limit: 60,
    window: 60,
  },
];
