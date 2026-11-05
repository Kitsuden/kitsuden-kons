/**
 * Comments engine
 * ============================================================================
 *
 * kon-comments did not have a single test, and its engine is exactly the kind of code
 * that needs them: four pure functions, each with a design decision
 * behind it that is lost as soon as someone "simplifies" it.
 *
 * The three that break most easily by accident:
 *
 *   - orphans are PROMOTED to root, not discarded. Discarding them is the
 *     convenient version and makes whole conversations disappear.
 *   - censoring replaces the body but KEEPS the node, because removing it from the
 *     tree orphans its replies.
 *   - the tiebreaker when sorting is always the date, even by votes: without it the
 *     list dances between reloads.
 */

import { describe, expect, it } from "vitest";

import {
  CommentsError,
  MAX_DEPTH,
  censor,
  count,
  initialStatus,
  buildTree,
  sort,
  depthOf,
  type BaseComment,
} from "../../kons/kon-comments/comments.engine";

function comment(partial: Partial<BaseComment> & { id: string }): BaseComment {
  return {
    parentId: null,
    depth: 0,
    body: "text",
    status: "published",
    score: 0,
    authorId: "u1",
    authorName: "Alguien",
    createdAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("profundidadDe", () => {
  it("a comment with no parent is at the root", () => {
    expect(depthOf(null)).toBe(0);
  });

  it("a reply goes down one level", () => {
    expect(depthOf({ depth: 0 })).toBe(1);
    expect(depthOf({ depth: 1 })).toBe(2);
  });

  it("cuts at the limit instead of letting the staircase grow", () => {
    expect(depthOf({ depth: MAX_DEPTH - 1 })).toBe(MAX_DEPTH);
    expect(() => depthOf({ depth: MAX_DEPTH })).toThrow(CommentsError);
  });
});

describe("montarArbol", () => {
  it("hangs each reply from its parent", () => {
    const tree = buildTree([
      comment({ id: "a" }),
      comment({ id: "b", parentId: "a", depth: 1 }),
      comment({ id: "c", parentId: "b", depth: 2 }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].answers[0].comment.id).toBe("b");
    expect(tree[0].answers[0].answers[0].comment.id).toBe("c");
  });

  it("PROMOTES to root the comment whose parent is not in the batch", () => {
    // This is the decision that gets lost when "cleaning up" the function. If the
    // orphan is discarded, a deleted parent takes its replies down with it,
    // which do exist and do have content.
    const tree = buildTree([comment({ id: "huerfano", parentId: "deleted", depth: 1 })]);

    expect(tree).toHaveLength(1);
    expect(tree[0].comment.id).toBe("huerfano");
  });

  it("does not lose any comment from the batch", () => {
    const batch = [
      comment({ id: "a" }),
      comment({ id: "b", parentId: "a", depth: 1 }),
      comment({ id: "c", parentId: "fantasma", depth: 1 }),
    ];

    expect(count(buildTree(batch))).toBe(batch.length);
  });
});

describe("ordenar", () => {
  const old = comment({ id: "viejo", score: 5, createdAt: "2026-01-01T00:00:00Z" });
  const next = comment({ id: "nuevo", score: 5, createdAt: "2026-06-01T00:00:00Z" });
  const votedOne = comment({ id: "votado", score: 99, createdAt: "2025-01-01T00:00:00Z" });

  it("newest first", () => {
    const r = sort(buildTree([old, next]), "newest");
    expect(r.map((n) => n.comment.id)).toEqual(["nuevo", "viejo"]);
  });

  it("oldest first", () => {
    const r = sort(buildTree([next, old]), "oldest");
    expect(r.map((n) => n.comment.id)).toEqual(["viejo", "nuevo"]);
  });

  it("best first, even if old", () => {
    const r = sort(buildTree([next, votedOne]), "best");
    expect(r[0].comment.id).toBe("votado");
  });

  it("with the SAME score it breaks the tie by date, not randomly", () => {
    // Without a tiebreaker the order is decided by the database, which does not guarantee it,
    // and the list reorders itself between reloads.
    const r = sort(buildTree([old, next]), "best");
    expect(r.map((n) => n.comment.id)).toEqual(["nuevo", "viejo"]);
  });

  it("also sorts within each branch", () => {
    const tree = buildTree([
      comment({ id: "root" }),
      comment({ id: "r-vieja", parentId: "root", depth: 1, createdAt: "2026-01-01T00:00:00Z" }),
      comment({ id: "r-nueva", parentId: "root", depth: 1, createdAt: "2026-09-01T00:00:00Z" }),
    ]);

    const r = sort(tree, "newest");
    expect(r[0].answers.map((n) => n.comment.id)).toEqual(["r-nueva", "r-vieja"]);
  });
});

describe("contar", () => {
  it("counts what is seen, not what was loaded", () => {
    const tree = buildTree([
      comment({ id: "a" }),
      comment({ id: "b", parentId: "a", depth: 1 }),
      comment({ id: "c", parentId: "b", depth: 2 }),
      comment({ id: "d" }),
    ]);

    expect(count(tree)).toBe(4);
  });

  it("an empty tree counts zero", () => {
    expect(count([])).toBe(0);
  });
});

describe("censurar", () => {
  const tree = () =>
    buildTree([
      comment({ id: "hidden", status: "hidden", body: "insulto", authorName: "Trol" }),
      comment({ id: "response", parentId: "hidden", depth: 1, body: "contenido bueno" }),
    ]);

  it("covers the body but does NOT remove the node", () => {
    // Removing it from the tree orphans the reply, which is exactly what
    // this function exists to avoid.
    const r = censor(tree(), false);

    expect(r).toHaveLength(1);
    expect(r[0].comment.body).toBe("[comment removed by moderation]");
    expect(r[0].comment.authorName).toBeNull();
    expect(r[0].answers[0].comment.body).toBe("contenido bueno");
  });

  it("moderation sees it as is", () => {
    const r = censor(tree(), true);
    expect(r[0].comment.body).toBe("insulto");
  });

  it("does not touch what is published", () => {
    const r = censor(buildTree([comment({ id: "ok", body: "hola" })]), false);
    expect(r[0].comment.body).toBe("hola");
  });
});

describe("estadoInicial", () => {
  it("without a banned list, it publishes", () => {
    expect(initialStatus("lo que sea", [])).toBe("published");
  });

  it("sends to the queue, does NOT reject", () => {
    // A filter that rejects tells the spammer whether it got through; one that queues does not.
    expect(initialStatus("compra viagra barata", ["viagra"])).toBe("pending");
  });

  it("is not case sensitive", () => {
    expect(initialStatus("VIAGRA", ["viagra"])).toBe("pending");
    expect(initialStatus("viagra", ["VIAGRA"])).toBe("pending");
  });

  it("publishes what is not banned", () => {
    expect(initialStatus("un comentario normal", ["viagra", "casino"])).toBe("published");
  });

  it("ignores empty entries in the list", () => {
    // An empty string makes `includes("")` ALWAYS true: without this filter
    // a badly loaded list sends absolutely everything to the queue.
    expect(initialStatus("un comentario normal", ["", "casino"])).toBe("published");
  });
});
