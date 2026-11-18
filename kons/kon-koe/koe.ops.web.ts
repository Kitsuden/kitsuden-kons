/**
 * What browsers load: the inbox page and its bundle, the service worker, the web chat widget
 * ============================================================================
 *
 *   GET /inbox                      the live inbox: a page that mounts <koe-inbox> full screen
 *   GET /inbox/koe-inbox.js         the inbox's bundle (built from admin-src/KoeInbox.svelte into admin/)
 *   GET /sw.js                      the service worker for web push (public/koe-sw.js)
 *   GET /public/webchat/widget.js   the embeddable web chat (public/webchat-widget.js)
 *
 * All public: none of them holds data. The inbox page runs on the API's own origin, so the bundle calls the
 * inbox operations with the person's session cookie; signed out, the element says so. The page and the
 * worker live under the kon's path, so the worker's default scope (`/api/koe/`) already covers the inbox.
 *
 * The files are read from the kon's package (`files[]` has `admin` and `public`) and kept in memory until
 * they change on disk. The inbox page sends its own CSP: scripts only from this origin (no inline script,
 * no eval); inline styles allowed, because Svelte's components inject theirs into the element's shadow root.
 *
 * The bundle is also reachable as an admin asset (`/api/kons/kon-koe/admin-asset/admin/koe-inbox.js`, next
 * to the declared `admin/koe-admin.js`), but that route belongs to the host; the page loads the kon's own
 * copy so it works wherever the kon is mounted.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Context } from "hono";

import type { OperationsModule } from "./operations";

const JS = "application/javascript; charset=utf-8";

interface Asset {
  mtimeMs: number;
  body: string;
  etag: string;
}

const assets = new Map<string, Asset>();

/** A file of the kon's package, read again only when it changed on disk. */
function asset(relative: string): Asset | null {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const known = assets.get(relative);
  if (known && known.mtimeMs === mtimeMs) return known;
  const body = readFileSync(path, "utf8");
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  const fresh = { mtimeMs, body, etag };
  assets.set(relative, fresh);
  return fresh;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the host's variables
type Ctx = Context<any, any>;

/** A script with a validator: the browser revalidates it cheaply instead of trusting an old copy. */
function script(c: Ctx, file: Asset | null, cache: string, extra: Record<string, string> = {}) {
  if (!file) return c.json({ error: { code: "KITSUDEN_E_NOT_FOUND", message: "Not built: run pnpm build:admin kon-koe" } }, 404);
  c.header("Content-Type", JS);
  c.header("Cache-Control", cache);
  c.header("ETag", file.etag);
  c.header("X-Content-Type-Options", "nosniff");
  for (const [k, v] of Object.entries(extra)) c.header(k, v);
  if (c.req.header("if-none-match") === file.etag) return c.body(null, 304);
  return c.body(file.body);
}

/** The kon's base path as the browser asked for it ("/api/koe"), from a route under it. */
function baseOf(c: Ctx, suffix: string): string {
  const path = c.req.path;
  return path.endsWith(suffix) && path.length > suffix.length ? path.slice(0, -suffix.length) : "/api/koe";
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const DARK = `--kitsuden-bg: 9 9 11; --kitsuden-card: 24 24 27; --kitsuden-border: 39 39 42; --kitsuden-muted: 63 63 70;
      --kitsuden-subtle: 144 144 154; --kitsuden-text: 250 250 250; --kitsuden-text-dim: 161 161 170;
      --kitsuden-accent: 168 85 247; --kitsuden-accent-hover: 192 132 252; --kitsuden-accent-dim: 126 58 194;
      --kitsuden-on-accent: 9 9 11; --kitsuden-on-status: 9 9 11; --kitsuden-green: 52 211 153;
      --kitsuden-amber: 251 191 36; --kitsuden-info: 96 165 250; --kitsuden-danger: 248 113 113;
      --kitsuden-tone-ink: 0%; color-scheme: dark;`;

/**
 * The page: the theme variables tallao's ThemeScope reads (`--kitsuden-*`, light and dark, following the
 * system unless the inbox sets `data-theme` on <html>), and the element.
 */
export function inboxPage(base: string): string {
  const b = escapeAttr(base);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Inbox · koe</title>
<style>
  :root {
    --kitsuden-bg: 250 250 250; --kitsuden-card: 255 255 255; --kitsuden-border: 228 228 231;
    --kitsuden-muted: 212 212 216; --kitsuden-subtle: 113 113 122; --kitsuden-text: 24 24 27;
    --kitsuden-text-dim: 82 82 91; --kitsuden-accent: 109 40 217; --kitsuden-accent-hover: 124 58 237;
    --kitsuden-accent-dim: 91 33 182; --kitsuden-on-accent: 255 255 255; --kitsuden-on-status: 255 255 255;
    --kitsuden-green: 21 128 61; --kitsuden-amber: 180 83 9; --kitsuden-info: 29 78 216;
    --kitsuden-danger: 190 18 60; --kitsuden-tone-ink: 55%; color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      ${DARK}
    }
  }
  :root[data-theme="dark"] {
      ${DARK}
  }
  html, body { margin: 0; height: 100%; background: rgb(var(--kitsuden-bg)); color: rgb(var(--kitsuden-text)); }
  body { font-family: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif; }
  koe-inbox { display: block; height: 100vh; height: 100dvh; }
</style>
<script type="module" src="${b}/inbox/koe-inbox.js"></script>
</head>
<body>
<koe-inbox base="${b}"></koe-inbox>
<noscript><p>The inbox needs JavaScript.</p></noscript>
</body>
</html>
`;
}

/** The page's CSP: this origin only, plus media from wherever storage signs its URLs. */
function inboxCsp(c: Ctx): string {
  const host = c.req.header("host");
  const scheme = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  // `'self'` covers the same-origin WebSocket in current browsers; older Safari needs it spelled out.
  const ws = host && /^[A-Za-z0-9.:[\]-]+$/.test(host) ? ` ${scheme === "https" ? "wss" : "ws"}://${host}` : "";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    `connect-src 'self'${ws}`,
    "worker-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const webOperations: OperationsModule = (app) => {
  app.get(
    "/inbox",
    {
      id: "koe-inbox-page",
      summary: "The live inbox (HTML)",
      description: "A page that loads the inbox for people: conversations, thread and contact, live, with web push. It uses the browser's session; signed out, it asks to sign in.",
      access: "public",
      output: { type: "text/html", description: "The inbox page" },
      mcp: { exclude: "HTML page for people in a browser, not data" },
    },
    (c) => {
      c.header("Content-Type", "text/html; charset=utf-8");
      c.header("Cache-Control", "no-cache");
      c.header("Content-Security-Policy", inboxCsp(c));
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Referrer-Policy", "no-referrer");
      return c.body(inboxPage(baseOf(c, "/inbox")));
    }
  );

  app.get(
    "/inbox/koe-inbox.js",
    {
      id: "koe-inbox-bundle",
      summary: "The inbox's script",
      description: "The <koe-inbox> web component the inbox page loads.",
      access: "public",
      output: { type: "application/javascript" },
      mcp: { exclude: "JavaScript asset for the inbox page, not data" },
    },
    (c) => script(c, asset("./admin/koe-inbox.js"), "public, max-age=0, must-revalidate")
  );

  app.get(
    "/sw.js",
    {
      id: "koe-service-worker",
      summary: "The inbox's service worker",
      description: "Shows web push notices: on an (empty) push it reads the newest notice with the person's session, and a click opens that conversation in the inbox.",
      access: "public",
      output: { type: "application/javascript" },
      mcp: { exclude: "service worker script for browsers, not data" },
    },
    // A worker must update promptly: the browser always revalidates it.
    (c) => script(c, asset("./public/koe-sw.js"), "no-cache", { "Service-Worker-Allowed": `${baseOf(c, "/sw.js")}/` })
  );

  app.get(
    "/public/webchat/widget.js",
    {
      id: "koe-webchat-widget",
      summary: "Embeddable web chat (JavaScript)",
      description:
        'A self-contained script: `<script src=".../api/koe/public/webchat/widget.js" data-key="<web chat key>" crossorigin="anonymous" defer></script>` adds a chat button to a page. The site must be one the API allows (CORS) and, if the channel lists sites, one of them.',
      access: "public",
      output: { type: "application/javascript" },
      mcp: { exclude: "JavaScript asset for web pages, not data" },
    },
    (c) => script(c, asset("./public/webchat-widget.js"), "public, max-age=300, stale-while-revalidate=3600")
  );
};
