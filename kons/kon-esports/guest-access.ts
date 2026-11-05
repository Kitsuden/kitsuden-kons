/**
 * Guest's personal link
 * ============================================================================
 *
 * Someone who signs up for a 1v1 without an account still needs to be able to check in,
 * report their set and withdraw. Without a session, the only way is a link only
 * that person has.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LINK IS THE CREDENTIAL. THREE CONSEQUENCES.
 *
 * 1. **The hash is stored, not the token.** In plain text, a database leak would grant the
 *    ability to report results on behalf of everyone.
 * 2. **It is shown only ONCE**, on creation. There is no way to recover it; another
 *    is generated, and the previous one stops being valid. That is correct: a link that
 *    can be sent again is a link that is still alive in the inbox
 *    of someone who no longer plays.
 * 3. **Its scope is ONE participation**, not an account. If it leaks, it exposes
 *    one tournament of one person — not their history or their other tournaments.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SHA-256 and not bcrypt on purpose: it has to be looked up on every request, so
 * it must be deterministic and indexable. The usual argument against
 * SHA-256 —that it is fast to brute-force— does not apply: here the
 * entropy comes from the generator (32 random bytes), not from a password
 * someone chooses, and against 256 bits no dictionary is of any use.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 bytes. Less starts to be guessable; more buys nothing. */
const TOKEN_BYTES = 32;

export interface IssuedToken {
  /** Shown ONCE and not stored. */
  token: string;
  /** What does go to the database. */
  hash: string;
}

export function issueAccessToken(): IssuedToken {
  // base64url: it travels in a URL and in an email without anything escaping or
  // parta en dos al copiarlo.
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, hash: hashAccessToken(token) };
}

export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compares two hashes in constant time.
 *
 * The database lookup already goes by index and not through this function, so this
 * is for when comparing in memory. It is done in constant time anyway:
 * a `===` on credentials is the habit that one day gets copied to a place where
 * it does matter.
 */
export function accessTokenMatches(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Extracts the token from a request.
 *
 * It is accepted by header AND by query. The header is the right way; the query is
 * what is needed, because the link arrives by email and is opened by clicking —
 * nobody is going to paste a header from their email client.
 *
 * What that implies and must be accepted: a token in the URL ends up in the
 * server logs and in the `Referer` if the page loads something from outside. That is why the
 * scope is ONE participation and not an account: the worst case is that someone
 * reports someone else's set, not that they get into a profile.
 */
export function readAccessToken(headers: Headers, url: string): string | null {
  const header = headers.get("x-participant-token");
  if (header?.trim()) return header.trim();

  const authorization = headers.get("authorization");
  if (authorization?.startsWith("Participant ")) {
    const value = authorization.slice("Participant ".length).trim();
    if (value) return value;
  }

  try {
    const token = new URL(url).searchParams.get("token");
    return token?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The link sent to the person.
 *
 * It is built here and not in the client so that the email, the API response
 * and the bot all say exactly the same thing.
 */
export function participantLink(baseUrl: string, tournamentId: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/t/${tournamentId}/me?token=${encodeURIComponent(token)}`;
}

/**
 * The public site the link points at: the guest page (`/t/<id>/me`) lives on the visitor-facing
 * site, not on the API. It used to be built from the request's origin, which is the API's host
 * (`api.example.com/t/...`, a 404 for the guest).
 *
 * The panel's Site URL (`ctx.site.publicUrl()`) wins; without it, `SITE_URL`; then the context's
 * `config.siteUrl`; then the development default.
 */
export async function publicSiteUrl(ctx: {
  site?: { publicUrl(): Promise<string> };
  config?: { siteUrl?: string };
}): Promise<string> {
  try {
    const url = await ctx.site?.publicUrl();
    if (url) return url;
  } catch {
    /* without a panel setting, the configured URL */
  }
  return process.env.SITE_URL || ctx.config?.siteUrl || "http://localhost:4321";
}
