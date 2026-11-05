/**
 * Wiki and map engines
 * ============================================================================
 *
 * Wiki: what is pinned down is that the HISTORY is immutable —reverting is a redo,
 * not a deletion— and that links produce the backlinks that make a wiki
 * a wiki.
 *
 * Maps: that out-of-range coordinates are REJECTED instead of being clamped,
 * because clamping them would hide an entire shifted import.
 */

import { describe, expect, test } from "vitest";

import {
  diffLines,
  diffStats,
  extractLinks,
  isMeaningfulEdit,
  prepareRevert,
  renderLinks,
  slugify,
} from "../../kons/kon-wiki/wiki.engine";
import {
  clusterMarkers,
  fromPixels,
  toPixels,
  validateMapDefinition,
  validateMarker,
  visibleMarkers,
  type MapDefinition,
  type Marker,
} from "../../kons/kon-maps/maps.engine";

// ── Wiki: slugs ──────────────────────────────────────────────────────────────

describe("slugs: the page's identity", () => {
  test("normalizes accents, apostrophes and spaces", () => {
    // The apostrophe is DELETED instead of split on: game titles are
    // full of them and `baldur-s-gate` would be an ugly slug that also breaks
    // prefix search.
    expect(slugify("Baldur's Gate 3")).toBe("baldurs-gate-3");
    expect(slugify("Assassin’s Creed")).toBe("assassins-creed"); // typographic apostrophe
    expect(slugify("Categoría: Armas")).toBe("categoria-armas");
    expect(slugify("Espada  Larga")).toBe("espada-larga");
  });

  test("two titles that normalize the same ARE the same page", () => {
    // It is what prevents "Espada Larga" and "espada larga" from being duplicated.
    expect(slugify("Espada Larga")).toBe(slugify("ESPADA   larga"));
  });

  test("leaves no dangling hyphens at the ends", () => {
    expect(slugify("  ¡Hola!  ")).toBe("hola");
  });
});

// ── Wiki: links ──────────────────────────────────────────────────────────────

describe("[[wiki]] links", () => {
  test("extracts target and slug", () => {
    const links = extractLinks("Usa la [[Espada Larga]] contra el [[Dragón]].");
    expect(links.map((l) => l.slug)).toEqual(["espada-larga", "dragon"]);
  });

  test("supports a label with a pipe", () => {
    const [link] = extractLinks("Coge [[Espada Larga|la espada]] del cofre.");
    expect(link.slug).toBe("espada-larga");
    expect(link.label).toBe("la espada");
  });

  test("a page mentioned twice gives ONE backlink", () => {
    // The backlink is per page, not per mention: otherwise the index would count
    // repetitions instead of relations.
    expect(extractLinks("[[Dragón]] y otra vez [[Dragón]]")).toHaveLength(1);
  });

  test("a link to a nonexistent page is VALID", () => {
    // It is the wiki mechanic of creating by writing the link first.
    expect(extractLinks("[[Página Que No Existe]]")).toHaveLength(1);
  });

  test("an empty link is ignored", () => {
    expect(extractLinks("[[]] y [[   ]]")).toHaveLength(0);
  });

  test("rendering is decided by the caller", () => {
    const html = renderLinks("Ve a [[Casa|casa]]", (l) => `<a href="/w/${l.slug}">${l.label}</a>`);
    expect(html).toBe('Ve a <a href="/w/casa">casa</a>');
  });
});

// ── Wiki: diff and history ───────────────────────────────────────────────────

describe("line diff", () => {
  test("detects what was added and deleted while keeping what is common", () => {
    const ops = diffLines("uno\ndos\ntres", "uno\ndos-bis\ntres\ncuatro");
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
    expect(ops.filter((o) => o.op === "keep").map((o) => o.line)).toEqual(["uno", "tres"]);
  });

  test("two equal texts give no diff", () => {
    expect(diffStats(diffLines("a\nb", "a\nb"))).toEqual({ added: 0, removed: 0 });
  });

  test("from empty to content is all additions", () => {
    expect(diffStats(diffLines("", "a\nb")).added).toBeGreaterThan(0);
  });
});

describe("reverting is a REDO, not a deletion", () => {
  const target = {
    number: 3,
    content: "contenido viejo",
    summary: "una edición",
    authorId: "u1",
    createdAt: new Date(),
  };

  test("creates a NEW revision with the old content", () => {
    // If reverting deleted, a vandal with permissions could make
    // their traces disappear and the history would prove nothing anymore.
    const plan = prepareRevert(target, 7);
    expect(plan.number).toBe(8);
    expect(plan.content).toBe("contenido viejo");
    expect(plan.summary).toMatch(/revision 3/);
  });

  test("reverting to the current revision is rejected", () => {
    expect(() => prepareRevert(target, 3)).toThrow(/already the current revision/);
  });

  test("an edit without changes does not deserve a revision", () => {
    // Saving identical revisions clutters the history with noise.
    expect(isMeaningfulEdit("igual", "igual")).toBe(false);
    expect(isMeaningfulEdit("before", "después")).toBe(true);
  });
});

// ── Maps ─────────────────────────────────────────────────────────────────────

const MAP: MapDefinition = {
  id: "m1",
  name: "Acto 1",
  imageUrl: "https://example.com/map.png",
  aspectRatio: 1.5,
  layers: [
    { id: "surface", name: "Superficie" },
    { id: "underdark", name: "Subsuelo" },
  ],
};

const CATEGORIES = [
  { id: "chest", name: "Cofres", icon: null, color: "#fc0" },
  { id: "boss", name: "Jefes", icon: null, color: "#f00" },
];

describe("map definition", () => {
  test("a healthy definition passes", () => {
    expect(validateMapDefinition(MAP)).toHaveLength(0);
  });

  test("without layers there is no map", () => {
    expect(validateMapDefinition({ ...MAP, layers: [] }).length).toBeGreaterThan(0);
  });

  test("duplicate layers are rejected", () => {
    const errors = validateMapDefinition({
      ...MAP,
      layers: [
        { id: "a", name: "A" },
        { id: "a", name: "B" },
      ],
    });
    expect(errors.some((e) => e.includes("Duplicate layer"))).toBe(true);
  });
});

describe("markers: out of range is REJECTED, not clamped", () => {
  const marker = (over: Partial<Omit<Marker, "id">> = {}) => ({
    layerId: "surface",
    categoryId: "chest",
    x: 0.5,
    y: 0.5,
    title: "Cofre",
    body: null,
    ...over,
  });

  test("a valid marker passes", () => {
    expect(validateMarker(MAP, CATEGORIES, marker())).toHaveLength(0);
  });

  test("coordinates outside [0..1] are rejected with the values in the message", () => {
    // Clamping would "fix" it by pinning it to the edge, and nobody would notice that the whole
    // import came in on another scale.
    const errors = validateMarker(MAP, CATEGORIES, marker({ x: 1.4 }));
    expect(errors.some((e) => e.includes("1.4") && e.includes("[0..1]"))).toBe(true);
  });

  test("the exact edges ARE valid", () => {
    expect(validateMarker(MAP, CATEGORIES, marker({ x: 0, y: 1 }))).toHaveLength(0);
  });

  test("a nonexistent layer or category is rejected", () => {
    expect(validateMarker(MAP, CATEGORIES, marker({ layerId: "cielo" })).length).toBeGreaterThan(0);
    expect(
      validateMarker(MAP, CATEGORIES, marker({ categoryId: "inventada" })).length
    ).toBeGreaterThan(0);
  });

  test("a marker without a title is rejected", () => {
    expect(validateMarker(MAP, CATEGORIES, marker({ title: "   " })).length).toBeGreaterThan(0);
  });
});

describe("normalized coordinates", () => {
  test("round trip pixel ↔ normalized", () => {
    const pixels = toPixels({ x: 0.25, y: 0.5 }, 4000, 2000);
    expect(pixels).toEqual({ px: 1000, py: 1000 });
    expect(fromPixels(1000, 1000, 4000, 2000)).toEqual({ x: 0.25, y: 0.5 });
  });

  test("the SAME coordinate works for an HD image", () => {
    // It is the reason for normalizing: uploading a map twice as large moves
    // no marker.
    const sd = toPixels({ x: 0.5, y: 0.5 }, 1000, 1000);
    const hd = toPixels({ x: 0.5, y: 0.5 }, 4000, 4000);
    expect(sd.px / 1000).toBe(hd.px / 4000);
  });

  test("invalid dimensions are rejected", () => {
    expect(() => fromPixels(10, 10, 0, 100)).toThrow();
  });
});

describe("clustering", () => {
  const markers = (coords: Array<[number, number]>): Marker[] =>
    coords.map(([x, y], i) => ({
      id: `m${i}`,
      layerId: "surface",
      categoryId: "chest",
      x,
      y,
      title: `M${i}`,
      body: null,
    }));

  test("groups what is near and separates what is far", () => {
    const clusters = clusterMarkers(
      markers([
        [0.01, 0.01],
        [0.02, 0.02],
        [0.9, 0.9],
      ]),
      0.1
    );
    expect(clusters).toHaveLength(2);
    expect(clusters.find((c) => c.markers.length === 2)).toBeTruthy();
  });

  test("the cluster is painted at the CENTROID, not at the cell center", () => {
    // With two markers pressed against an edge, the cell center would put the
    // number visibly far from both.
    const [cluster] = clusterMarkers(
      markers([
        [0.01, 0.01],
        [0.03, 0.03],
      ]),
      0.1
    );
    expect(cluster.x).toBeCloseTo(0.02, 5);
  });

  test("is deterministic: it does not dance between renders", () => {
    const input = markers([
      [0.1, 0.1],
      [0.11, 0.11],
      [0.5, 0.5],
    ]);
    expect(JSON.stringify(clusterMarkers(input, 0.05))).toBe(
      JSON.stringify(clusterMarkers(input, 0.05))
    );
  });

  test("does not lose markers", () => {
    const input = markers(Array.from({ length: 100 }, (_, i) => [i / 100, i / 100]));
    const total = clusterMarkers(input, 0.1).reduce((s, c) => s + c.markers.length, 0);
    expect(total).toBe(100);
  });

  test("an invalid gridSize is rejected", () => {
    expect(() => clusterMarkers([], 0)).toThrow();
  });
});

describe("viewer filter", () => {
  test("filters by active layer and enabled categories", () => {
    const all: Marker[] = [
      { id: "1", layerId: "surface", categoryId: "chest", x: 0, y: 0, title: "A", body: null },
      { id: "2", layerId: "surface", categoryId: "boss", x: 0, y: 0, title: "B", body: null },
      { id: "3", layerId: "underdark", categoryId: "chest", x: 0, y: 0, title: "C", body: null },
    ];
    const visible = visibleMarkers(all, "surface", new Set(["chest"]));
    expect(visible.map((m) => m.id)).toEqual(["1"]);
  });
});
