/**
 * The logic of the domain hooks, without mounting components
 * ============================================================================
 *
 * The hooks in `@kitsuden/sdk-react` are thin: they request, store state and call
 * pure functions. These functions are tested here, which is where the
 * rules that an agent usually gets wrong when starting from scratch live.
 */

import { describe, expect, it } from "vitest";

import {
  KitsudenRequestError,
  moveInTierList,
  participantNames,
  requestFromKitsuden,
  openSets,
  nextSwissStep,
  tierListView,
  type TierListData,
} from "../../packages/sdk-react/src/pure-domain";

const LIST: TierListData = {
  slug: "champions",
  title: "Campeones",
  tiers: [
    { id: "s", label: "S" },
    { id: "a", label: "A" },
  ],
  items: [
    { id: "aria", label: "Aria" },
    { id: "boro", label: "Boro" },
    { id: "ciro", label: "Ciro" },
  ],
  placement: { aria: "s", boro: "f" },
};

describe("tier list", () => {
  it("groups by rows in row order", () => {
    const v = tierListView(LIST);
    expect(v.rows.map((f) => f.tier.id)).toEqual(["s", "a"]);
    expect(v.rows[0].items.map((i) => i.id)).toEqual(["aria"]);
  });

  it("an item in a row that no longer exists goes unranked, it does not disappear", () => {
    // `boro` was in «f», which was deleted. It must remain visible.
    const v = tierListView(LIST);
    expect(v.withoutRanking.map((i) => i.id).sort()).toEqual(["boro", "ciro"]);
  });

  it("moving locally does not touch the original list", () => {
    const moved = moveInTierList(LIST, "ciro", "a");
    expect(moved.placement.ciro).toBe("a");
    expect(LIST.placement.ciro, "the optimistic update needs the original to undo").toBeUndefined();
    expect(moveInTierList(moved, "ciro", null).placement.ciro).toBeUndefined();
  });
});

describe("tournament", () => {
  const names = participantNames({
    participants: [
      { id: "p1-aaaaaaaa", player: { alias: "Aria" } },
      { id: "p2-bbbbbbbb", team: { name: "Karmine Corp" } },
      { id: "p3-cccccccc" },
    ],
  });

  it("the name comes from the player or the team", () => {
    expect(names["p1-aaaaaaaa"]).toBe("Aria");
    expect(names["p2-bbbbbbbb"]).toBe("Karmine Corp");
    expect(names["p3-cccccccc"]).toBe("p3-ccccc");
  });

  it("only sets with two occupants and no winner are reportable", () => {
    const open = openSets(
      [
        {
          id: "m2",
          round: 2,
          participant1Id: "p1-aaaaaaaa",
          participant2Id: "p2-bbbbbbbb",
          winnerId: null,
        },
        {
          id: "m1",
          round: 1,
          participant1Id: "p1-aaaaaaaa",
          participant2Id: "p3-cccccccc",
          winnerId: null,
        },
        // Bye: resolved since it was paired.
        {
          id: "bye",
          round: 1,
          participant1Id: "p2-bbbbbbbb",
          participant2Id: null,
          winnerId: "p2-bbbbbbbb",
          status: "Completed",
        },
        // Already played.
        {
          id: "done",
          round: 1,
          participant1Id: "p1-aaaaaaaa",
          participant2Id: "p2-bbbbbbbb",
          winnerId: "p1-aaaaaaaa",
        },
        // Waiting for an occupant.
        {
          id: "tbd",
          round: 3,
          participant1Id: "p1-aaaaaaaa",
          participant2Id: null,
          winnerId: null,
        },
      ],
      names
    );

    expect(
      open.map((s) => s.matchId),
      "sorted by round"
    ).toEqual(["m1", "m2"]);
    expect(open[0].sides.map((l) => l.name)).toEqual(["Aria", "p3-ccccc"]);
  });

  it("in Swiss, the round in progress is not paired", () => {
    const status = { round: 1, totalRounds: 3, complete: false };
    expect(nextSwissStep(status, 1)).toBe("report");
    expect(nextSwissStep(status, 0)).toBe("emparejar");
    expect(nextSwissStep({ ...status, complete: true }, 0)).toBe("terminado");
  });
});

describe("calling the API", () => {
  it("sends the token and the body", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const r = await requestFromKitsuden(
      {
        baseUrl: "http://api.test/api/",
        token: "kitsuden_agent_x",
        fetch: (async (url: string, init: RequestInit) => {
          seen = { url, init };
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as unknown as typeof fetch,
      },
      "POST",
      "/tierlist/templates/x/place",
      { itemId: "aria", tierId: "s" }
    );

    expect(r).toEqual({ ok: true });
    expect(seen!.url, "no double slash even if the base ends in /").toBe(
      "http://api.test/api/tierlist/templates/x/place"
    );
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer kitsuden_agent_x"
    );
  });

  it("an error brings the suggestions in the message", async () => {
    const error = await requestFromKitsuden(
      {
        fetch: (async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Unknown fields",
                details: { unknownKeys: [{ key: "tier", didYouMean: "tierId" }] },
              },
            }),
            { status: 422 }
          )) as unknown as typeof fetch,
      },
      "POST",
      "/tierlist/templates/x/place",
      { itemId: "aria", tier: "s" }
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KitsudenRequestError);
    expect((error as Error).message).toContain("«tier» → «tierId»");
  });
});
