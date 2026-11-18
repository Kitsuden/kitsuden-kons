/**
 * kon-koe: what browsers load — the inbox page and its bundle, the service worker, the web chat widget
 * ============================================================================
 *
 * The routes answer anyone (none of them holds data) with the right content type and cache headers, the
 * scripts parse, the inbox page loads the bundle under a CSP without inline script or eval, and nothing
 * served carries a credential the kon stores.
 */

import { Script } from "node:vm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { koeOperations } from "../../kons/kon-koe";
import { inboxPage } from "../../kons/kon-koe/koe.ops.web";

import { APP_SECRET, koeBench } from "./helpers/koe-bench";

const TOKEN = "EAAG-test-access-token-0123456789abcdef";

const ROUTES = {
  page: "/inbox",
  bundle: "/inbox/koe-inbox.js",
  worker: "/sw.js",
  widget: "/public/webchat/widget.js",
} as const;

describe("kon-koe web assets", () => {
  let k: Awaited<ReturnType<typeof koeBench>>;
  let webchatKey = "";

  beforeAll(async () => {
    k = await koeBench();
    // Credentials the kon keeps sealed: none of them may ever reach a served file.
    const wa = await k.request("admin", "POST", "/channels", {
      kind: "whatsapp",
      name: "Ventas",
      externalId: "1098765432",
      accountId: "waba-1",
      accessToken: TOKEN,
      appSecret: APP_SECRET,
    });
    expect(wa.status).toBe(201);
    const wc = await k.request("admin", "POST", "/channels", { kind: "webchat", name: "Web" });
    expect(wc.status).toBe(201);
    webchatKey = (await wc.json()).data.externalId;
  });

  afterAll(async () => {
    await k?.close();
  });

  it("serves each asset to a visitor without a session, with its content type", async () => {
    const page = await k.request("anon", "GET", ROUTES.page);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);

    for (const route of [ROUTES.bundle, ROUTES.worker, ROUTES.widget]) {
      const res = await k.request("anon", "GET", route);
      expect(res.status, route).toBe(200);
      expect(res.headers.get("content-type"), route).toMatch(/^application\/javascript/);
      expect(res.headers.get("x-content-type-options"), route).toBe("nosniff");
      expect(res.headers.get("etag"), route).toBeTruthy();
    }
  });

  it("the inbox page loads the bundle as a module under a CSP without inline script or eval", async () => {
    const res = await k.request("anon", "GET", ROUTES.page);
    const html = await res.text();
    expect(html).toMatch(/<script type="module" src="[^"]*\/inbox\/koe-inbox\.js"><\/script>/);
    expect(html).toMatch(/<koe-inbox base="[^"]+"><\/koe-inbox>/);
    // The only <script> is the bundle: no inline code.
    expect(html.match(/<script\b/g)).toHaveLength(1);

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("the page names the kon's base path, escaped", () => {
    expect(inboxPage("/api/koe")).toContain('src="/api/koe/inbox/koe-inbox.js"');
    expect(inboxPage('/x"><script>alert(1)</script>')).not.toContain("<script>alert(1)");
  });

  it("the bundle defines <koe-inbox> and is revalidated with its ETag", async () => {
    const res = await k.request("anon", "GET", ROUTES.bundle);
    const body = await res.text();
    expect(body).toMatch(/customElements\.define\(\s*[`"']koe-inbox[`"']/);
    expect(res.headers.get("cache-control")).toContain("must-revalidate");
    const again = await k.request("anon", "GET", ROUTES.bundle, undefined, { "if-none-match": res.headers.get("etag")! });
    expect(again.status).toBe(304);
  });

  it("the service worker fetches the latest notice with the session and opens the inbox on a click", async () => {
    const res = await k.request("anon", "GET", ROUTES.worker);
    const body = await res.text();
    expect(() => new Script(body)).not.toThrow();
    expect(body).toContain("/notices/latest");
    expect(body).toMatch(/credentials:\s*"include"/);
    expect(body).toContain("showNotification");
    expect(body).toContain("notificationclick");
    expect(body).toContain("/inbox");
    // A worker must update promptly.
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("service-worker-allowed")).toMatch(/\/$/);
  });

  it("the widget is a self-contained script in its own shadow DOM that never parses HTML", async () => {
    const res = await k.request("anon", "GET", ROUTES.widget);
    const body = await res.text();
    expect(() => new Script(body)).not.toThrow();
    expect(body).toContain("attachShadow");
    expect(body).toContain("/public/webchat/");
    expect(body).toContain("clientMessageId");
    expect(body).toContain("visitorId");
    // No HTML from the server, no dynamic code: what a strict CSP and an XSS review need.
    expect(body).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);
    expect(body).not.toMatch(/\beval\(|new Function\(|setTimeout\(\s*["'`]/);
    expect(res.headers.get("cache-control")).toMatch(/^public, max-age=\d+/);
  });

  it("no served file carries a stored credential or a channel's key", async () => {
    for (const route of Object.values(ROUTES)) {
      const body = await (await k.request("anon", "GET", route)).text();
      expect(body, route).not.toContain(TOKEN);
      expect(body, route).not.toContain(APP_SECRET);
      expect(body, route).not.toContain(webchatKey);
      expect(body, route).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(body, route).not.toMatch(/\bsk-[A-Za-z0-9]{20,}/);
    }
  });

  it("the web chat the widget talks to answers its config for the key", async () => {
    const res = await k.request("anon", "GET", `/public/webchat/${webchatKey}/config`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ name: "Web", preChatForm: false });
  });

  it("none of these routes is an MCP tool", () => {
    const ids = ["koe-inbox-page", "koe-inbox-bundle", "koe-service-worker", "koe-webchat-widget"];
    const ops = koeOperations(k.ctx) as unknown as Array<{ id?: string; declaration?: { id?: string; mcp?: { exclude?: string } }; mcp?: { exclude?: string } }>;
    for (const id of ids) {
      const op = ops.find((o) => (o.id ?? o.declaration?.id) === id);
      expect(op, id).toBeTruthy();
      expect(op!.mcp?.exclude ?? op!.declaration?.mcp?.exclude, id).toBeTruthy();
    }
  });
});
