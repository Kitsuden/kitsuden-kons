/**
 * Tier list engine — layout, synchronization and diff
 * ============================================================================
 *
 * One engine, two surfaces: the editorial template and the personal
 * list (TierMaker). What is pinned down here is what both share and what
 * both can break:
 *
 *   · An orphaned layout makes items DISAPPEAR from the screen without warning.
 *   · Syncing with the catalog cannot reorder the editor's work.
 *   · The sign of the `delta` in the diff: S is at the TOP, so moving up a tier is
 *     a LOWER index — and mixing it up would publish promotions as drops.
 */

import { describe, expect, test } from "vitest";

import {
  applyPlacement,
  createTierList,
  decodeTierList,
  diffTierLists,
  encodeTierList,
  place,
  syncWithCatalog,
  tierView,
  validateTierList,
  DEFAULT_TIERS,
  type TierItem,
  type TierList,
} from "../../kons/kon-tierlist/tierlist.engine";

const items: TierItem[] = [
  { id: "ahri", label: "Ahri", imageUrl: null },
  { id: "zed", label: "Zed", imageUrl: null },
  { id: "jinx", label: "Jinx", imageUrl: null },
];

const base = () => createTierList(DEFAULT_TIERS, items);

// ── Creation and validation ──────────────────────────────────────────────────

describe("creation", () => {
  test("everything starts UNRANKED", () => {
    // Placing is a decision; nothing should be born with a default tier.
    const list = base();
    expect(list.placement).toEqual({});
    expect(tierView(list).unranked).toHaveLength(3);
  });

  test("duplicate rows are rejected on creation", () => {
    expect(() =>
      createTierList(
        [
          { id: "s", label: "S", color: "#fff" },
          { id: "s", label: "S2", color: "#000" },
        ],
        items
      )
    ).toThrow(/Duplicate row/);
  });

  test("a list without rows is not a tier list", () => {
    expect(() => createTierList([], items)).toThrow(/at least one row/);
  });
});

describe("validation", () => {
  test("a healthy list gives no errors", () => {
    expect(validateTierList(base())).toHaveLength(0);
  });

  test("an ORPHANED layout is detected", () => {
    // It is the silent failure: if a row is deleted and people are left pointing to
    // it, those items vanish from the screen and nobody knows why.
    const broken: TierList = { ...base(), placement: { ahri: "fila-borrada" } };
    const errors = validateTierList(broken);
    expect(errors.some((e) => e.includes("fila-borrada"))).toBe(true);
  });

  test("a placed item that is not in the list is detected", () => {
    const broken: TierList = { ...base(), placement: { fantasma: "s" } };
    expect(validateTierList(broken).some((e) => e.includes("fantasma"))).toBe(true);
  });
});

// ── Placing ──────────────────────────────────────────────────────────────────

describe("colocar", () => {
  test("moves and groups by row", () => {
    const list = place(place(base(), "ahri", "s"), "zed", "b");
    const view = tierView(list);

    expect(view.rows.find((r) => r.tier.id === "s")!.items.map((i) => i.id)).toEqual(["ahri"]);
    expect(view.rows.find((r) => r.tier.id === "b")!.items.map((i) => i.id)).toEqual(["zed"]);
    expect(view.unranked.map((i) => i.id)).toEqual(["jinx"]);
  });

  test("`null` returns to the unranked pool", () => {
    const placed = place(base(), "ahri", "s");
    expect(tierView(place(placed, "ahri", null)).unranked).toHaveLength(3);
  });

  test("it is immutable: the original list does not change", () => {
    // It is what allows undo in the editor by keeping previous states,
    // without the engine knowing about history.
    const original = base();
    place(original, "ahri", "s");
    expect(original.placement).toEqual({});
  });

  test("placing in a nonexistent row is rejected", () => {
    expect(() => place(base(), "ahri", "z")).toThrow(/does not exist/);
  });

  test("placing a foreign item is rejected", () => {
    expect(() => place(base(), "fantasma", "s")).toThrow(/is not in this tier list/);
  });

  test("the order within a row is STABLE across renders", () => {
    // Sorting by "when it was placed" would make the same list look
    // different depending on how it was assembled.
    const a = place(place(base(), "zed", "s"), "ahri", "s");
    const b = place(place(base(), "ahri", "s"), "zed", "s");
    const ids = (l: TierList) => tierView(l).rows[0].items.map((i) => i.id);
    expect(ids(a)).toEqual(ids(b));
  });
});

// ── Syncing with the catalog ─────────────────────────────────────────────────

describe("syncing with the catalog", () => {
  const placed = place(place(base(), "ahri", "s"), "zed", "b");

  test("what is NEW enters unranked, it is not forgotten", () => {
    // The classic failure of a hand-made tier list: a character comes in and nobody
    // remembers to add it.
    const synced = syncWithCatalog(placed, [
      ...items,
      { id: "yone", label: "Yone", imageUrl: null },
    ]);
    expect(tierView(synced).unranked.map((i) => i.id)).toContain("yone");
  });

  test("what is REMOVED leaves with its placement", () => {
    const synced = syncWithCatalog(
      placed,
      items.filter((i) => i.id !== "ahri")
    );
    expect(synced.items.map((i) => i.id)).not.toContain("ahri");
    expect(synced.placement.ahri).toBeUndefined();
  });

  test("existing placements are NOT touched", () => {
    // Resyncing after a patch cannot reorder the editor's work.
    const synced = syncWithCatalog(placed, [
      ...items,
      { id: "yone", label: "Yone", imageUrl: null },
    ]);
    expect(synced.placement.ahri).toBe("s");
    expect(synced.placement.zed).toBe("b");
  });

  test("the catalog rules on name and image", () => {
    // A character can be renamed; the tier list does not own the record.
    const synced = syncWithCatalog(placed, [
      { id: "ahri", label: "Ahri (rework)", imageUrl: "https://x/ahri.png" },
    ]);
    expect(synced.items[0].label).toBe("Ahri (rework)");
    expect(synced.items[0].imageUrl).toBe("https://x/ahri.png");
    expect(synced.placement.ahri).toBe("s"); // but not on placement
  });
});

// ── Diff ─────────────────────────────────────────────────────────────────────

describe("diff between versions: the publishable content", () => {
  const before = place(place(place(base(), "ahri", "c"), "zed", "s"), "jinx", "b");

  test("moving up a tier is a PROMOTION, even if the index goes down", () => {
    // S is at the TOP: from C (index 3) to A (index 1) the delta is -2. Mixing up
    // the sign would publish promotions as drops.
    const after = place(before, "ahri", "a");
    const diff = diffTierLists(before, after);

    expect(diff.promoted.map((c) => c.item.id)).toEqual(["ahri"]);
    expect(diff.promoted[0].delta).toBe(-2);
    expect(diff.promoted[0].from!.id).toBe("c");
    expect(diff.promoted[0].to!.id).toBe("a");
    expect(diff.demoted).toHaveLength(0);
  });

  test("moving down a tier is a DEMOTION", () => {
    const diff = diffTierLists(before, place(before, "zed", "d"));
    expect(diff.demoted.map((c) => c.item.id)).toEqual(["zed"]);
    expect(diff.demoted[0].delta).toBeGreaterThan(0);
  });

  test("what did not move is counted, not listed", () => {
    // In a catalog of 200 characters, listing the 190 that did not change
    // would bury the 10 that did.
    const diff = diffTierLists(before, place(before, "ahri", "a"));
    expect(diff.unchanged).toBe(2);
  });

  test("a new character comes out as ADDED, not as a promotion", () => {
    const withNew = syncWithCatalog(before, [
      ...items,
      { id: "yone", label: "Yone", imageUrl: null },
    ]);
    const diff = diffTierLists(before, withNew);
    expect(diff.added.map((c) => c.item.id)).toEqual(["yone"]);
    expect(diff.promoted).toHaveLength(0);
  });

  test("a removed character comes out as REMOVED with its previous tier", () => {
    const without = syncWithCatalog(
      before,
      items.filter((i) => i.id !== "zed")
    );
    const diff = diffTierLists(before, without);
    expect(diff.removed.map((c) => c.item.id)).toEqual(["zed"]);
    expect(diff.removed[0].from!.id).toBe("s");
  });

  test("entering the ranking from the pool is a promotion", () => {
    const unranked = createTierList(DEFAULT_TIERS, items);
    const diff = diffTierLists(unranked, place(unranked, "ahri", "s"));
    expect(diff.promoted.map((c) => c.item.id)).toEqual(["ahri"]);
  });
});

// ── Shareable codes ──────────────────────────────────────────────────────────

describe("codes: only the layout travels", () => {
  const list = place(place(base(), "ahri", "s"), "zed", "b");

  test("round trip keeps the layout", () => {
    const decoded = decodeTierList(encodeTierList("plantilla-1", list));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.templateId).toBe("plantilla-1");
      expect(decoded.placement).toEqual({ ahri: "s", zed: "b" });
    }
  });

  test("the ITEMS do not travel: they are already on the server", () => {
    // Sending 200 items in the link would give a URL of several KB to repeat
    // what the template already has.
    const code = encodeTierList("plantilla-1", list);
    expect(atob(code.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("Ahri");
  });

  test("the code is safe for URLs and chats", () => {
    expect(encodeTierList("t", list)).not.toMatch(/[+/=]/);
  });

  test("a broken code does NOT throw", () => {
    for (const junk of ["", "!!!", "aGVsbG8"]) {
      expect(() => decodeTierList(junk)).not.toThrow();
      expect(decodeTierList(junk).ok).toBe(false);
    }
  });

  test("applying an old layout discards what no longer fits, without failing", () => {
    // A code from six months ago should open and show what is still
    // valid, not an error.
    const applied = applyPlacement(base(), {
      ahri: "s",
      withdrawn: "a", // character that is no longer there
      zed: "fila-borrada", // row that no longer exists
    });
    expect(applied.placement).toEqual({ ahri: "s" });
    expect(validateTierList(applied)).toHaveLength(0);
  });
});
