/**
 * Membership access control
 * ============================================================================
 *
 * A failure here has two forms and both are costly: giving away the paid
 * archive, or blocking someone who already paid. That is why the logic is pure and is tested
 * exhaustively, just like the bracket engine.
 *
 * The most important test in the file is the wall one: it checks that paid content
 * **does not travel** to the client without access. Hiding it in the browser is the
 * classic mistake — the full text is read with Ctrl+U.
 */

import { describe, expect, test } from "vitest";

import {
  canAccess,
  gateBlocks,
  gateHtml,
  grantFromSubscription,
  isGrantActive,
  viewerLevel,
  type AccessGrant,
  type TierRef,
  type Viewer,
} from "../../kons/kon-members/members.access";

const NOW = new Date("2026-06-15T12:00:00Z");
const past = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const future = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

const TIERS: TierRef[] = [
  { id: "t-free", slug: "free", name: "Gratis", level: 0 },
  { id: "t-basic", slug: "basic", name: "Básico", level: 1 },
  { id: "t-pro", slug: "pro", name: "Pro", level: 2 },
];

function grant(tierId: string, overrides: Partial<AccessGrant> = {}): AccessGrant {
  return { tierId, startsAt: past(30), endsAt: null, revokedAt: null, ...overrides };
}

function viewer(...grants: AccessGrant[]): Viewer {
  return { memberId: "m1", grants };
}

// ── Validity of grants ───────────────────────────────────────────────────────

describe("vigencia", () => {
  test("a grant without expiry is alive", () => {
    expect(isGrantActive(grant("t-pro"), NOW)).toBe(true);
  });

  test("one that has not started yet, is not", () => {
    expect(isGrantActive(grant("t-pro", { startsAt: future(1) }), NOW)).toBe(false);
  });

  test("an expired one, is not", () => {
    expect(isGrantActive(grant("t-pro", { endsAt: past(1) }), NOW)).toBe(false);
  });

  test("the exact end instant NO longer gives access", () => {
    // Boundary: with `<` instead of `<=` an extra instant would be given away.
    expect(isGrantActive(grant("t-pro", { endsAt: NOW }), NOW)).toBe(false);
  });

  test("a revoked one, is not — even if it had not expired", () => {
    expect(isGrantActive(grant("t-pro", { revokedAt: past(1) }), NOW)).toBe(false);
  });

  test("a future revocation does not apply yet", () => {
    expect(isGrantActive(grant("t-pro", { revokedAt: future(5) }), NOW)).toBe(true);
  });
});

// ── Effective level ──────────────────────────────────────────────────────────

describe("visitor level", () => {
  test("an anonymous user is level 0", () => {
    expect(viewerLevel(null, TIERS, NOW)).toBe(0);
  });

  test("takes the MAXIMUM of the live grants, not the last one", () => {
    // Someone with a basic subscription and a pro gift should see as pro.
    const v = viewer(grant("t-basic"), grant("t-pro"));
    expect(viewerLevel(v, TIERS, NOW)).toBe(2);
  });

  test("ignores expired ones when computing the maximum", () => {
    const v = viewer(grant("t-pro", { endsAt: past(1) }), grant("t-basic"));
    expect(viewerLevel(v, TIERS, NOW)).toBe(1);
  });

  test("a grant to a tier that no longer exists neither breaks nor elevates", () => {
    expect(viewerLevel(viewer(grant("t-borrado")), TIERS, NOW)).toBe(0);
  });
});

// ── Access decision ──────────────────────────────────────────────────────────

describe("public content", () => {
  test("anyone sees it, even without registering", () => {
    expect(canAccess({ visibility: "public" }, null, TIERS, NOW).allowed).toBe(true);
  });
});

describe("content for members", () => {
  test("being registered is enough, even if free", () => {
    const d = canAccess({ visibility: "members" }, viewer(grant("t-free")), TIERS, NOW);
    expect(d.allowed).toBe(true);
  });

  test("an anonymous user does not, and the reason says so", () => {
    const d = canAccess({ visibility: "members" }, null, TIERS, NOW);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("anonymous");
  });
});

describe("paid content", () => {
  test("a free member does not get in", () => {
    const d = canAccess({ visibility: "paid" }, viewer(grant("t-free")), TIERS, NOW);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("needs-paid");
  });

  test("a paying member does", () => {
    const d = canAccess({ visibility: "paid" }, viewer(grant("t-basic")), TIERS, NOW);
    expect(d.allowed).toBe(true);
  });

  test("a higher tier too: the hierarchy is cumulative", () => {
    // Without this, upgrading a plan would remove access to what the lower plans have.
    const d = canAccess(
      { visibility: "paid", minTierLevel: 1 },
      viewer(grant("t-pro")),
      TIERS,
      NOW
    );
    expect(d.allowed).toBe(true);
  });

  test("an insufficient tier is distinguished from having none", () => {
    const d = canAccess(
      { visibility: "paid", minTierLevel: 2 },
      viewer(grant("t-basic")),
      TIERS,
      NOW
    );
    expect(d.allowed).toBe(false);
    // The reason lets us tell them "upgrade to Pro" instead of "subscribe".
    expect(d.reason).toBe("needs-higher-tier");
    expect(d.viewerLevel).toBe(1);
    expect(d.requiredLevel).toBe(2);
  });

  test("an expired subscription stops giving access", () => {
    const d = canAccess(
      { visibility: "paid" },
      viewer(grant("t-pro", { endsAt: past(1) })),
      TIERS,
      NOW
    );
    expect(d.allowed).toBe(false);
  });

  test("an unknown visibility is treated as PAID, not as public", () => {
    // Deny-by-default in the direction that matters: being wrong on the
    // restrictive side is detected through complaints; on the permissive side, when you have already given away
    // the whole archive.
    const d = canAccess({ visibility: "inventada" as never }, null, TIERS, NOW);
    expect(d.allowed).toBe(false);
  });
});

// ── The wall: what must NOT travel to the client ─────────────────────────────

describe("paywall — the content is not sent", () => {
  const blocks = [{ t: "p1" }, { t: "p2" }, { t: "p3" }, { t: "p4" }, { t: "p5" }];
  const denied = canAccess({ visibility: "paid" }, null, TIERS, NOW);
  const allowed = canAccess({ visibility: "public" }, null, TIERS, NOW);

  test("with access everything arrives", () => {
    const out = gateBlocks(blocks, allowed);
    expect(out.content).toHaveLength(5);
    expect(out.gated).toBe(false);
  });

  test("without access the hidden content does NOT travel", () => {
    const out = gateBlocks(blocks, denied, { freeBlocks: 2 });

    expect(out.gated).toBe(true);
    expect(out.content).toHaveLength(2);
    // The check that matters: the paid blocks are not in the
    // response. Hiding them in the browser would leave them readable with Ctrl+U.
    expect(JSON.stringify(out.content)).not.toContain("p3");
    expect(JSON.stringify(out.content)).not.toContain("p5");
  });

  test("with 0 free blocks nothing of the body is seen", () => {
    expect(gateBlocks(blocks, denied, { freeBlocks: 0 }).content).toEqual([]);
  });

  test("does NOT mutate the original document", () => {
    // It could come from a shared cache: truncating it would break it for everyone.
    const original = [...blocks];
    gateBlocks(blocks, denied, { freeBlocks: 1 });
    expect(blocks).toEqual(original);
    expect(blocks).toHaveLength(5);
  });

  test("tolerates empty or missing content", () => {
    expect(gateBlocks(null, denied).content).toEqual([]);
    expect(gateBlocks(undefined, allowed).content).toEqual([]);
  });

  test("the excerpt is sent: it is the hook", () => {
    const out = gateBlocks(blocks, denied, { freeBlocks: 0, excerpt: "Un resumen" });
    expect(out.excerpt).toBe("Un resumen");
  });
});

describe("wall over HTML", () => {
  const html = "<p>uno</p><p>dos</p><p>tres</p>";
  const denied = canAccess({ visibility: "paid" }, null, TIERS, NOW);

  test("cuts by paragraphs, without splitting tags", () => {
    const out = gateHtml(html, denied, { freeParagraphs: 1 });
    expect(out.content).toBe("<p>uno</p>");
    // A cut by characters would leave "<p>do" and break the page.
    expect(out.content).not.toContain("dos");
  });

  test("without free paragraphs nothing arrives", () => {
    expect(gateHtml(html, denied, { freeParagraphs: 0 }).content).toBe("");
  });
});

// ── Bridge with kon-payments ────────────────────────────────────────────────

describe("grant from a subscription", () => {
  test("an active one grants until the end of the period", () => {
    const g = grantFromSubscription(
      { id: "s1", status: "active", currentPeriodEnd: future(20) },
      "t-pro",
      NOW
    );
    expect(g).not.toBeNull();
    expect(g!.endsAt).toEqual(future(20));
  });

  test("one on trial too", () => {
    expect(
      grantFromSubscription(
        { id: "s1", status: "trialing", currentPeriodEnd: future(7) },
        "t-pro",
        NOW
      )
    ).not.toBeNull();
  });

  test("a CANCELED one keeps access until what was paid runs out", () => {
    // Cutting off on the cancellation day is keeping money for a service
    // no prestado.
    const g = grantFromSubscription(
      { id: "s1", status: "canceled", currentPeriodEnd: future(12), canceledAt: past(2) },
      "t-pro",
      NOW
    );
    expect(g).not.toBeNull();
    expect(isGrantActive(g!, NOW)).toBe(true);
    // And it stops being valid when the period runs out.
    expect(isGrantActive(g!, future(13))).toBe(false);
  });

  test("an unpaid one grants nothing", () => {
    for (const status of ["past_due", "unpaid", "incomplete", "paused"]) {
      expect(
        grantFromSubscription({ id: "s1", status, currentPeriodEnd: future(20) }, "t-pro", NOW),
        status
      ).toBeNull();
    }
  });

  test("a canceled one without a paid period neither", () => {
    expect(
      grantFromSubscription({ id: "s1", status: "canceled", currentPeriodEnd: null }, "t-pro", NOW)
    ).toBeNull();
  });
});
