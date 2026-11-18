/**
 * kon-dc — calling other kons
 * ============================================================================
 *
 * A blueprint reaches other kons through their REST operations, with the BOT's own agent key
 * (DISCORD_KITSUDEN_API_TOKEN), never with a member's identity and never by reading their tables:
 *
 *   · the key's scopes are the ceiling. A server can only do in kon-broadcast what that key may do
 *     (`kon:broadcast:scoreboard`, `kon:broadcast:screens`…), whatever a blueprint says;
 *   · every call goes through the other kon's own validation, policy, row security and audit;
 *   · an operation that needs a human's approval answers `202 KITSUDEN_E_APPROVAL_REQUIRED`; the
 *     member is told so, and nothing is retried.
 *
 * Who in the Discord server may trigger such a call is the blueprint's job: an `access.roles` gate on
 * the command, button or modal (Viggo's "operator role").
 */

import type { DiscordSettings } from "./dc.rest";

export class KonCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message);
  }
}

export interface KonCallResult {
  status: number;
  data: unknown;
}

export interface KitsudenClient {
  call(method: string, path: string, body?: unknown): Promise<KonCallResult>;
}

const TIMEOUT_MS = 8000;
const MAX_ANSWER_BYTES = 512_000;

export function createKitsudenClient(settings: DiscordSettings, fetchImpl: typeof fetch = fetch): KitsudenClient {
  return {
    async call(method, path, body) {
      if (!settings.kitsudenApiUrl || !settings.kitsudenApiToken) {
        throw new KonCallError("This bot cannot reach other kons: DISCORD_KITSUDEN_API_URL and DISCORD_KITSUDEN_API_TOKEN are not set", 503, null);
      }
      // The path was validated by `KonPath`; templates may have filled parts of it, so check again.
      if (!/^\/[a-z0-9][a-z0-9-]*(\/|$|\?)/.test(path) || path.includes("..") || path.includes("//")) {
        throw new KonCallError("Invalid path", 400, null);
      }
      const res = await fetchImpl(`${settings.kitsudenApiUrl}/api${path}`, {
        method,
        headers: {
          authorization: `Bearer ${settings.kitsudenApiToken}`,
          "user-agent": "kitsuden-kon-dc/0.2",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
      const text = (await res.text()).slice(0, MAX_ANSWER_BYTES);
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      const err = (data && typeof data === "object" ? (data as { error?: unknown; code?: unknown; message?: unknown }) : {}) as {
        error?: unknown;
        code?: unknown;
        message?: unknown;
      };
      const errObj = err.error && typeof err.error === "object" ? (err.error as { code?: unknown; message?: unknown }) : null;
      const code = typeof errObj?.code === "string" ? errObj.code : typeof err.code === "string" ? err.code : null;
      if (res.status === 202 && code === "KITSUDEN_E_APPROVAL_REQUIRED") {
        throw new KonCallError("Waiting for a person to approve it in the panel", 202, code);
      }
      if (!res.ok) {
        const message =
          (typeof errObj?.message === "string" && errObj.message) ||
          (typeof err.error === "string" && err.error) ||
          (typeof err.message === "string" && err.message) ||
          `HTTP ${res.status}`;
        throw new KonCallError(message, res.status, code);
      }
      return { status: res.status, data };
    },
  };
}
