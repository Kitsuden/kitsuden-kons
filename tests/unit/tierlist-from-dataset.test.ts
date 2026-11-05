/**
 * A tier list is populated from a dataset, not by hand
 * ============================================================================
 *
 * ── WHAT THERE WAS ─────────────────────────────────────────────────────────
 *
 * `tier_lists.catalog_dataset_id` had existed since the first migration, with this
 * comment in the schema:
 *
 *     "It is what makes a new character appear unranked instead of being
 *      forgotten — the classic failure of hand-maintained tier lists."
 *
 * The column appeared in THREE places in the repo and all three only stored it.
 * Nobody read it. And `POST /templates/:slug/sync` required the catalog
 * to be passed already assembled, so a tier list of a hundred characters had to be
 * written out entirely by hand with the table right next to it.
 *
 * The design was thought out and documented; the piece that ties it together was missing.
 *
 * ── WHAT IT GUARDS ─────────────────────────────────────────────────────────
 *
 * Above all two things that are not obvious:
 *
 *   · That NOTHING is guessed. The label is `data_entries.title` —a `NOT NULL`
 *     column, always there— and the image comes from the field the dataset ITSELF
 *     declares as `image` or `url` in its `schema`. Deducing it from the
 *     column name is where "Agregar All Gam" came from.
 *   · That reading a dataset from inside another kon is NOT a backdoor
 *     to access control: `checkReadAccess` is used, the same function as the
 *     official entries route.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { syncWithCatalog, tierView } from "../../kons/kon-tierlist/tierlist.engine";

const ROOT = join(__dirname, "..", "..");
const KON = join(ROOT, "kons", "kon-tierlist");
const ROUTES = join(KON, "index.ts");
/** The reader lives in `@kitsuden/shared`: three kons share it. */
const READER = join(ROOT, ".kitsuden", "packages", "shared", "src", "dataset-catalog.ts");

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

describe("the catalog comes from the dataset", () => {
  const routes = readFileSync(ROUTES, "utf-8");
  const reader = readFileSync(READER, "utf-8");

  it("`catalogDatasetId` is no longer a dead column", () => {
    expect(
      routes.includes("async function catalogFromDataset"),
      "the piece that turns the dataset into a catalog has to exist. Without " +
        "it, `catalogDatasetId` is stored and nobody reads it."
    ).toBe(true);
  });

  it("respects the dataset's read policy", () => {
    /**
     * Reading data from elsewhere from inside a kon cannot skip the
     * access control of that data. The SAME function as the official
     * entries route is used, not a parallel check.
     *
     * Since the reader is shared, the check lives in ONE place for
     * the three kons that read datasets. That makes it stronger, not weaker: there
     * cannot be a copy that forgets it.
     */
    expect(reader).toContain("checkReadAccess");
    expect(routes).toContain("readDatasetCatalog");
  });

  it("the kon has no dataset reader of its own", () => {
    /**
     * The reason the reader is shared is not to save lines: it is that the
     * copy that silently goes out of sync is the ACCESS one. It is enough for a kon
     * to write its own `SELECT ... FROM data_entries` and leave out
     * `checkReadAccess` to become a backdoor to someone else's private
     * datasets.
     */
    expect(
      /FROM\s+data_entries|FROM\s+data_sets/i.test(routes),
      "this kon queries the dataset tables on its own: it has to go " +
        "through `readDatasetCatalog`, which is what checks access."
    ).toBe(false);
  });

  it("the image comes from what the dataset declares, not from guessing the name", () => {
    // The field's type, resolved with the shared type table.
    expect(reader).toContain("resolveFieldType");
    expect(reader, "`image` is preferred and `url` is accepted").toContain(
      'fieldOfType("image") ?? fieldOfType("url")'
    );

    /**
     * And it is NOT looked up by column name. That is the heuristic that produced
     * "Agregar All Gam": it is right sometimes, which is worse than always failing.
     */
    expect(
      /f\.name === "(image|image|photo|photo|avatar)"/.test(reader),
      "the image field cannot be deduced from the column name."
    ).toBe(false);
  });

  it("a uuid does not end up in a `src`", () => {
    /**
     * A field of type `image` stores a media ID, not a URL. Putting that
     * uuid in a `src` gives a broken image — which reads as "this entry has
     * no photo" and not as "the id has to be resolved".
     */
    expect(reader).toContain(String.raw`/^(https?:|\/)/`);
  });

  it("`/sync` knows where to get the catalog from when it is not given one", () => {
    const sync = routes.slice(routes.indexOf('route: "/templates/:slug/sync"'));
    const body = sync.slice(0, sync.indexOf('route: "/templates/:slug/diff'));

    expect(body.length, "route `/sync` not found").toBeGreaterThan(0);

    // The three origins, in order.
    expect(body).toContain("body.datasetId ?? row.catalogDatasetId");
    expect(body).toContain("catalogFromDataset");

    /**
     * And with none of the three, it says so — before it returned a generic 400 that
     * did not explain what to send.
     */
    expect(body).toContain("There is nowhere to get the catalog from");
  });

  it("syncing against a dataset pins it", () => {
    /**
     * If it were not saved, every resync would force choosing
     * the dataset again — and the "Sincronizar" button could not exist.
     */
    const sync = routes.slice(routes.indexOf('route: "/templates/:slug/sync"'));
    /**
     * It is cut where the next route STARTS, not at a number of
     * characters. The previous version looked at the first 4000 and the line is
     * at 4292: the guard failed with nothing broken, which is the
     * fastest way to teach someone to ignore it.
     */
    const body = sync.slice(0, sync.indexOf('route: "/templates/:slug/diff'));
    expect(body.length, "end of `/sync` not found").toBeGreaterThan(0);
    expect(body).toContain("catalogDatasetId: datasetId");
  });
});

describe("the editor offers it", () => {
  const editor = editorSources();

  it("a catalog can be chosen on creation", () => {
    // The create form has its own catalog dropdown, filled from the datasets.
    expect(editor).toContain('aria-label="Catalog to take the items from"');
    expect(editor).toContain("bind:value={newDataset}");
    // Without `()`: anchoring the exact signature made the guard fail over a new
    // parameter, not over a real failure.
    expect(editor).toContain("function loadDatasets(");
  });

  it("when creating with a catalog, it is filled in at once", () => {
    /**
     * Creating an empty list while knowing where its items come from is leaving the
     * job half done — the same pattern as "New Game" leading to a list.
     */
    const at = editor.indexOf("async function create(");
    expect(at, "`create` not found").toBeGreaterThan(-1);
    expect(editor.slice(at, at + 3000)).toContain("datasetId: catalogDatasetId");
  });

  it("the sync button is not offered if there is no catalog", () => {
    /**
     * A button that can do nothing is worse than not having it: it is the lesson of
     * "Exportar" without rows.
     *
     * The EFFECT is checked —that it stays inert without a catalog— and not the
     * specific property: `hidden` hides it and `disabled` leaves it visible but dead, and
     * both satisfy the rule. Anchoring on one of the two turns an improvement into
     * a guard failure.
     */
    expect(
      /(hidden|disabled)=\{!pinned\}[^\n]*>\s*Fetch from catalog/.test(editor),
      "the sync control has to stay inert when the list does not " +
        "have a catalog to bring anything from."
    ).toBe(true);
    // And «pinned» is the catalog the LIST has, not whatever the dropdown shows.
    expect(editor).toContain("const pinned = $derived(list?.catalogDatasetId");
  });
});

describe("resyncing does not destroy the work done", () => {
  /**
   * This is the reason for everything above, so the real engine is run
   * instead of looking at the code.
   */
  const tiers = [
    { id: "s", label: "S", color: "#ff5252" },
    { id: "a", label: "A", color: "#ff9800" },
  ];

  const character = (id: string, label: string) => ({
    id,
    label,
    imageUrl: null,
    sourceRef: id,
  });

  const base = {
    id: "t1",
    kind: "template" as const,
    slug: "x",
    title: "X",
    tiers,
    items: [],
    placement: {},
  };

  it("the first sync brings everything unranked", () => {
    const catalog = [character("1", "Aria"), character("2", "Boro")];
    const list = syncWithCatalog(base as never, catalog as never);

    expect(list.items).toHaveLength(2);
    expect(tierView(list as never).unranked).toHaveLength(2);
  });

  it("what was placed stays placed, and what is new enters the pool", () => {
    const initial = syncWithCatalog(
      base as never,
      [character("1", "Aria"), character("2", "Boro")] as never
    );
    const withAria = { ...initial, placement: { "1": "s" } };

    // A new character enters the dataset.
    const after = syncWithCatalog(
      withAria as never,
      [character("1", "Aria"), character("2", "Boro"), character("3", "Elio")] as never
    );

    expect(after.placement["1"], "Aria no se mueve de su fila").toBe("s");
    expect(
      tierView(after as never).unranked.map((i) => i.label),
      "the new one appears unranked instead of being forgotten"
    ).toContain("Elio");
  });

  it("what leaves the catalog stops taking up space", () => {
    const initial = syncWithCatalog(
      base as never,
      [character("1", "Aria"), character("2", "Boro")] as never
    );
    const placed = { ...initial, placement: { "1": "s", "2": "a" } };

    // Boro disappears from the dataset.
    const after = syncWithCatalog(placed as never, [character("1", "Aria")] as never);

    expect(after.items).toHaveLength(1);
    expect(
      after.placement["2"],
      "a character that no longer exists cannot keep occupying a row"
    ).toBeUndefined();
    expect(after.placement["1"]).toBe("s");
  });

  it("a name change in the catalog propagates", () => {
    /**
     * The catalog rules on name and image —it may have been renamed— but not
     * on where it was placed: the tier list does not own the record, but it does own
     * its position.
     */
    const initial = syncWithCatalog(base as never, [character("1", "Aria")] as never);
    const placedOne = { ...initial, placement: { "1": "s" } };

    const after = syncWithCatalog(
      placedOne as never,
      [character("1", "Aria Renombrada")] as never
    );

    expect(after.items[0].label).toBe("Aria Renombrada");
    expect(after.placement["1"]).toBe("s");
  });
});
