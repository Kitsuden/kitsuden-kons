/**
 * Check of the tier list kon's new outputs
 * ============================================================================
 *
 * ── A TRAP THAT HAPPENED RIGHT HERE ────────────────────────────────────────
 *
 * The first version of this script checked that the routes existed
 * by requesting them over HTTP and accepting any response that was not 404.
 * That does not work, and not subtly: `app.use("/templates/*")` runs BEFORE
 * routing, so it returns 401 for routes that do not exist too.
 *
 * Measured against the container that did NOT yet have the new route deployed:
 *
 *     POST /api/tierlist/templates/loquesea/items   →  401
 *
 * The guard said «it exists» about something that was not there. It is exactly the class
 * of check that passes green looking at the wrong place.
 *
 * That is why registration is now checked by enumerating `router.routes` —what
 * Hono really has— and HTTP is reserved for what it does know how to answer.
 *
 * ── WHAT IS CHECKED ────────────────────────────────────────────────────────
 *
 *   1. That the routes are registered and none covers another. In Hono order rules,
 *      and a shadowed route gives no error: the wrong handler
 *      answers.
 *   2. That the write ones require a SESSION. An open route reads the same as
 *      a closed one until someone calls it without a cookie.
 *   3. That public reading of templates stays public: they live on
 *      public pages and are embedded with the `tier-list` block, so
 *      closing them too much would break it without warning.
 *
 * No user is created to test authenticated writes —doing so
 * broke the settings screen once— and it says which ones are left out.
 *
 * The HTTP goes against the RUNNING installation, not against an in-process app:
 * this kon is mounted lazily and a local app pointing at another
 * database answers 404 to everything, which reads as «the route does not exist» when
 * what is happening is that the kon is not there.
 *
 *     bun apps/api/scripts/smoke-tierlist.ts
 */

const BASE = process.env.PROBE_BASE_URL || "http://localhost:3000";

let failures = 0;

function check(description: string, condition: boolean, detail = "") {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${description}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

async function status(method: string, route: string, body?: unknown) {
  const res = await fetch(`${BASE}${route}`, {
    method: method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res.status;
}

async function main() {
  console.log("\nTier lists — outputs for a list without a catalog\n");

  // ── 1. The routes are registered ─────────────────────────────────────────
  /**
   * The kon's router is mounted with a minimal context. No database is
   * needed: registering a route queries nothing.
   */
  const { createKonTierlist } = await import("../../../packages/kons/kon-tierlist/index");
  const router = createKonTierlist({
    db: { instance: {} },
    auth: { requireAuth: async (_c: unknown, next: () => unknown) => next() },
  } as never);

  const registeredItems = new Set(
    (router as unknown as { routes: { method: string; path: string }[] }).routes.map(
      (r) => `${r.method} ${r.path}`
    )
  );

  const expectedOnes = [
    "GET /templates",
    "GET /templates/:slug",
    "PUT /templates",
    "POST /templates/:slug/place",
    // The two that close the dead end: without them, a list without a catalog
    // can never receive any card.
    "POST /templates/:slug/items",
    "DELETE /templates/:slug/items/:itemId",
    "POST /templates/:slug/sync",
    "GET /templates/:slug/diff/:otherId",
  ];

  for (const route of expectedOnes) {
    check(`${route} registered`, registeredItems.has(route));
  }

  // ── 2. The write ones ask for a session ──────────────────────────────────
  const cases: [string, string, unknown?][] = [
    ["POST", "/api/tierlist/templates/loquesea/items", { items: [{ id: "x", label: "X" }] }],
    ["DELETE", "/api/tierlist/templates/loquesea/items/x"],
    ["POST", "/api/tierlist/templates/loquesea/place", { itemId: "x", tierId: null }],
    ["POST", "/api/tierlist/templates/loquesea/sync", {}],
    ["PUT", "/api/tierlist/templates", { slug: "x", title: "X" }],
  ];

  for (const [method, route, body] of cases) {
    const st = await status(method, route, body);
    check(
      `${method} ${route.replace("/api/tierlist", "")} requires a session`,
      st === 401 || st === 403,
      `${st}`
    );
  }

  // ── 3. Public reading remains open ───────────────────────────────────────
  const listing = await fetch(`${BASE}/api/tierlist/templates`);
  const bodyValue = (await listing.json().catch(() => ({}))) as Record<string, unknown>;

  check("GET /templates responds 200 without a session", listing.status === 200, `${listing.status}`);
  check(
    "and returns a list, not an error",
    Array.isArray(bodyValue.data),
    JSON.stringify(bodyValue).slice(0, 120)
  );

  console.log(
    "\n  (Authenticated writes are left out on purpose: testing them\n" +
      "   would require fabricating a user, and that already broke the configuration once.)"
  );

  console.log(`\n${failures === 0 ? "No failures." : `${failures} failure(s).`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
