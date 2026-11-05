/**
 * CardSim — importing and exporting deck lists
 * ============================================================================
 *
 * Nobody builds their deck twice. A simulator you cannot PASTE your
 * list from elsewhere into is a simulator you will not use, so this is not an
 * extra: it is the front door.
 *
 * Two formats, because they are the two people have on their clipboard:
 *
 *   · **Text** — `3 BP01-001` or `3x BP01-001`, with `# section` to separate
 *     main from souls/extra/side. It is what comes out of any builder.
 *   · **YDK** — the classic Yu-Gi-Oh file (`#main`, `#extra`,
 *     `!side`, one id per line). Duelingbook and YGOPro speak it.
 *
 * Both parsers are TOLERANT on purpose (empty lines, comments,
 * uppercase, `x` attached to the number) and neither invents: what they do not understand
 * they return as an error with its line number, instead of silently
 * discarding it and leaving you with a 47-card deck without knowing why.
 */

import type { DeckSection } from "./cardsim.types.js";

export interface ParsedDeck {
  cards: Record<string, string[]>;
  /** Lines that were not understood, with their number. Never silently discarded. */
  errors: string[];
}

/** `3 BP01-001`, `3x BP01-001`, `BP01-001` o `1 Dark Magician`. */
const LINE = /^\s*(?:(\d+)\s*[xX]?\s+)?(.+?)\s*$/;
/** `# Souls`, `## Extra Deck`, `[Side]`. */
const HEADER = /^\s*(?:#{1,3}|\[)\s*([^\]]+?)\s*\]?\s*$/;

function matchSection(label: string, sections: DeckSection[]): DeckSection | null {
  const norm = label.trim().toLowerCase();
  return (
    sections.find((s) => s.id.toLowerCase() === norm) ??
    sections.find((s) => s.name.toLowerCase() === norm) ??
    // "Main Deck" must fall in the "main" section: people write the long
    // name and not the id.
    sections.find((s) => norm.startsWith(s.id.toLowerCase())) ??
    null
  );
}

/**
 * Text → deck by sections. Without headers, everything goes to the main section,
 * which is what whoever pastes a 50-line list expects, and that's it.
 */
export function parseDeckList(text: string, sections: DeckSection[]): ParsedDeck {
  const main = sections[0];
  const cards: Record<string, string[]> = Object.fromEntries(sections.map((s) => [s.id, []]));
  const errors: string[] = [];
  let current = main;

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    // A YDK header comment ("#created by …") is not a section.
    if (line.startsWith("#") || line.startsWith("[")) {
      const header = HEADER.exec(line);
      const section = header ? matchSection(header[1], sections) : null;
      if (section) current = section;
      return;
    }
    if (line.startsWith("//")) return;

    const parsed = LINE.exec(line);
    if (!parsed || !parsed[2]) {
      errors.push(`Line ${i + 1}: not understood "${line}"`);
      return;
    }
    const count = parsed[1] ? Number.parseInt(parsed[1], 10) : 1;
    if (!Number.isFinite(count) || count < 1 || count > 99) {
      errors.push(`Line ${i + 1}: invalid quantity (${parsed[1]})`);
      return;
    }
    for (let n = 0; n < count; n++) cards[current.id].push(parsed[2]);
  });

  return { cards, errors };
}

/** Deck → text, grouping copies. It is what gets copied to the clipboard. */
export function formatDeckList(cards: Record<string, string[]>, sections: DeckSection[]): string {
  const blocks: string[] = [];
  for (const section of sections) {
    const list = cards[section.id] ?? [];
    if (!list.length) continue;
    const counts = new Map<string, number>();
    for (const id of list) counts.set(id, (counts.get(id) ?? 0) + 1);
    blocks.push(`# ${section.name}`, ...[...counts.entries()].map(([id, n]) => `${n} ${id}`), "");
  }
  return blocks.join("\n").trimEnd() + "\n";
}

/**
 * YDK → `{main, extra, side}`. YDK ids are numeric (Konami's
 * passcode), so the game must have its cards indexed by that same id
 * for the import to match.
 */
export function parseYdk(text: string): ParsedDeck {
  const cards: Record<string, string[]> = { main: [], extra: [], side: [] };
  const errors: string[] = [];
  let current: keyof typeof cards | null = null;

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const lower = line.toLowerCase();
    if (lower === "#main") return void (current = "main");
    if (lower === "#extra") return void (current = "extra");
    if (lower === "!side") return void (current = "side");
    // "#created by …" and other headers: ignored without complaint.
    if (line.startsWith("#") || line.startsWith("!")) return;

    if (!current) {
      errors.push(`Line ${i + 1}: card before any section (#main/#extra/!side)`);
      return;
    }
    if (!/^\d+$/.test(line)) {
      errors.push(`Line ${i + 1}: "${line}" is not a YDK id (they must be numbers)`);
      return;
    }
    cards[current].push(line);
  });

  return { cards, errors };
}

export function formatYdk(cards: Record<string, string[]>): string {
  return [
    "#created by kitsuden cardsim",
    "#main",
    ...(cards.main ?? []),
    "#extra",
    ...(cards.extra ?? []),
    "!side",
    ...(cards.side ?? []),
    "",
  ].join("\n");
}
