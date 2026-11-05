/**
 * Showcase authorization (the `deckshow` policy of kon-cardsim)
 * ============================================================================
 *
 * The showcase (DeckShow, a kon of its own until it merged into kon-cardsim) had no tests. Its policy has a distinction that is easy
 * to delete without noticing: `moderate` is NOT "update with more permissions".
 *
 * Featuring and hiding belong to the site; editing belongs to the author. If they collapse into
 * a single action, anyone can feature themselves — and that is exactly the
 * failure not seen in a demo, because in a demo the tester is admin.
 */

import { can, resetAuthz, type AuthzUser } from "@kitsuden/engine";
import { beforeEach, describe, expect, test } from "vitest";

import { registerDeckshowPolicy } from "../../kons/kon-cardsim/deckshow.policy";

const admin: AuthzUser = { id: "u-admin", role: "admin" };
const editor: AuthzUser = { id: "u-editor", role: "editor" };
const author: AuthzUser = { id: "u-autor", role: "user" };
const other: AuthzUser = { id: "u-otro", role: "user" };

const its = { id: "d1", authorId: "u-autor", status: "published" };
const foreign = { id: "d2", authorId: "u-otro", status: "published" };
const hidden = { id: "d3", authorId: "u-autor", status: "hidden" };

beforeEach(() => {
  // Policies are a process singleton: without re-registering them,
  // another file calling resetAuthz would leave all of this at 403.
  resetAuthz();
  registerDeckshowPolicy();
});

describe("looking at the showcase", () => {
  test("without an account, what is published is seen: it is its reason for being", async () => {
    expect(await can(null, "view", its, "deckshow")).toBe(true);
  });

  test("what is hidden is NOT seen by just anyone", async () => {
    expect(await can(other, "view", hidden, "deckshow")).toBe(false);
    expect(await can(null, "view", hidden, "deckshow")).toBe(false);
  });

  test("what is hidden IS seen by its author — they must be able to read why", async () => {
    expect(await can(author, "view", hidden, "deckshow")).toBe(true);
  });

  test("and by moderation too", async () => {
    expect(await can(admin, "view", hidden, "deckshow")).toBe(true);
    expect(await can(editor, "view", hidden, "deckshow")).toBe(true);
  });
});

describe("create", () => {
  test("a session is required", async () => {
    expect(await can(author, "create", {} as never, "deckshow")).toBe(true);
    expect(await can(null, "create", {} as never, "deckshow")).toBe(false);
  });
});

describe("editing and deleting", () => {
  test("the author on their own", async () => {
    expect(await can(author, "update", its, "deckshow")).toBe(true);
    expect(await can(author, "delete", its, "deckshow")).toBe(true);
  });

  test("NOT on others'", async () => {
    expect(await can(author, "update", foreign, "deckshow")).toBe(false);
    expect(await can(author, "delete", foreign, "deckshow")).toBe(false);
  });

  test("moderation can act on others'", async () => {
    expect(await can(admin, "update", foreign, "deckshow")).toBe(true);
    expect(await can(editor, "delete", foreign, "deckshow")).toBe(true);
  });
});

describe("moderating is NOT editing with stripes", () => {
  test("featuring and hiding belong to the site", async () => {
    expect(await can(admin, "moderate", its, "deckshow")).toBe(true);
    expect(await can(editor, "moderate", its, "deckshow")).toBe(true);
  });

  test("THE AUTHOR CANNOT MODERATE EVEN THEIR OWN", async () => {
    // If `moderate` fell into the same branch as `update`, this would be `true` and
    // anyone could feature themselves on the front page.
    expect(await can(author, "moderate", its, "deckshow")).toBe(false);
  });

  test("without a session, even less", async () => {
    expect(await can(null, "moderate", its, "deckshow")).toBe(false);
  });
});
