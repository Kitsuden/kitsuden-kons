/**
 * A tier list without a catalog has to be able to receive items
 * ============================================================================
 *
 * ── THE DEAD END ───────────────────────────────────────────────────────────
 *
 * The only way for a tier list to have elements was to sync it with
 * a dataset, and the dataset could only be chosen in the CREATE form. With
 * that, two perfectly natural paths ended in a dead screen:
 *
 *   · creating the list without a catalog —what you do if you want to rank ten things
 *     right now— left the board with its rows empty forever;
 *   · and there was no way to attach a dataset to it afterwards, because the
 *     sync button only appeared if the list ALREADY had one.
 *
 * The form footer topped it off by promising that "elements are added
 * from the catalog or on import": there was no way to import.
 *
 * It is the same family as "New Game" leading to a list, or "Exportar"
 * silently returning: it gives no error, leaves no trace, and from outside all you see
 * is that the screen does not do what it says it does.
 *
 * ── AND THE OTHER SIDE ─────────────────────────────────────────────────────
 *
 * Opening the catalog to a list that already has hand-made items introduces
 * a new danger: `syncWithCatalog` leaves the list EQUAL to the catalog, so
 * attaching a dataset would wipe out everything written by hand, and its
 * placement, without saying anything. That has to be stopped, not documented.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  addItems,
  place,
  removeItem,
  syncWithCatalog,
} from "../../kons/kon-tierlist/tierlist.engine";
import { withoutComments } from "../../.kitsuden/tests/unit/helpers/comments";

const ROOT = join(__dirname, "..", "..");
const KON = join(ROOT, "kons", "kon-tierlist");
const ROUTES = withoutComments(readFileSync(join(KON, "index.ts"), "utf-8"));
/**
 * The editor's SOURCES (Svelte 5 + tallao), not its minified bundle: the build renames and
 * folds everything, so a text probe on it would test the minifier. The synced copy of tallao
 * (`admin-src/tallao/`) is left out: it is the kit, not this view.
 */
function editorSources(): string {
  const root = join(KON, "admin-src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === "tallao") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(svelte|ts)$/.test(entry.name)) files.push(readFileSync(path, "utf-8"));
    }
  };
  walk(root);
  return files.join("\n");
}
const EDITOR = editorSources();

/** The chunk of `index.ts` that runs from one route to the next. */
function routeBetween(from: string, until: string): string {
  const i = ROUTES.indexOf(from);
  const j = ROUTES.indexOf(until);
  expect(i, `could not find «${from}»`).toBeGreaterThan(-1);
  expect(j, `could not find «${until}»`).toBeGreaterThan(i);
  return ROUTES.slice(i, j);
}

const list = () => ({
  tiers: [
    { id: "s", label: "S", color: "#ff5252" },
    { id: "a", label: "A", color: "#ff9800" },
  ],
  items: [{ id: "ahri", label: "Ahri", imageUrl: null, sourceRef: null }],
  placement: {} as Record<string, string>,
});

describe("the engine knows how to add and remove by hand", () => {
  it("adding leaves the item in the pool, not placed", () => {
    const after = addItems(list(), [{ id: "zed", label: "Zed", imageUrl: null }]);

    expect(after.items.map((i) => i.id)).toEqual(["ahri", "zed"]);
    expect(after.placement).toEqual({});
  });

  it("adding the same one twice does not duplicate it: it updates it", () => {
    /**
     * It matters because the editor derives the id from the NAME. Without this, fixing a
     * typo by adding again would leave two identical items distinguishable only
     * by looking at the JSON.
     */
    const one = addItems(list(), [{ id: "zed", label: "Zed", imageUrl: null }]);
    const dos = addItems(one, [{ id: "zed", label: "Zed Maestro", imageUrl: "/z.png" }]);

    expect(dos.items).toHaveLength(2);
    expect(dos.items.find((i) => i.id === "zed")).toMatchObject({
      label: "Zed Maestro",
      imageUrl: "/z.png",
    });
  });

  it("removing also takes the placement with it", () => {
    /**
     * Leaving the layout pointing to an item that is no longer there is the "orphaned
     * layout" that `validateTierList` hunts: the next save
     * would fail for a reason that has nothing to do with what was done.
     */
    const placedOne = place(list(), "ahri", "s");
    expect(placedOne.placement).toEqual({ ahri: "s" });

    const after = removeItem(placedOne, "ahri");
    expect(after.items).toEqual([]);
    expect(after.placement).toEqual({});
  });

  it("removing something that is not there complains instead of staying silent", () => {
    expect(() => removeItem(list(), "fantasma")).toThrow();
  });
});

describe("the API exposes both operations", () => {
  it("adding and removing are operations of their own, not a save of the list", () => {
    /**
     * `PUT /templates` could do it by sending all of `items`, but that is what
     * makes two editors overwrite ALL the work and not just what
     * both touched — the same reason placing has its own route.
     */
    expect(ROUTES).toContain('route: "/templates/:slug/items"');
    expect(ROUTES).toContain('route: "/templates/:slug/items/:itemId"');
  });

  it("both check permissions", () => {
    const chunk = routeBetween('route: "/templates/:slug/items"', 'route: "/templates/:slug/sync"');

    // SDK operations: the policy is declared (`action: "update"`) and
    // checked with the template already loaded (`authorize(row)`).
    expect(
      (chunk.match(/action: "update", inHandler: true/g) ?? []).length,
      "adding and removing have to declare the policy"
    ).toBe(2);
    expect(
      (chunk.match(/await authorize\(row\)/g) ?? []).length,
      "adding and removing both have to go through the policy"
    ).toBe(2);
  });
});

describe("attaching a catalog does not silently erase what was done by hand", () => {
  it("the engine, on its own, does take it away", () => {
    /**
     * It is not an engine failure: for a list maintained from a dataset, having
     * what was removed disappear is exactly what is wanted. It is checked
     * here to make clear that the brake goes ABOVE, in the route.
     */
    const withHand = addItems(list(), [{ id: "propia", label: "Mía", imageUrl: null }]);
    const afterValue = syncWithCatalog(withHand, [
      { id: "ahri", label: "Ahri", imageUrl: null, sourceRef: "e1" },
    ]);

    expect(afterValue.items.map((i) => i.id)).toEqual(["ahri"]);
  });

  it("the route detects it by `sourceRef` and stops", () => {
    const sync = routeBetween(
      'route: "/templates/:slug/sync"',
      'route: "/templates/:slug/diff/:otherId"'
    );

    /**
     * `sourceRef` is what distinguishes what came from a dataset from what was written
     * by hand. Without that distinction, the brake would have to stop EVERYTHING — and
     * then resyncing after a patch would ask for confirmation every time, which
     * is how people are taught to confirm without reading.
     */
    expect(sync).toContain("sourceRef");
    expect(sync).toContain("409");
    expect(
      /confirm/.test(sync),
      "there has to be a way to say «yes, go ahead»: a brake with no way out " +
        "is a broken button by another name."
    ).toBe(true);
  });

  it("the warning says WHAT is lost, not just that something is lost", () => {
    const sync = routeBetween(
      'route: "/templates/:slug/sync"',
      'route: "/templates/:slug/diff/:otherId"'
    );

    expect(
      sync.includes("lost"),
      "an «are you sure?» that does not list what it is going to delete is not an " +
        "informed decision: it is accepted without looking."
    ).toBe(true);
  });
});

describe("the editor offers both exits", () => {
  it("the catalog is chosen on the open list, not just on creation", () => {
    expect(
      EDITOR.includes('aria-label="Catalog"') && EDITOR.includes("bind:value={catalogValue}"),
      "if the dataset can only be chosen on creation, a list created without it " +
        "has no way of ever getting one."
    ).toBe(true);
    // Choosing it there fetches it: the dropdown's change syncs.
    expect(EDITOR).toMatch(/bind:value=\{catalogValue\}[\s\S]{0,200}onchange=\{\(\) => void sync\(\)\}/);
  });

  it("there is a form to add by hand", () => {
    expect(EDITOR).toContain("onsubmit={addItems}");
    expect(EDITOR).toContain('aria-label="Chip name"');
    expect(EDITOR).toContain("/items");
  });

  it("the create footer does not promise an «import» that does not exist", () => {
    /**
     * It said "elements are added from the catalog or on import". There
     * was no import anywhere. Promising a function that does not
     * exist sends people looking for it, and whoever looks for it concludes the screen is
     * broken — which is, in practice, what it was.
     */
    expect(
      /al importar|on import|\bimport (them|the items|items)\b/i.test(EDITOR),
      "the text has to describe what the screen really knows how to do."
    ).toBe(false);
  });
});

describe("an empty catalog is not read as «all good»", () => {
  /**
   * ── THE REAL CASE ──────────────────────────────────────────────────────────
   *
   * A tier list was created by choosing a dataset that had ZERO entries. The
   * board came out empty —correct— and the status said "Catálogo al día", which
   * reads as "everything has already been brought in".
   *
   * They are two different situations that looked identical, and the wrong one sends
   * people to review the tier list when the problem is in the dataset. It is the same
   * family as a `catch` that turns "this is broken" into "this does not apply".
   */
  it("`/sync` reports how many items the catalog had", () => {
    const sync = routeBetween(
      'route: "/templates/:slug/sync"',
      'route: "/templates/:slug/diff/:otherId"'
    );

    expect(
      sync.includes("inCatalog"),
      "without the catalog's size, the editor cannot tell «nothing new " +
        "came in» from «there is nothing there»."
    ).toBe(true);
  });

  it("the editor says it with the dataset name in front", () => {
    /**
     * Naming it matters: "the catalog is empty" forces going to look up which one
     * it was. With the name, whoever reads it already knows where to go.
     */
    expect(EDITOR).toContain("has no entries yet");
    expect(EDITOR).toContain("r.origin?.dataset");
  });
});
