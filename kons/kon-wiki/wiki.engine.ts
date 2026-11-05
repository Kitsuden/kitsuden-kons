/**
 * Wiki engine — links, slugs, diffs and revert
 * ============================================================================
 *
 * What separates a wiki from a blog is not the content: it is the HISTORY. A
 * wiki without "who changed what and how do I revert it" is a blog by another name —
 * and as soon as more than one person edits, the history is the safety net
 * that makes opening editing possible.
 *
 * Three pure pieces:
 *   · `[[Like this]]` links → slug + backlinks (the emergent navigation that makes
 *     a wiki a wiki).
 *   · Line diff (own LCS: ~40 lines; a dependency for this is
 *     buying someone else's maintenance for a textbook algorithm).
 *   · Revert as REDO: reverting creates a new revision with the old
 *     content. The history only grows — it is never rewritten, because a
 *     rewritable history proves nothing.
 */

// ── Slugs and links ──────────────────────────────────────────────────────────
//
// They live in `@kitsuden/shared` (wiki-enlaces): the public frontend renders the
// `[[links]]` with the SAME rule they are indexed with here. They are re-exported
// under their usual names so as not to disturb whoever already imports them.

export {
  wikiPageSlug as slugify,
  extractWikiLinks as extractLinks,
  renderWikiLinks as renderLinks,
} from "@kitsuden/shared";
export type { WikiLink as WikiLink } from "@kitsuden/shared";

// ── Line diff ────────────────────────────────────────────────────────────────

export type DiffOp =
  | { op: "keep"; line: string }
  | { op: "add"; line: string }
  | { op: "del"; line: string };

/**
 * Line diff via classic LCS.
 *
 * By LINES and not by characters on purpose: a wiki's history is read
 * ("added the drops section, removed the old price"), and a character
 * diff is unreadable for that. Quadratic in lines — enough for
 * wiki pages; a 10k-line page has an editorial problem before
 * an algorithmic one.
 */
/**
 * Maximum cells of the LCS table (rows × columns of the differing stretch).
 *
 * The diff is quadratic and the route that serves it is PUBLIC: two revisions of
 * 250,000 lines (they fit in the 500 KB an edit allows) asked for a table
 * of 6·10^10 numbers — the whole process ran out of memory on an anonymous GET.
 * Above this cap the middle stretch comes out as "all deleted / all
 * added", which is still a correct diff, just less fine-grained.
 */
export const MAX_DIFF_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffOp[] {
  const allA = before.split("\n");
  const allB = after.split("\n");

  // What is common at the start and end needs no LCS: in a normal edit
  // it is almost the whole page, and trimming it leaves the table on the edited stretch.
  let ini = 0;
  while (ini < allA.length && ini < allB.length && allA[ini] === allB[ini]) ini++;
  let fin = 0;
  while (
    fin < allA.length - ini &&
    fin < allB.length - ini &&
    allA[allA.length - 1 - fin] === allB[allB.length - 1 - fin]
  ) {
    fin++;
  }

  const prefix: DiffOp[] = allA.slice(0, ini).map((line) => ({ op: "keep", line }));
  const suffix: DiffOp[] = allA.slice(allA.length - fin).map((line) => ({ op: "keep", line }));
  const a = allA.slice(ini, allA.length - fin);
  const b = allB.slice(ini, allB.length - fin);

  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) {
    return [
      ...prefix,
      ...a.map((line): DiffOp => ({ op: "del", line })),
      ...b.map((line): DiffOp => ({ op: "add", line })),
      ...suffix,
    ];
  }

  return [...prefix, ...diffLcs(a, b), ...suffix];
}

function diffLcs(a: string[], b: string[]): DiffOp[] {
  // LCS table.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: "keep", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ op: "del", line: a[i] });
      i++;
    } else {
      ops.push({ op: "add", line: b[j] });
      j++;
    }
  }
  while (i < a.length) ops.push({ op: "del", line: a[i++] });
  while (j < b.length) ops.push({ op: "add", line: b[j++] });

  return ops;
}

/** Diff summary: what the history shows next to each revision. */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  return {
    added: ops.filter((o) => o.op === "add").length,
    removed: ops.filter((o) => o.op === "del").length,
  };
}

// ── Revisions ────────────────────────────────────────────────────────────────

export interface Revision {
  /** 1-based, monotonic per page. */
  number: number;
  content: string;
  summary: string;
  authorId: string | null;
  createdAt: Date;
}

/**
 * Prepares the revision of a revert.
 *
 * Reverting does NOT delete revisions: it creates a NEW one with the content of the old one
 * and a summary saying where it comes from. The history only grows — if reverting
 * deleted, a vandal with permissions could make their traces disappear, and the
 * history would no longer prove anything.
 */
export function prepareRevert(
  target: Revision,
  currentNumber: number
): { content: string; summary: string; number: number } {
  if (target.number === currentNumber) {
    throw new Error("That is already the current revision");
  }
  return {
    content: target.content,
    summary: `Reverted to revision ${target.number}`,
    number: currentNumber + 1,
  };
}

/**
 * Is this edit worth saving?
 *
 * Saving an identical revision pollutes the history with noise that then
 * has to be read. Content is compared, not metadata: changing only the summary
 * is not an edit.
 */
export function isMeaningfulEdit(current: string, next: string): boolean {
  return current !== next;
}
