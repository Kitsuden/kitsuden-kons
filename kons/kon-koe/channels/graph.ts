/**
 * Meta's Graph API: one client for WhatsApp, Messenger and Instagram
 * ============================================================================
 *
 *   - the webhook signature (`X-Hub-Signature-256`, HMAC-SHA256 of the raw body with the app secret);
 *   - calls with the version pinned per channel, a timeout, and the access token in a header (never in
 *     the URL, never in an error);
 *   - errors classified as retryable (the queue tries again with backoff) or permanent (the message is
 *     marked failed and nobody retries), with the channel marked broken when the token is no longer valid;
 *   - media downloads only from Meta's own hosts, so a forged URL cannot make the API fetch anything else.
 *
 * `fetch` is injectable so the tests never touch the network.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_GRAPH_VERSION = "v23.0";
const GRAPH_ORIGIN = "https://graph.facebook.com";
const TIMEOUT_MS = 20_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let fetcher: Fetch = (...args) => fetch(...args);

/** Tests replace the network. */
export function setGraphFetch(next: Fetch | null): void {
  fetcher = next ?? ((...args) => fetch(...args));
}

export function graphFetch(): Fetch {
  return fetcher;
}

/** `sha256=<hex>` over the exact bytes received. Constant-time comparison. */
export function verifySignature(rawBody: string | Buffer, header: string | undefined | null, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice(7), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function sign(rawBody: string | Buffer, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

/** Codes Meta documents as temporary (rate limits, throughput, service unavailable). */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);
/** The token or the app's access is gone: the channel needs a person. */
const AUTH_CODES = new Set([102, 190, 200, 10]);

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    /** The channel's credentials no longer work. */
    readonly authBroken: boolean,
    readonly subcode?: string,
    readonly details?: string
  ) {
    super(message);
    this.name = "GraphError";
  }
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string }; type?: string };
}

export function classify(status: number, body: unknown): GraphError {
  const e = (body as GraphErrorBody | null)?.error ?? {};
  const code = typeof e.code === "number" ? e.code : status;
  const retryable = status >= 500 || status === 429 || RETRYABLE_CODES.has(code);
  const authBroken = status === 401 || AUTH_CODES.has(code);
  const message = String(e.message ?? `Graph API answered ${status}`).slice(0, 500);
  return new GraphError(message, status, String(code), retryable && !authBroken, authBroken, e.error_subcode ? String(e.error_subcode) : undefined, e.error_data?.details);
}

export interface GraphRequest {
  method?: "GET" | "POST" | "DELETE";
  path: string;
  token: string;
  version?: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
}

export async function graph<T = Record<string, unknown>>(req: GraphRequest): Promise<T> {
  const url = new URL(`${GRAPH_ORIGIN}/${req.version ?? DEFAULT_GRAPH_VERSION}/${req.path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { authorization: `Bearer ${req.token}` };
  let body: BodyInit | undefined;
  if (req.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(req.json);
  } else if (req.form) {
    body = req.form;
  }
  let res: Response;
  try {
    res = await fetcher(url, { method: req.method ?? (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new GraphError(`Graph API unreachable: ${err instanceof Error ? err.name : "error"}`, 0, "network", true, false);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok || (parsed as GraphErrorBody | null)?.error) throw classify(res.status, parsed);
  return parsed as T;
}

/** Hosts Meta serves media from. Anything else is refused. */
const MEDIA_HOSTS = [/\.fbsbx\.com$/, /\.fbcdn\.net$/, /\.cdninstagram\.com$/, /\.facebook\.com$/, /^graph\.facebook\.com$/];

export function isMetaMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && MEDIA_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

/** Largest file koe downloads from a channel (WhatsApp documents go up to 100 MB). */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export async function downloadMedia(url: string, token: string | null): Promise<{ bytes: Buffer; mime: string }> {
  if (!isMetaMediaUrl(url)) throw new GraphError("Media URL is not a Meta host", 0, "media_host", false, false);
  // Meta's lookaside URLs may redirect to its CDN. Each hop must still be a Meta host, and the token only
  // goes to the host it was meant for, never to where a redirect points.
  const origin = new URL(url).host;
  let current = url;
  let res!: Response;
  for (let hop = 0; ; hop++) {
    try {
      res = await fetcher(current, {
        headers: token && new URL(current).host === origin ? { authorization: `Bearer ${token}` } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new GraphError(`Media download failed: ${err instanceof Error ? err.name : "error"}`, 0, "network", true, false);
    }
    if (res.status < 300 || res.status >= 400) break;
    const next = res.headers.get("location");
    if (!next || hop >= 4) throw new GraphError("Media download redirected too often", res.status, "redirect", false, false);
    current = new URL(next, current).toString();
    if (!isMetaMediaUrl(current)) throw new GraphError("Media redirected outside Meta", res.status, "media_host", false, false);
  }
  if (!res.ok) throw new GraphError(`Media download answered ${res.status}`, res.status, String(res.status), res.status >= 500 || res.status === 429, res.status === 401);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new GraphError("Media too large", res.status, "too_large", false, false);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new GraphError("Media too large", res.status, "too_large", false, false);
  return { bytes, mime: res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream" };
}
