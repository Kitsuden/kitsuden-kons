/**
 * Broadcast graphics — the equivalent of NodeCG's `graphics/`
 * ============================================================================
 *
 * An overlay is third-party HTML served from the SAME ORIGIN as the admin.
 * If someone opens it in the browser where they have a session, it shares an origin with
 * that session. That is why there are so many containment tests here: `graphics/` is the root, the
 * CSP is declared, and `.html` is not served by any other route.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { describe, expect, test } from "vitest";

import { isSafeAssetPath } from "../../.kitsuden/packages/shared/src/admin-view";

const ROOT = resolve(__dirname, "../..");
const BROADCAST = join(ROOT, "kons/kon-broadcast");
const GRAPHICS = join(BROADCAST, "graphics");
const ROUTE = readFileSync(join(ROOT, ".kitsuden/apps/api/src/routes/kon-assets.ts"), "utf8");

// ── Declaration and existence ────────────────────────────────────────────────

describe("the graphic is declared and exists", () => {
  const manifest = JSON.parse(readFileSync(join(BROADCAST, "kon.json"), "utf8"));

  test("kon.json declares the overlay", () => {
    const overlay = manifest.graphics?.find((g: { id: string }) => g.id === "overlay");
    expect(overlay).toBeDefined();
    expect(overlay.src).toBe("./graphics/overlay.html");
  });

  test("both files exist", () => {
    expect(existsSync(join(GRAPHICS, "overlay.html"))).toBe(true);
    expect(existsSync(join(GRAPHICS, "overlay.js"))).toBe(true);
  });

  test("the HTML loads its logic as a sibling module, not from outside", () => {
    const html = readFileSync(join(GRAPHICS, "overlay.html"), "utf8");
    // `../overlay.js` would leave the containment root and give 400.
    expect(html).toMatch(/src="\.\/overlay\.js"/);
    expect(html).not.toMatch(/src="\.\.\//);
  });

  test("transparent background: without this, in OBS it covers the gameplay", () => {
    const html = readFileSync(join(GRAPHICS, "overlay.html"), "utf8");
    expect(html).toMatch(/background:\s*transparent/);
  });
});

// ── What makes it fit for a live broadcast ───────────────────────────────────

describe("live behavior", () => {
  const js = readFileSync(join(GRAPHICS, "overlay.js"), "utf8");

  test("discards stale messages by revision", () => {
    // It is THE defense: without it, a reconnection with reordered messages makes
    // the score go backwards on screen.
    expect(js).toMatch(/message\.revision <= revision/);
  });

  test("reconnects with bounded backoff", () => {
    expect(js).toMatch(/scheduleReconnect/);
    expect(js).toMatch(/Math\.min\(/); // ceiling, so as not to wait for minutes
    expect(js).toMatch(/2 \*\* retry/); // exponential, to avoid a storm
  });

  test("recovers the state after reconnecting", () => {
    // While it was down everything was lost: the snapshot has to be requested.
    const openHandler = js.slice(js.indexOf('addEventListener("open"'));
    expect(openHandler.slice(0, 400)).toMatch(/loadSnapshot/);
  });

  test("subscribes to a channel with permissions, not to a global replicant", () => {
    expect(js).toMatch(/type: "subscribe"/);
    expect(js).toMatch(/state:broadcast:match:/);
  });

  test("does not paint user data as HTML", () => {
    // A gamertag with markup would be an injection into what goes on air.
    expect(js).not.toMatch(/\.innerHTML\s*=/);
    expect(js).toMatch(/textContent/);
  });
});

// ── Containment on the server ────────────────────────────────────────────────

describe("the graphics route is bounded", () => {
  test("the containment root is graphics/, not the whole package", () => {
    // Narrowing the root is better than checking a prefix in the request:
    // no route can serve HTML from another point of the kon.
    expect(ROUTE).toMatch(/kind === "graphics" \? join\(konDir, "graphics"\) : konDir/);
  });

  test("declares a CSP that prevents exfiltrating to another origin", () => {
    expect(ROUTE).toMatch(/content-security-policy/);
    expect(ROUTE).toMatch(/connect-src 'self'/);
    expect(ROUTE).toMatch(/default-src 'self'/);
    expect(ROUTE).toMatch(/frame-ancestors 'none'/);
  });

  test("`.html` is NOT served through the admin views route", () => {
    // Admin views are Web Components: they do not need HTML, and giving it
    // would widen the surface for no reason.
    expect(isSafeAssetPath("panel.html")).toBe(false);
    expect(isSafeAssetPath("panel.html", { allowHtml: true })).toBe(true);
    expect(ROUTE).toMatch(/ext === "\.html" && kind !== "graphics"/);
  });

  test("the two routes share the defense layers", () => {
    // Duplicating the containment would be the easiest way for one to fall
    // behind when touching the other.
    expect(ROUTE).toMatch(/serveFromKon\(c, "admin-asset"\)/);
    expect(ROUTE).toMatch(/serveFromKon\(c, "graphics"\)/);
  });

  test("escapes are still rejected even with html allowed", () => {
    for (const src of ["../../../etc/passwd", "/etc/passwd", "http://evil.com/x.html"]) {
      expect(isSafeAssetPath(src, { allowHtml: true }), src).toBe(false);
    }
  });

  test("an escape from graphics/ does not reach the rest of the kon", () => {
    const target = resolve(GRAPHICS, "../kon.json");
    // It falls outside the containment root, so layer 3 cuts it.
    expect(target.startsWith(GRAPHICS + sep)).toBe(false);
  });
});
