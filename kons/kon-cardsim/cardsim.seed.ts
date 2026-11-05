/**
 * A game's secret seed (earlier audit)
 * ============================================================================
 *
 * See `Semilla` in cardsim.engine.ts. Each new game between people carries
 * a 256-bit secret (`secret_rng`) that does not leave the server while
 * it is being played; the subseed of the Nth use of randomness is HMAC-SHA256(secret, N). Old
 * games (without a secret) and solitaire with a fixed seed keep
 * the usual numeric seed: their replay does not change.
 */
import { createHmac, randomBytes } from "node:crypto";

import type { Seed } from "./cardsim.engine.js";

export function newRandomSecret(): string {
  return randomBytes(32).toString("hex");
}

export function seedOf(session: { seed: number; secretRng?: string | null }): Seed {
  const secret = session.secretRng;
  if (!secret) return session.seed;
  return (cursor: number) => createHmac("sha256", secret).update(String(cursor)).digest().readUInt32BE(0);
}

/**
 * The subseeds a FINISHED game used (`cursores` = how many). It is
 * what a client needs to reproduce it without knowing the secret.
 */
export function usedSubseeds(seed: Seed, cursors: number): number[] | null {
  if (typeof seed !== "function") return null;
  return Array.from({ length: cursors }, (_, i) => seed(i));
}
