/**
 * kon-dc — fetching what a server owner points at (feeds), without becoming a proxy into the network
 * ============================================================================
 *
 * A feed URL is written by whoever configures a server, and the API fetches it: that is a server-side
 * request to an address someone else chose. So, before each request and each redirect:
 *
 *   · https only, no user:password, default port only;
 *   · the host's addresses are resolved and REFUSED when any is private, loopback, link-local
 *     (cloud metadata 169.254.169.254), CGNAT, multicast or unspecified, IPv4 or IPv6;
 *   · redirects are followed by hand (at most 3) and each target is checked again;
 *   · 8 s and 1 MB at most; only text answers.
 *
 * DNS can still answer differently between the check and the connection (rebinding); the window is
 * small and the answers are only parsed as feeds, never returned to the caller as they are.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class FetchRefused extends Error {}

/** Fetches a text resource. Injected in tests. */
export type TextFetcher = (url: string) => Promise<{ status: number; text: string; contentType: string }>;

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 8000;

function v4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Is this address one a feed must never reach? */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return v4Private(ip);
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return v4Private(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6) || v6.startsWith("64:ff9b:") || v6.startsWith("2001:db8:");
}

/** Throws FetchRefused unless the URL may be fetched. */
export async function checkUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused("Not a URL");
  }
  if (url.protocol !== "https:") throw new FetchRefused("Only https feeds");
  if (url.username || url.password || url.port) throw new FetchRefused("No credentials or ports in feed URLs");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(privateAddress)) throw new FetchRefused("That host is not reachable from here");
  return url;
}

/** The default fetcher: checked, redirects by hand, time and size caps. */
export const safeFetchText: TextFetcher = async (raw) => {
  let url = await checkUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "kon-dc feeds (+https://github.com/Kitsuden/kitsuden-kons)", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.8, */*;q=0.5" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await checkUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new FetchRefused("Too large");
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new FetchRefused("Too large");
      }
      chunks.push(value);
    }
    return { status: res.status, text: new TextDecoder().decode(Buffer.concat(chunks)), contentType };
  }
  throw new FetchRefused("Too many redirects");
};

/**
 * A JSON document through the same checked fetcher (the levels import reads MEE6's public
 * leaderboard with it). Gives the status and the parsed body, or null when it is not JSON.
 */
export async function fetchJson(fetchText: TextFetcher, url: string): Promise<{ status: number; data: unknown }> {
  const res = await fetchText(url);
  let data: unknown = null;
  try {
    data = JSON.parse(res.text);
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

// ── Feeds: a small RSS / Atom reader ────────────────────────────────────────────────────────────

export interface FeedEntry {
  id: string;
  title: string;
  link: string;
  author: string;
  published: string;
  image: string;
}

/** Removes tags until none is left (a tag split by another, `<scr<b>ipt`, cannot survive one pass). */
function stripTags(s: string): string {
  let out = s;
  for (let i = 0; i < 10; i++) {
    const next = out.replace(/<[^<>]*>/g, "");
    if (next === out) break;
    out = next;
  }
  // What is left of a tag that never closed goes too: feed text is plain text for Discord.
  return out.replace(/</g, "‹");
}

const decode = (s: string) =>
  stripTags(
    s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n) % 0x110000))
      .replace(/&amp;/g, "&")
  ).trim();

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decode(m[1]) : "";
}

function attr(block: string, name: string, attribute: string, where?: RegExp): string {
  const re = new RegExp(`<${name}\\b([^>]*)/?>`, "gi");
  for (const m of block.matchAll(re)) {
    if (where && !where.test(m[1])) continue;
    const a = new RegExp(`${attribute}="([^"]*)"`, "i").exec(m[1]);
    if (a) return decode(a[1]);
  }
  return "";
}

/** The entries of an RSS 2.0 or Atom document, newest first as the feed lists them (up to 30). */
export function parseFeed(xml: string): FeedEntry[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].slice(0, 30).map((m) => m[0]);
  return blocks
    .map((b) => {
      const link = tag(b, "link") || attr(b, "link", "href", /rel="alternate"|^(?![\s\S]*rel=)/) || attr(b, "link", "href");
      const id = tag(b, "guid") || tag(b, "id") || tag(b, "yt:videoId") || link;
      return {
        id: id.slice(0, 300),
        title: tag(b, "title").slice(0, 300),
        link: /^https?:\/\//.test(link) ? link.slice(0, 500) : "",
        author: (tag(b, "author") || tag(b, "dc:creator") || tag(b, "name")).slice(0, 100),
        published: tag(b, "pubDate") || tag(b, "published") || tag(b, "updated"),
        image: (attr(b, "media:thumbnail", "url") || attr(b, "enclosure", "url", /type="image/)).slice(0, 500),
      };
    })
    .filter((e) => e.id && (e.title || e.link));
}
