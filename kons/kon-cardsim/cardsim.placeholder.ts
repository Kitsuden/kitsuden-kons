/**
 * The card drawn by code, for when nobody brought its image
 * ============================================================================
 *
 * A board in `byod` mode with no sources must still be playable, so every card has a face: its
 * name, and its cost, type and color when the catalog has them. Often it only has the name (a
 * pasted list knows nothing else), and that has to look like a card too.
 *
 * It is an SVG string, not a canvas: deterministic (the same card always looks the same, which
 * matters when two players compare), testable without a browser, and usable as an `<img>` source
 * or rasterized into a texture by another renderer.
 *
 * The text is escaped: card names come from pasted lists and packs, and this string becomes markup.
 */

export interface PlaceholderCard {
  /** What the card is called. Required: it is the one thing every card has. */
  name: string;
  /** Stable key (id or name): picks the color when the card has none. */
  key?: string;
  cost?: unknown;
  type?: unknown;
  color?: unknown;
}

export const PLACEHOLDER_WIDTH = 250;
export const PLACEHOLDER_HEIGHT = 350;

/** Named colors that card games use, to their hue. */
const HUES: Record<string, number> = {
  red: 0,
  rojo: 0,
  vermelho: 0,
  orange: 28,
  naranja: 28,
  yellow: 48,
  amarillo: 48,
  amarelo: 48,
  green: 130,
  verde: 130,
  blue: 215,
  azul: 215,
  purple: 275,
  morado: 275,
  roxo: 275,
  violet: 275,
  black: -1,
  negro: -1,
  preto: -1,
  white: -2,
  blanco: -2,
  branco: -2,
};

/** FNV-1a: a stable hash for a stable color. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&#39;"
  );
}

/** A value from the catalog as short text, or null. */
function short(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const v = Array.isArray(value) ? value.join(" / ") : value;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Words into lines of at most `width` characters, at most `lines` lines. */
function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const piece = word.length > width ? `${word.slice(0, width - 1)}…` : word;
    if (!line) line = piece;
    else if (line.length + 1 + piece.length <= width) line += ` ${piece}`;
    else {
      out.push(line);
      line = piece;
    }
    if (out.length === lines) break;
  }
  if (line && out.length < lines) out.push(line);
  if (out.length === lines && text.length > out.join(" ").length) {
    const last = out[lines - 1];
    out[lines - 1] = last.length >= width ? `${last.slice(0, width - 1)}…` : `${last}…`;
  }
  return out;
}

/** Fill colors for a card: from its color if it has a known one, from its key otherwise. */
function palette(card: PlaceholderCard): { frame: string; inner: string; ink: string } {
  const named = short(card.color, 40)
    ?.toLowerCase()
    .split(/[\s/,]+/)
    .map((w) => HUES[w])
    .find((h) => h !== undefined);
  if (named === -1) return { frame: "#1f1f24", inner: "#2c2c33", ink: "#f4f4f5" };
  if (named === -2) return { frame: "#d6d3cc", inner: "#f2efe8", ink: "#1c1917" };
  const hue = named ?? hash(card.key ?? card.name) % 360;
  return {
    frame: `hsl(${hue} 45% 32%)`,
    inner: `hsl(${hue} 35% 18%)`,
    ink: "#f8fafc",
  };
}

/** The card as an SVG document. */
export function placeholderSvg(card: PlaceholderCard): string {
  const { frame, inner, ink } = palette(card);
  const name = short(card.name, 120) ?? "?";
  const cost = short(card.cost, 4);
  const type = short(card.type, 28);
  const lines = wrap(name, 16, 4);
  const W = PLACEHOLDER_WIDTH;
  const H = PLACEHOLDER_HEIGHT;
  const firstLine = H / 2 - ((lines.length - 1) * 26) / 2;

  const nameText = lines
    .map(
      (l, i) =>
        `<text x="${W / 2}" y="${firstLine + i * 26}" text-anchor="middle" font-size="21" font-weight="700">${escapeXml(l)}</text>`
    )
    .join("");
  const costBadge = cost
    ? `<circle cx="34" cy="34" r="20" fill="${frame}" stroke="${ink}" stroke-opacity=".5"/>` +
      `<text x="34" y="41" text-anchor="middle" font-size="20" font-weight="800">${escapeXml(cost)}</text>`
    : "";
  const typeLine = type
    ? `<text x="${W / 2}" y="${H - 28}" text-anchor="middle" font-size="14" opacity=".8">${escapeXml(type)}</text>`
    : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(name)}">` +
    `<rect width="${W}" height="${H}" rx="14" fill="${frame}"/>` +
    `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="9" fill="${inner}"/>` +
    `<g fill="${ink}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">` +
    costBadge +
    nameText +
    typeLine +
    `</g></svg>`
  );
}

/** The same card as a Blob, ready for `URL.createObjectURL`. */
export function placeholderBlob(card: PlaceholderCard): Blob {
  return new Blob([placeholderSvg(card)], { type: "image/svg+xml" });
}
