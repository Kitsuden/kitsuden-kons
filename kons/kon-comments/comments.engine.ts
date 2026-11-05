/**
 * Comments — comments engine
 * ============================================================================
 *
 * Game wikis live off this: half the value of a boss page is
 * the people below telling how they killed it. It is also what makes
 * someone come back to a page they already read.
 *
 * ── POLYMORPHIC ON PURPOSE ─────────────────────────────────────────────────
 *
 * A comment hangs from `(subjectType, subjectId)`, not from a specific table.
 * That way the same kon serves a wiki entry, a catalog item, a
 * shared build and a guide, without a comments table for each thing.
 *
 * The price is that there is no foreign key: if the item is deleted, its comments
 * are orphaned. This is accepted because the alternative — five comment tables
 * with the same thread, vote and moderation logic repeated five times — is
 * worse, and because an orphaned comment breaks nothing: it does not show up, because nobody
 * asks for the comments of something that no longer exists.
 *
 * ── DEPTH IS LIMITED, AND IT IS NOT A WHIM ─────────────────────────────────
 *
 * An unlimited thread turns into a staircase of one reply per level that
 * on mobile leaves two words per line. Three levels is what Reddit and HN use
 * in their compact view, and above that the conversation is no longer read: it is
 * dived into.
 */

/** Maximum nesting depth. Level 0 = root comment. */
export const MAX_DEPTH = 3;

export const STATUSES = ["published", "pending", "hidden"] as const;
export type CommentStatus = (typeof STATUSES)[number];

export interface BaseComment {
  id: string;
  parentId: string | null;
  depth: number;
  body: string;
  status: CommentStatus;
  score: number;
  authorId: string | null;
  authorName: string | null;
  createdAt: Date | string;
}

export class CommentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommentsError";
  }
}

/**
 * The depth of a reply, or an error if it exceeds the limit.
 *
 * It is calculated on WRITE and stored, instead of deducing it on read by climbing
 * the parents. Climbing the chain on every read is N queries per comment, and
 * a thread of two hundred comments becomes two hundred queries to draw
 * a page that is requested a thousand times a day.
 */
export function depthOf(parent: { depth: number } | null): number {
  if (!parent) return 0;
  const d = parent.depth + 1;
  if (d > MAX_DEPTH) {
    throw new CommentsError(
      `Cannot nest more than ${MAX_DEPTH} levels. Reply to the comment ` +
        `above: a deeper thread leaves two words per line on mobile.`
    );
  }
  return d;
}

export interface TreeNode<T extends BaseComment> {
  comment: T;
  answers: TreeNode<T>[];
}

/**
 * Builds the comment tree from the flat list.
 *
 * ── ORPHANS ARE PROMOTED, NOT LOST ─────────────────────────────────────────
 *
 * If a comment points at a parent that is not in the batch — because it was deleted, or
 * because it fell outside the page — it is **not discarded**: it rises to the root.
 *
 * Discarding it is the convenient option and makes whole conversations disappear: a
 * deleted parent takes its twenty replies with it, which do exist
 * and do have content. Being read in the wrong place is a smaller problem
 * than not being read.
 */
export function buildTree<T extends BaseComment>(comments: T[]): TreeNode<T>[] {
  const nodes = new Map<string, TreeNode<T>>();
  for (const c of comments) nodes.set(c.id, { comment: c, answers: [] });

  const roots: TreeNode<T>[] = [];
  for (const c of comments) {
    const node = nodes.get(c.id)!;
    const parent = c.parentId ? nodes.get(c.parentId) : undefined;
    if (parent) parent.answers.push(node);
    else roots.push(node);
  }
  return roots;
}

export type Order = "newest" | "oldest" | "best";

/**
 * Sorts one level of the tree.
 *
 * The tie-break is ALWAYS the date, even when sorting by votes. Without it, two
 * comments with the same score swap places between reloads — the database's
 * order is not guaranteed — and the reader sees the list dance.
 */
export function sort<T extends BaseComment>(nodes: TreeNode<T>[], order: Order): TreeNode<T>[] {
  const date = (n: TreeNode<T>) => new Date(n.comment.createdAt).getTime();

  const sortedItems = [...nodes].sort((a, b) => {
    if (order === "best" && a.comment.score !== b.comment.score) {
      return b.comment.score - a.comment.score;
    }
    return order === "oldest" ? date(a) - date(b) : date(b) - date(a);
  });

  for (const n of sortedItems) n.answers = sort(n.answers, order);
  return sortedItems;
}

/**
 * Counts a whole tree, replies included.
 *
 * `comments.length` counts what was loaded; this counts what is seen. With
 * pagination they are not the same, and the number next to the title has to
 * be the second.
 */
export function count<T extends BaseComment>(nodes: TreeNode<T>[]): number {
  return nodes.reduce((n, x) => n + 1 + count(x.answers), 0);
}

/**
 * Hides the body of moderated comments without removing them from the tree.
 *
 * Deleting the row orphans its replies; removing it from the tree on read does
 * the same. The text is replaced and the node is kept, which is what preserves
 * the conversation that hung from it.
 */
export function censor<T extends BaseComment>(
  nodes: TreeNode<T>[],
  canViewHidden: boolean
): TreeNode<T>[] {
  return nodes.map((n) => ({
    comment:
      n.comment.status === "published" || canViewHidden
        ? n.comment
        : { ...n.comment, body: "[comment removed by moderation]", authorName: null },
    answers: censor(n.answers, canViewHidden),
  }));
}

/**
 * Flags banned words for review, without blocking publication.
 *
 * Returns the state the comment must enter with. A filter that REJECTS
 * turns into a game of typing with asterisks; one that sends to a queue leaves
 * the work done for a human and does not tell the spammer whether it got through.
 */
export function initialStatus(body: string, banned: string[]): CommentStatus {
  if (banned.length === 0) return "published";
  const text = body.toLowerCase();
  return banned.some((p) => p && text.includes(p.toLowerCase())) ? "pending" : "published";
}
