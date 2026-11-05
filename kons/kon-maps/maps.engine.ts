/**
 * Interactive map engine — coordinates, markers and layers
 * ============================================================================
 *
 * A game's interactive map (the ones on game wikis and map sites) is an
 * IMAGE with its own coordinate space and thousands of points on top. It is not
 * cartography: there are no projections, no latitudes — there are pixels of the
 * game's map and marker categories that are switched on and off.
 *
 * That is why Leaflet is NOT imported in the engine: Leaflet belongs to the
 * CLIENT (and the viewer can use it if it wants); the engine is the data model
 * and its rules, which is what makes the thousand tools built on top of it
 * robust.
 *
 * NORMALIZED coordinates [0..1]: a marker at (0.5, 0.5) is the center of the
 * map whatever the image resolution. If the deployment later uploads an HD
 * version of the map, no marker moves — saving pixels would have tied the data
 * to a specific file.
 */

export interface MapDefinition {
  id: string;
  name: string;
  /** Base image of the map. Served by kon-media or a URL. */
  imageUrl: string;
  /** Width/height ratio of the image, so the viewer reserves the space. */
  aspectRatio: number;
  /** Layers: "Act 1", "Underground". A map without layers has an implicit one. */
  layers: Array<{ id: string; name: string }>;
}

export interface MarkerCategory {
  id: string;
  name: string;
  /** Icon or color with which the viewer paints the category. */
  icon: string | null;
  color: string;
}

export interface Marker {
  id: string;
  /** Layer it belongs to. */
  layerId: string;
  categoryId: string;
  /** Normalized [0..1] over the image. */
  x: number;
  y: number;
  title: string;
  /** Popup body. Supports wiki [[links]] if the deployment renders them. */
  body: string | null;
}

export class MapError extends Error {}

export function validateMapDefinition(def: MapDefinition): string[] {
  const errors: string[] = [];
  // It arrives from a JSON: without this, a `layers` that is not a list blew up in the
  // `for…of` with a 500 instead of saying what is missing.
  if (!def || typeof def !== "object") return ["The map definition must be an object"];
  if (!Array.isArray(def.layers)) return ["`layers` must be a list"];
  if (!def.imageUrl) errors.push("The map needs an image");
  if (!(def.aspectRatio > 0)) errors.push("aspectRatio must be positive");
  const ids = new Set<string>();
  for (const layer of def.layers) {
    if (ids.has(layer.id)) errors.push(`Duplicate layer: "${layer.id}"`);
    ids.add(layer.id);
  }
  if (def.layers.length === 0) errors.push("The map needs at least one layer");
  return errors;
}

/**
 * Validates a marker against its map.
 *
 * Coordinates outside [0..1] are REJECTED, not clamped: a marker at
 * (1.4, 0.2) is broken data —imported with another scale, almost always— and
 * clamping it would "fix" it by pinning it to the edge, where nobody would
 * notice that the whole import came shifted.
 */
export function validateMarker(
  def: MapDefinition,
  categories: MarkerCategory[],
  marker: Omit<Marker, "id">
): string[] {
  const errors: string[] = [];
  if (!def.layers.some((l) => l.id === marker.layerId)) {
    errors.push(`Layer "${marker.layerId}" does not exist in this map`);
  }
  if (!categories.some((c) => c.id === marker.categoryId)) {
    errors.push(`The category "${marker.categoryId}" does not exist`);
  }
  if (!(marker.x >= 0 && marker.x <= 1) || !(marker.y >= 0 && marker.y <= 1)) {
    errors.push(`Coordinates (${marker.x}, ${marker.y}) out of [0..1]`);
  }
  if (!marker.title.trim()) errors.push("The marker needs a title");
  return errors;
}

/** Image ↔ normalized conversion. The viewer uses them on every click and render. */
export function toPixels(
  marker: Pick<Marker, "x" | "y">,
  imageWidth: number,
  imageHeight: number
): { px: number; py: number } {
  return { px: marker.x * imageWidth, py: marker.y * imageHeight };
}

export function fromPixels(
  px: number,
  py: number,
  imageWidth: number,
  imageHeight: number
): { x: number; y: number } {
  if (imageWidth <= 0 || imageHeight <= 0) throw new MapError("Invalid dimensions");
  return { x: px / imageWidth, y: py / imageHeight };
}

/**
 * Grid clustering for the viewer.
 *
 * With 3,000 markers, painting them all at low zoom is an illegible smear that
 * also drags the mouse. They are grouped by cell and the viewer paints "×27".
 * The cell depends on zoom: when zooming in, the groups break up by themselves.
 *
 * Grid and not k-means: it is deterministic, it is O(n) and the result does not
 * "dance" between renders — a cluster that moves on repaint looks like a bug.
 */
export interface Cluster {
  x: number;
  y: number;
  markers: Marker[];
}

export function clusterMarkers(markers: Marker[], gridSize: number): Cluster[] {
  if (gridSize <= 0) throw new MapError("gridSize must be positive");
  const cells = new Map<string, Marker[]>();

  for (const marker of markers) {
    const key = `${Math.floor(marker.x / gridSize)}:${Math.floor(marker.y / gridSize)}`;
    // `push` on the same list. Before it was `[...list, marker]`: copying the
    // whole cell for every marker is QUADRATIC, and with `?cluster=1` (a
    // single cell) an anonymous GET on a map of 50,000 markers copied
    // ~10^9 elements.
    const cellValue = cells.get(key);
    if (cellValue) cellValue.push(marker);
    else cells.set(key, [marker]);
  }

  return [...cells.values()].map((cell) => ({
    // The cluster is painted at the CENTROID of its markers, not at the center
    // of the cell: with two markers stuck to an edge, the cell center
    // would put the number visibly far from both.
    x: cell.reduce((s, m) => s + m.x, 0) / cell.length,
    y: cell.reduce((s, m) => s + m.y, 0) / cell.length,
    markers: cell,
  }));
}

/** Standard viewer filter: active layer + categories switched on. */
export function visibleMarkers(
  markers: Marker[],
  layerId: string,
  enabledCategories: Set<string>
): Marker[] {
  return markers.filter((m) => m.layerId === layerId && enabledCategories.has(m.categoryId));
}
