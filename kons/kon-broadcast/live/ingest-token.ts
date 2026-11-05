/**
 * Ingest token of the local agent
 * ============================================================================
 *
 * ── WHAT USED TO HAPPEN ────────────────────────────────────────────────────
 *
 *   1. It was stored IN PLAINTEXT in `broadcast_games.ingest_token`.
 *   2. It was compared with `!==`, which stops at the first differing character: the
 *      response time tells you how many characters you have right.
 *   3. And it came out in the game row: `GET /games/:id` and
 *      `GET /matches/:id/games` returned it whole, and the policy lets any session
 *      VIEW a live set —sign-up is public—. By reading the
 *      game you could push fake frames to the overlay that is on air.
 *
 * ── NOW ────────────────────────────────────────────────────────────────────
 *
 * The SHA-256 is stored (like the esports guest link), it is compared in
 * constant time over two hashes of the same length, and `publicGame()` strips it
 * from every response.
 *
 * Old tokens (plaintext, 32 hex) remain valid: what is stored is hashed
 * before comparing. A hash is 64 hex, so there is no ambiguity.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashIngestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** New token (shown ONCE) and what goes to the database. */
export function issueIngestToken(): { token: string; stored: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, stored: hashIngestToken(token) };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Is the presented token the one for this game?
 *
 * Constant time: both sides are reduced to 32 bytes of SHA-256 before
 * `timingSafeEqual`, so neither the token's length nor where it differs
 * shows in the response time.
 */
export function ingestTokenMatches(
  presented: string | null | undefined,
  stored: string | null | undefined
): boolean {
  if (!presented || !stored) return false;
  const expected = Buffer.from(SHA256_HEX.test(stored) ? stored : hashIngestToken(stored), "hex");
  const candidate = Buffer.from(hashIngestToken(presented), "hex");
  return expected.length === candidate.length && timingSafeEqual(candidate, expected);
}

/** A game's row without what cannot leave the API. */
export function publicGame<T extends { ingestToken?: unknown }>(game: T): Omit<T, "ingestToken"> {
  if (!game) return game;
  const { ingestToken: _token, ...rest } = game;
  return rest;
}
