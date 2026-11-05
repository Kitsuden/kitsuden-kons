/**
 * PUSH ingest — the case of the user spectating on their own PC
 * ============================================================================
 *
 * The Riot adapter does *pull*: the server queries `127.0.0.1:2999`.
 * That only works if the server IS the machine that is spectating.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE BROWSER CANNOT DO IT
 *
 * The temptation is for the overlay, since it runs on the user's PC, to read the local
 * API itself. It cannot, and not for lack of trying:
 *
 *   1. The certificate of `127.0.0.1:2999` is **self-signed** by Riot. A
 *      browser rejects the request before sending it; no header can
 *      fix that.
 *   2. A page served over HTTPS cannot request an origin the browser
 *      considers insecure (**mixed content**).
 *   3. The local API sends no **CORS** headers, so even if the above
 *      were solved, the response would be unreadable from another origin.
 *
 * The way out is a tiny agent on the user's PC that reads the local API and
 * PUSHES the frame to the server. About a hundred lines, no interface, no installer:
 * `tools/agent.mjs` in this same package.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This adapter is the other end of that pipe: it queries no one, it just
 * returns the last frame pushed to it.
 */

import type { IngestAdapter, LiveFrame } from "./frame.js";

/** Last frame received per game, with when it arrived. */
const inbox = new Map<string, { frame: LiveFrame; at: number }>();

/**
 * How long a pushed frame is valid before it is considered dead.
 *
 * Without expiry, if the agent shuts down mid-game the overlay stays
 * frozen showing minute 23 forever — and on screen that looks like it is
 * working. With expiry, the state goes to "no data" and it is noticed.
 */
export const PUSH_TTL_MS = 15_000;

/** Stores a frame pushed by a user's agent. */
export function receivePushedFrame(gameId: string, frame: LiveFrame, now: number): void {
  inbox.set(gameId, { frame, at: now });
}

/** A game's current frame, or `null` if there is none or it has expired. */
export function latestPushedFrame(gameId: string, now: number): LiveFrame | null {
  const entry = inbox.get(gameId);
  if (!entry) return null;
  if (now - entry.at > PUSH_TTL_MS) return null;
  return entry.frame;
}

export function clearPushedFrames(gameId?: string): void {
  if (gameId) inbox.delete(gameId);
  else inbox.clear();
}

/**
 * Adapter that reads from the mailbox instead of querying a source.
 *
 * It declares the capabilities the AGENT can provide: the agent forwards what
 * the local API publishes, so it inherits its limits —no gold, but net worth—.
 */
export function createPushAdapter(gameId: string, clock: () => number = Date.now): IngestAdapter {
  return {
    id: "push",
    name: "Local agent (push)",
    capabilities: {
      // Same limits as the source on the other end of the pipe: the agent
      // does not invent what Riot does not publish.
      gold: false,
      netWorth: true,
      items: true,
      vision: true,
      objectives: true,
      events: true,
      spectator: true,
    },
    async poll() {
      return latestPushedFrame(gameId, clock());
    },
  };
}
