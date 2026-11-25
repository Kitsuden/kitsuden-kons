/**
 * kon-site: sites, their domains, and which site a Host is
 * ============================================================================
 *
 * A frontend asks `GET /resolve?host=` on every request. What must hold: the host is matched
 * normalized (case, port, trailing dot), `www.` falls back to the bare domain and never the other
 * way, one site has at most one primary domain, links and images never carry `javascript:` or
 * `data:`, and only admins write.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { respondError } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonSite, hostCandidates, normalizeHost } from "../../kons/kon-site/index";
import { registerSitePolicy } from "../../kons/kon-site/site.policy";

const ADMIN = { id: "u-admin", role: "admin" };
const EDITOR = { id: "u-editor", role: "editor" };
const MEMBER = { id: "u-member", role: "user" };

let client: PGlite;
let site: Hono;

function request(method: string, route: string, user: object | null, body?: unknown) {
  return site.request(route, {
    method,
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const json = async (r: Response) => (await r.json()) as any;

beforeEach(() => registerSitePolicy());
afterAll(async () => client?.close());

beforeAll(async () => {
  client = new PGlite();
  const dir = join(__dirname, "../../kons/kon-site/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  const requireAuth = async (c: any, next: any) =>
    c.get("user") ? next() : c.json({ error: "Unauthorized" }, 401);
  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: { requireAuth } as any,
  });
  const app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.use("*", async (c, next) => {
    const rawValue = c.req.header("x-test-user");
    c.set("user" as never, (rawValue ? JSON.parse(rawValue) : null) as never);
    await next();
  });
  app.route("/", createKonSite(ctx));
  site = app;
});

describe("normalizeHost", () => {
  it("lower case, no port, no trailing dot", () => {
    expect(normalizeHost("Example.COM")).toBe("example.com");
    expect(normalizeHost("example.com:4321")).toBe("example.com");
    expect(normalizeHost("www.example.com.")).toBe("www.example.com");
    expect(normalizeHost(" localhost:3000 ")).toBe("localhost");
    expect(normalizeHost("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
  });

  it("refuses what is not a host name", () => {
    for (const bad of [
      "",
      "https://example.com",
      "example.com/path",
      "user@example.com",
      "[::1]:3000",
      "intranet",
      "-bad.example.com",
      "bad-.example.com",
      `${"a".repeat(64)}.com`,
      "exa mple.com",
    ]) {
      expect(normalizeHost(bad), bad).toBeNull();
    }
  });

  it("www. falls back to the bare host, never the other way", () => {
    expect(hostCandidates("www.example.com")).toEqual(["www.example.com", "example.com"]);
    expect(hostCandidates("example.com")).toEqual(["example.com"]);
    // `www.com` is a host of its own, not the www of `com`.
    expect(hostCandidates("www.com")).toEqual(["www.com"]);
  });
});

describe("kon-site over HTTP", () => {
  const valhalla = {
    slug: "valhalla",
    name: "Valhalla Legion",
    locale: "es",
    logoUrl: "/media/valhalla/logo.svg",
    colors: { primary: "#e11d48", accent: "#0ea5e9" },
    menu: [
      { label: "News", href: "/blog" },
      { label: "Games", href: "/games", children: [{ label: "Wikis", href: "/wikis" }] },
      { label: "Discord", href: "https://discord.gg/example", newTab: true },
    ],
    extra: { footer: "Made by the community" },
  };

  it("an admin creates a site (201) and rewrites it (200), keeping what is left out", async () => {
    const created = await request("PUT", "/sites", ADMIN, valhalla);
    expect(created.status).toBe(201);
    expect((await json(created)).data).toMatchObject({ slug: "valhalla", name: "Valhalla Legion", primaryHost: null });

    const rewritten = await request("PUT", "/sites", ADMIN, { slug: "valhalla", name: "Valhalla", logoUrl: null });
    expect(rewritten.status).toBe(200);
    const data = (await json(rewritten)).data;
    expect(data.name).toBe("Valhalla");
    expect(data.logoUrl).toBeNull();
    expect(data.locale).toBe("es");
    expect(data.menu).toHaveLength(3);
    expect(data.colors).toEqual({ primary: "#e11d48", accent: "#0ea5e9" });
  });

  it("only admins write; staff list; anyone reads one site", async () => {
    expect((await request("PUT", "/sites", EDITOR, valhalla)).status).toBe(403);
    expect((await request("PUT", "/sites", MEMBER, valhalla)).status).toBe(403);
    expect((await request("PUT", "/sites", null, valhalla)).status).toBe(401);
    expect((await request("PUT", "/domains/valhalla.example", EDITOR, { site: "valhalla" })).status).toBe(403);

    expect((await request("GET", "/sites", MEMBER)).status).toBe(403);
    const list = await request("GET", "/sites", EDITOR);
    expect(list.status).toBe(200);
    expect((await json(list)).data.map((s: any) => s.slug)).toContain("valhalla");

    const one = await request("GET", "/sites/valhalla", null);
    expect(one.status).toBe(200);
    expect((await request("GET", "/sites/nope", null)).status).toBe(404);
  });

  it("refuses dangerous links and images, a third menu level and too much extra", async () => {
    const bodies = [
      { ...valhalla, logoUrl: "javascript:alert(1)" },
      { ...valhalla, faviconUrl: "data:image/svg+xml,<svg/>" },
      { ...valhalla, logoUrl: "//evil.example/logo.svg" },
      { ...valhalla, menu: [{ label: "x", href: "javascript:alert(1)" }] },
      { ...valhalla, menu: [{ label: "x", href: "//evil.example" }] },
      {
        ...valhalla,
        menu: [{ label: "a", href: "/a", children: [{ label: "b", href: "/b", children: [{ label: "c", href: "/c" }] }] }],
      },
      { ...valhalla, colors: { primary: "red;}" } },
      { ...valhalla, extra: { blob: "x".repeat(17 * 1024) } },
      { ...valhalla, slug: "Not A Slug" },
    ];
    for (const body of bodies) {
      const r = await request("PUT", "/sites", ADMIN, body);
      // The SDK answers a body that fails its schema with 422 KITSUDEN_E_VALIDATION.
      expect(r.status, JSON.stringify(body).slice(0, 120)).toBe(422);
    }
    // mailto:, tel: and #anchor are links too.
    const ok = await request("PUT", "/sites", ADMIN, {
      ...valhalla,
      menu: [
        { label: "Mail", href: "mailto:hello@example.com" },
        { label: "Call", href: "tel:+50760000000" },
        { label: "Top", href: "#top" },
      ],
    });
    expect(ok.status).toBe(200);
  });

  it("a domain leads to its site; the Host is matched normalized, with the www. fallback", async () => {
    const put = await request("PUT", "/domains/Valhalla.Example:443", ADMIN, { site: "valhalla", primary: true });
    expect(put.status).toBe(201);
    expect((await json(put)).data).toMatchObject({ host: "valhalla.example", site: "valhalla", primary: true });

    for (const host of ["valhalla.example", "VALHALLA.example:4321", "www.valhalla.example", "valhalla.example."]) {
      const r = await request("GET", `/resolve?host=${encodeURIComponent(host)}`, null);
      expect(r.status, host).toBe(200);
      expect((await json(r)).data).toMatchObject({ slug: "valhalla", primaryHost: "valhalla.example" });
    }
    expect((await request("GET", "/resolve?host=other.example", null)).status).toBe(404);
    expect((await request("GET", "/resolve?host=https%3A%2F%2Fvalhalla.example", null)).status).toBe(400);
  });

  it("a host registered with www. answers only with www.", async () => {
    await request("PUT", "/sites", ADMIN, { slug: "tcg", name: "TCG" });
    expect((await request("PUT", "/domains/www.tcg.example", ADMIN, { site: "tcg" })).status).toBe(201);
    expect((await request("GET", "/resolve?host=www.tcg.example", null)).status).toBe(200);
    expect((await request("GET", "/resolve?host=tcg.example", null)).status).toBe(404);
  });

  it("one primary per site: a new primary unsets the old one", async () => {
    expect((await request("PUT", "/domains/valhalla.test", ADMIN, { site: "valhalla", primary: true })).status).toBe(201);
    const list = await json(await request("GET", "/domains?site=valhalla", EDITOR));
    const primaries = list.data.filter((d: any) => d.primary).map((d: any) => d.host);
    expect(primaries).toEqual(["valhalla.test"]);

    // Saving again without `primary` keeps what the domain had.
    expect((await request("PUT", "/domains/valhalla.test", ADMIN, { site: "valhalla" })).status).toBe(200);
    const again = await json(await request("GET", "/resolve?host=valhalla.example", null));
    expect(again.data.primaryHost).toBe("valhalla.test");
  });

  it("moving a domain to another site takes it from the first", async () => {
    expect((await request("PUT", "/domains/shared.example", ADMIN, { site: "valhalla" })).status).toBe(201);
    expect((await request("PUT", "/domains/shared.example", ADMIN, { site: "tcg" })).status).toBe(200);
    const r = await json(await request("GET", "/resolve?host=shared.example", null));
    expect(r.data.slug).toBe("tcg");
    expect((await request("PUT", "/domains/x.example", ADMIN, { site: "nope" })).status).toBe(404);
  });

  it("deleting a domain or a site; a site takes its domains with it", async () => {
    expect((await request("DELETE", "/domains/shared.example", ADMIN)).status).toBe(204);
    expect((await request("DELETE", "/domains/shared.example", ADMIN)).status).toBe(404);
    expect((await request("GET", "/resolve?host=shared.example", null)).status).toBe(404);

    expect((await request("DELETE", "/sites/tcg", EDITOR)).status).toBe(403);
    expect((await request("DELETE", "/sites/tcg", ADMIN)).status).toBe(204);
    expect((await request("GET", "/resolve?host=www.tcg.example", null)).status).toBe(404);
    const domains = await json(await request("GET", "/domains", ADMIN));
    expect(domains.data.map((d: any) => d.host)).not.toContain("www.tcg.example");
  });
});
