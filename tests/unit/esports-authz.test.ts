/**
 * Esports authorization
 * ============================================================================
 *
 * This file exists because of one concrete failure, and it is worth reading:
 *
 * While registering required a CMS session, "having an account" and "belonging to the
 * organization" were the same thing, and `requireAuth` was enough. On opening
 * public registration that equivalence broke — now **everyone who plays
 * has an account** — and the 38 routes that only checked `requireAuth` became
 * open to any registrant.
 *
 * With a player's normal session you could: remove a rival's check-in
 * right before the cutoff, delete all absentees, decide a disputed
 * set and read the Discord handles of all participants.
 *
 * What is pinned here is that boundary.
 */

import { can, resetAuthz, type AuthzUser } from "@kitsuden/engine";
import { beforeEach, describe, expect, test } from "vitest";

import { registerEsportsPolicy } from "../../kons/kon-esports/esports.policy";

const admin: AuthzUser = { id: "u-admin", role: "admin" };
const editor: AuthzUser = { id: "u-editor", role: "editor" };
const player: AuthzUser = { id: "u-player", role: "user" };
const other: AuthzUser = { id: "u-other", role: "user" };

// The type is copied from the real contract and not narrowed: the policy declares
// `registeredByUserId?: string | null` y `AuthzUser.id` es `string | undefined`.
// Writing here a bare `string | null` made the helper stricter
// than the code it tests — and since nobody typechecked these tests, the
// mismatch went unseen.
const participantOf = (userId: string | null | undefined) => ({ registeredByUserId: userId });

beforeEach(() => {
  // Policies are a process singleton: another test that calls
  // `resetAuthz` would leave this file without policies and everything would be 403.
  resetAuthz();
  registerEsportsPolicy();
});

describe("operating the tournament", () => {
  test("the organization does", async () => {
    expect(await can(admin, "manage", {}, "esports")).toBe(true);
    expect(await can(editor, "manage", {}, "esports")).toBe(true);
  });

  test("A PLAYER DOES NOT", async () => {
    // It is the failure this policy closed: with public registration, this user
    // is anyone who signed up.
    expect(await can(player, "manage", {}, "esports")).toBe(false);
  });

  test("without a session, neither", async () => {
    expect(await can(null, "manage", {}, "esports")).toBe(false);
  });

  test("deny-by-default: an undefined action is denied", async () => {
    // Adding a new route and forgetting the rule cannot open it.
    expect(await can(admin, "inventada", {}, "esports")).toBe(false);
  });
});

describe("check-in", () => {
  test("each one confirms THEIR OWN", async () => {
    expect(await can(player, "selfCheckIn", participantOf(player.id), "esports")).toBe(true);
  });

  test("nobody confirms for another", async () => {
    expect(await can(other, "selfCheckIn", participantOf(player.id), "esports")).toBe(false);
  });

  test("the organization can confirm by hand", async () => {
    // It is needed: in an online tournament there is always someone who gets
    // confirmed by hand because they wrote on Discord instead of pressing the button.
    expect(await can(admin, "selfCheckIn", participantOf(player.id), "esports")).toBe(true);
  });

  test("an IMPORTED participant is confirmed by nobody except the organization", async () => {
    // It has no associated account: nobody has proven to be that person.
    const imported = participantOf(null);
    expect(await can(player, "selfCheckIn", imported, "esports")).toBe(false);
    expect(await can(other, "selfCheckIn", imported, "esports")).toBe(false);
    expect(await can(admin, "selfCheckIn", imported, "esports")).toBe(true);
  });

  test("REMOVING a check-in is only for the organization, even your own", async () => {
    // It sounds harmless until you see it the other way: it is the operation with which
    // someone is taken out of the tournament right before the window closes. The route
    // (`undo-check-in`) asks for `manage`.
    expect(await can(player, "manage", participantOf(player.id), "esports")).toBe(false);
    expect(await can(admin, "manage", participantOf(player.id), "esports")).toBe(true);
  });
});

describe("the policy lists only what a route enforces", () => {
  test("`revokeCheckIn` and `selfWithdraw` are gone: deny-by-default answers them", async () => {
    // They were declared and checked by no route. A scope or a caller relying on them now gets
    // the deny-by-default instead of a rule nobody enforced.
    for (const action of ["revokeCheckIn", "selfWithdraw"]) {
      expect(await can(admin, action, participantOf(player.id), "esports")).toBe(false);
      expect(await can(player, action, participantOf(player.id), "esports")).toBe(false);
    }
  });
});

describe("the boundary is where it should be", () => {
  test("a player does NOT inherit `manage` just for being able to touch their own", async () => {
    // The three levels do not inherit from each other by accident: it is what
    // prevents "can confirm their check-in" from ending up meaning "can
    // operate the tournament".
    const mine = participantOf(player.id);
    expect(await can(player, "selfCheckIn", mine, "esports")).toBe(true);
    expect(await can(player, "manage", mine, "esports")).toBe(false);
  });
});
