/**
 * `@kitsuden/kon-cardsim/render` — the drawing contract
 * ============================================================================
 *
 * What any renderer needs to draw a cardsim table: the Svelte boards, a WebGL canvas, or a game
 * engine such as Estella. The renderer only DRAWS. Everything else stays here, in plain
 * TypeScript, so a renderer can be swapped without touching the game:
 *
 *   · the state and its secrets — the server's per-seat view (`viewFor`);
 *   · WHERE each card goes — `sceneFor(view, definition, seat, size)`: a flat list of rectangles
 *     in pixels, deterministic, so two renderers place the same card in the same spot;
 *   · WHICH card was clicked — `hitTest(scene, x, y)`. Engines like Estella only pick UI nodes,
 *     not world sprites; keeping picking here makes that irrelevant;
 *   · the picture of each card — `ImageResolver.resolveBlob(card)` (`./images`): bytes, which is
 *     what a texture is made from (Estella: `decodeImagePixels(blob)` → `Assets.createTexture`).
 *
 * A renderer implements `CardRenderer`; the game feeds it scenes and textures, and turns its
 * pointer events into actions through `hitTest`.
 */

import type { GameDefinition, RedactedCard, SessionView } from "./cardsim.engine.js";

// ── The scene ────────────────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneCard extends Rect {
  instanceId: number;
  /** `null` = the renderer draws a card back. */
  cardKey: string | null;
  seat: number | null;
  zone: string;
  /** Degrees, clockwise (tapped = 90). The rectangle is the UNrotated card. */
  rotation: number;
  /** Draw order: higher on top. */
  z: number;
  counters: Record<string, number>;
  /** True when the player who looks may act on it (their own, face up or face down). */
  mine: boolean;
}

export interface SceneZone extends Rect {
  seat: number | null;
  zone: string;
  name: string;
  /** Cards in it, the hidden ones included (a pile shows its count). */
  count: number;
  /** Drawn as a single stack with its count. */
  pile: boolean;
}

export interface Scene {
  width: number;
  height: number;
  card: { w: number; h: number };
  zones: SceneZone[];
  cards: SceneCard[];
}

export interface SceneOptions {
  width: number;
  /** Cards per row a zone holds before it overlaps them. Default 8. */
  perRow?: number;
  /** Gap in pixels. Default 8. */
  gap?: number;
}

const ROTATION_TAPPED = 90;

/**
 * Lays the table out for `seat` (`null` = a spectator, who sees seat 0 at the bottom).
 *
 * Rows, top to bottom: every other seat (its hand first, then its zones), the shared zones, then
 * this seat's zones and its hand. A zone that is a pile (ordered or hidden: deck, graveyard) is
 * one stack. Cards that do not fit overlap, never leave their zone.
 */
export function sceneFor(
  view: SessionView,
  definition: GameDefinition,
  seat: number | null,
  options: SceneOptions
): Scene {
  const gap = options.gap ?? 8;
  const perRow = Math.max(2, options.perRow ?? 8);
  const width = Math.max(200, options.width);
  const own = definition.zones.filter((z) => !z.shared && z.id !== definition.handZone);
  const shared = definition.zones.filter((z) => z.shared);
  const columns = Math.max(1, Math.min(own.length, 4));
  const zoneW = (width - gap * (columns + 1)) / columns;
  const cardW = Math.max(16, Math.min(90, (zoneW - gap * 2) / Math.min(perRow, 6)));
  const cardH = Math.round(cardW * 1.4);
  const zoneH = cardH + gap * 2 + 18;
  const handW = width - gap * 2;

  const isPile = (zoneId: string) => {
    const z = definition.zones.find((x) => x.id === zoneId);
    return z?.ordered === true || z?.visibility === "none";
  };

  const zones: SceneZone[] = [];
  const cards: SceneCard[] = [];
  let y = gap;
  let z = 0;

  const placeCards = (list: RedactedCard[], hidden: number, area: Rect, owner: number | null, zone: string) => {
    const total = list.length + hidden;
    if (total === 0) return;
    const pile = isPile(zone);
    const slots = pile ? 1 : total;
    const inner = area.w - gap * 2;
    const step = slots <= 1 ? 0 : Math.min(cardW + gap / 2, (inner - cardW) / (slots - 1));
    const top = area.y + 18 + gap;
    const entries: Array<RedactedCard | null> = pile
      ? [list.at(-1) ?? null]
      : [...list, ...Array.from({ length: hidden }, () => null)];
    entries.forEach((card, i) => {
      cards.push({
        instanceId: card?.instanceId ?? -(cards.length + 1),
        cardKey: card?.cardId ?? null,
        seat: owner,
        zone,
        x: area.x + gap + i * step,
        y: top,
        w: cardW,
        h: cardH,
        rotation: card?.tapped ? ROTATION_TAPPED : 0,
        z: z++,
        counters: card?.counters ?? {},
        mine: card !== null && owner !== null && owner === seat,
      });
    });
  };

  const handRow = (s: number) => {
    const player = view.players[s];
    const area = { x: gap, y, w: handW, h: zoneH };
    const list = player?.zones?.[definition.handZone] ?? [];
    const hidden = player?.hiddenCounts?.[definition.handZone] ?? 0;
    zones.push({ ...area, seat: s, zone: definition.handZone, name: definition.zones.find((x) => x.id === definition.handZone)?.name ?? definition.handZone, count: list.length + hidden, pile: false });
    placeCards(list, hidden, area, s, definition.handZone);
    y += zoneH + gap;
  };

  const zoneRows = (s: number | null, defs: typeof own) => {
    defs.forEach((zd, i) => {
      const col = i % columns;
      if (i > 0 && col === 0) y += zoneH + gap;
      const area = { x: gap + col * (zoneW + gap), y, w: zoneW, h: zoneH };
      const list = s === null ? (view.board?.[zd.id] ?? []) : (view.players[s]?.zones?.[zd.id] ?? []);
      const hidden = s === null ? 0 : (view.players[s]?.hiddenCounts?.[zd.id] ?? 0);
      zones.push({ ...area, seat: s, zone: zd.id, name: zd.name, count: list.length + hidden, pile: isPile(zd.id) });
      placeCards(list, hidden, area, s, zd.id);
    });
    if (defs.length) y += zoneH + gap;
  };

  const bottom = seat ?? 0;
  const others = view.players.map((_, i) => i).filter((i) => i !== bottom);
  for (const s of others) {
    handRow(s);
    zoneRows(s, own);
  }
  zoneRows(null, shared);
  zoneRows(bottom, own);
  handRow(bottom);

  return { width, height: y, card: { w: cardW, h: cardH }, zones, cards };
}

/**
 * The card under a point, topmost first; `null` if none. Rotated (tapped) cards are hit by their
 * rotated footprint, as they are drawn.
 */
export function hitTest(scene: Scene, x: number, y: number): SceneCard | null {
  for (let i = scene.cards.length - 1; i >= 0; i--) {
    const c = scene.cards[i];
    const rotated = c.rotation % 180 !== 0;
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    const hw = (rotated ? c.h : c.w) / 2;
    const hh = (rotated ? c.w : c.h) / 2;
    if (x >= cx - hw && x <= cx + hw && y >= cy - hh && y <= cy + hh) return c;
  }
  return null;
}

/** The zone under a point (where a dragged card is dropped). */
export function zoneAt(scene: Scene, x: number, y: number): SceneZone | null {
  return scene.zones.find((z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) ?? null;
}

// ── What a renderer implements ───────────────────────────────────────────────

export interface CardRenderer {
  /** Takes the element it draws in (a canvas, a div). */
  mount(target: HTMLElement): void | Promise<void>;
  /** Draws this scene. Called on every change; the renderer diffs if it wants to. */
  setScene(scene: Scene): void;
  /**
   * The picture for a card key. `bytes` come from `resolver.resolveBlob(card)`; `null` means
   * "draw the card's name" (or a back). Called once per key, again only when it changes.
   */
  setTexture(cardKey: string, bytes: Blob | null): void | Promise<void>;
  /** Pointer events in SCENE pixels; the game runs `hitTest` / `zoneAt` on them. */
  onPointer(listener: (event: { type: "down" | "move" | "up"; x: number; y: number }) => void): () => void;
  dispose(): void;
}
