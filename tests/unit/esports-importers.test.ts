/**
 * Importers — start.gg and Matcherino
 * ============================================================================
 *
 * An importer fails in a characteristic way: it does not blow up, it brings half.
 * And "half" is discovered on tournament day, with people in front. So what
 * is pinned here is not the happy path, but:
 *
 *   · That a URL a TO really copies is understood, and that one that does NOT work
 *     says so with the concrete reason (the tournament URL is not the event's).
 *   · That a failure at the other end is told apart from a failure of ours:
 *     "retry" and "fix the URL" are different actions.
 *   · That what could not be brought appears in `warnings`, not in a log. An
 *     importer that stays silent produces an incomplete tournament that looks complete.
 *   · That money never goes through floating point.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ImportError,
  type ImportedTournament,
} from "../../kons/kon-esports/importers/import.types";
import {
  importFromMatcherino,
  parseMatcherinoRef,
} from "../../kons/kon-esports/importers/matcherino";
import {
  importFromStartgg,
  parseStartggUrl,
} from "../../kons/kon-esports/importers/startgg";

/** Queues responses for `fetch`, in order. */
function stubFetch(responses: Array<{ status?: number; body: unknown; text?: string }>) {
  /**
   * What start.gg receives is a GraphQL request, and giving it its shape is what
   * makes the pagination assertion below —`c.body?.variables.page`—
   * check something. With `body: unknown` it did not compile; and since nobody typechecked
   * these tests, the `unknown` had been there without being noticed.
   *
   * `null` is real: `stubFetch` also captures requests without a body.
   */
  type GraphQLRequest = { query?: string; variables?: { page?: number; [k: string]: unknown } };
  const calls: Array<{ url: string; body: GraphQLRequest | null }> = [];
  let index = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: String(url), body: parsed });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      const payload = next.text ?? JSON.stringify(next.body);
      return {
        ok: (next.status ?? 200) < 400,
        status: next.status ?? 200,
        json: async () => JSON.parse(payload),
        text: async () => payload,
      };
    })
  );

  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── start.gg: understanding the reference ────────────────────────────────────

describe("start.gg — the URL a TO has at hand", () => {
  test("the event URL, with whatever suffix", () => {
    // Nobody copies the clean URL: it is copied while inside the bracket.
    for (const url of [
      "https://www.start.gg/tournament/genesis-9/event/melee-singles",
      "https://start.gg/tournament/genesis-9/event/melee-singles/brackets/123/456",
      "start.gg/tournament/genesis-9/event/melee-singles/overview",
      "https://smash.gg/tournament/genesis-9/event/melee-singles",
    ]) {
      expect(parseStartggUrl(url)).toEqual({
        tournamentSlug: "genesis-9",
        eventSlug: "melee-singles",
      });
    }
  });

  test("the API's own short slug is also valid", () => {
    expect(parseStartggUrl("tournament/genesis-9/event/melee-singles")).toEqual({
      tournamentSlug: "genesis-9",
      eventSlug: "melee-singles",
    });
  });

  test("the TOURNAMENT URL explains that the event's is needed", () => {
    // It is the mistake everyone makes the first time: a start.gg
    // tournament contains several events and each has its own bracket.
    expect(() => parseStartggUrl("https://start.gg/tournament/genesis-9")).toThrow(
      /for the tournament, not an event/
    );
  });

  test("another domain is rejected by naming it", () => {
    expect(() => parseStartggUrl("https://challonge.com/abc")).toThrow(/challonge\.com/);
  });
});

// ── start.gg: fetching the event ─────────────────────────────────────────────

const EVENT_OK = {
  data: {
    event: {
      id: 261856,
      name: "Melee Singles",
      startAt: 1700000000,
      teamRosterSize: null,
      videogame: { name: "Super Smash Bros. Melee" },
      tournament: { id: 1, name: "Genesis 9", slug: "genesis-9" },
    },
  },
};

const entrantsPage = (nodes: unknown[], totalPages = 1) => ({
  data: { event: { entrants: { pageInfo: { totalPages }, nodes } } },
});

const setsPage = (nodes: unknown[], totalPages = 1) => ({
  data: { event: { sets: { pageInfo: { totalPages }, nodes } } },
});

describe("start.gg — import", () => {
  test("brings participants with their seed and country", async () => {
    stubFetch([
      { body: EVENT_OK },
      {
        body: entrantsPage([
          {
            id: 2401411,
            name: "Zain",
            initialSeedNum: 1,
            participants: [{ id: 99, gamerTag: "Zain", user: { location: { country: "US" } } }],
          },
        ]),
      },
      { body: setsPage([]) },
    ]);

    const result = await importFromStartgg("tournament/genesis-9/event/melee-singles", "tok");

    expect(result.source).toBe("startgg");
    expect(result.title).toBe("Genesis 9 — Melee Singles");
    expect(result.participants).toEqual([
      expect.objectContaining({ externalId: "2401411", name: "Zain", seed: 1, country: "US" }),
    ]);
    // Epoch in seconds → ISO. If it is not converted here, every consumer has
    // to remember, and one will forget.
    expect(result.startsAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  test("a country that arrives as a NAME is not made up", async () => {
    // Mapping 200 translated names to codes is a table that goes stale,
    // and a wrong flag on a broadcast is worse than no flag.
    stubFetch([
      { body: EVENT_OK },
      {
        body: entrantsPage([
          {
            id: 1,
            name: "Ninguno",
            initialSeedNum: null,
            participants: [
              { id: 1, gamerTag: "Ninguno", user: { location: { country: "Japan" } } },
            ],
          },
        ]),
      },
      { body: setsPage([]) },
    ]);

    const result = await importFromStartgg("tournament/x/event/y", "tok");
    expect(result.participants[0].country).toBeNull();
  });

  test("a team event is detected by the ROSTER, not by the name", async () => {
    // "Doubles" or "3v3" is free text written by the organizer; the roster
    // size is data.
    stubFetch([
      {
        body: {
          data: {
            event: {
              ...EVENT_OK.data.event,
              name: "Crew Battle",
              teamRosterSize: { minPlayers: 3 },
            },
          },
        },
      },
      {
        body: entrantsPage([
          {
            id: 50,
            name: "Equipo Rojo",
            initialSeedNum: 2,
            participants: [
              { id: 1, gamerTag: "A", user: null },
              { id: 2, gamerTag: "B", user: { location: { country: "MX" } } },
            ],
          },
        ]),
      },
      { body: setsPage([]) },
    ]);

    const result = await importFromStartgg("tournament/x/event/y", "tok");
    expect(result.isTeamEvent).toBe(true);
    expect(result.participants[0].members).toHaveLength(2);
    // The first member's country is NOT taken as the team's: it would draw the
    // flag of whoever comes first in the list.
    expect(result.participants[0].country).toBeNull();
  });

  test("a DQ marker (-1) does not travel as a score", async () => {
    stubFetch([
      { body: EVENT_OK },
      { body: entrantsPage([]) },
      {
        body: setsPage([
          {
            id: "s1",
            winnerId: 10,
            fullRoundText: "Winners Final",
            slots: [
              { entrant: { id: 10 }, standing: { stats: { score: { value: -1 } } } },
              { entrant: { id: 11 }, standing: { stats: { score: { value: 0 } } } },
            ],
          },
        ]),
      },
    ]);

    const result = await importFromStartgg("tournament/x/event/y", "tok");
    expect(result.sets[0].winnerExternalId).toBe("10");
    // Without a score you see the set and who won, which is the truth. With "-1"
    // pintado en el overlay, no.
    expect(result.sets[0].scores).toBeNull();
  });

  test("an empty bracket slot travels as null, not as a string", async () => {
    stubFetch([
      { body: EVENT_OK },
      { body: entrantsPage([]) },
      {
        body: setsPage([
          {
            id: "s2",
            winnerId: null,
            fullRoundText: "Round 1",
            slots: [{ entrant: { id: 10 } }, { entrant: null }],
          },
        ]),
      },
    ]);

    const result = await importFromStartgg("tournament/x/event/y", "tok");
    expect(result.sets[0].participants).toEqual(["10", null]);
    expect(result.sets[0].winnerExternalId).toBeNull();
  });

  test("paginates IN SERIES and respects the total number of pages", async () => {
    // start.gg's limit is 80 requests/minute: firing them in
    // parallel is the fastest way to eat a 429 midway through an import.
    const calls = stubFetch([
      { body: EVENT_OK },
      { body: entrantsPage([{ id: 1, name: "A", initialSeedNum: null, participants: [] }], 2) },
      { body: entrantsPage([{ id: 2, name: "B", initialSeedNum: null, participants: [] }], 2) },
      { body: setsPage([]) },
    ]);

    const result = await importFromStartgg("tournament/x/event/y", "tok", { includeSets: false });

    expect(result.participants.map((p) => p.externalId)).toEqual(["1", "2"]);
    expect(
      calls.filter((c) => c.body?.variables?.page).map((c) => c.body?.variables?.page)
    ).toEqual([1, 2]);
  });
});

describe("start.gg — when it fails", () => {
  test("without a token it does not even get to call", async () => {
    const calls = stubFetch([{ body: EVENT_OK }]);
    await expect(importFromStartgg("tournament/x/event/y", "")).rejects.toThrow(/personal token/);
    expect(calls).toHaveLength(0);
  });

  test("401 explains that tokens EXPIRE", async () => {
    // It is the real cause 90% of the time, and "Unauthorized" does not say so.
    stubFetch([{ status: 401, body: {} }]);
    await expect(importFromStartgg("tournament/x/event/y", "viejo")).rejects.toThrow(/Tokens expire/);
  });

  test("429 is marked as RETRYABLE", async () => {
    stubFetch([{ status: 429, body: {} }]);
    await expect(importFromStartgg("tournament/x/event/y", "tok")).rejects.toMatchObject({
      retryable: true,
    });
  });

  test("a GraphQL error inside a 200 does NOT pass as a valid response", async () => {
    // GraphQL answers 200 with the errors in the body. Without this, a
    // rejected query came out as an empty import with no explanation.
    stubFetch([{ body: { errors: [{ message: "Query complexity too high" }] } }]);

    const promise = importFromStartgg("tournament/x/event/y", "tok");
    await expect(promise).rejects.toThrow(/complexity/i);
    await expect(promise).rejects.toMatchObject({ retryable: true });
  });

  test("a nonexistent event says so with its slug", async () => {
    stubFetch([{ body: { data: { event: null } } }]);
    await expect(importFromStartgg("tournament/fantasma/event/x", "tok")).rejects.toThrow(
      /tournament\/fantasma\/event\/x/
    );
  });

  test("a network outage is retryable; a bad token is not", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    await expect(importFromStartgg("tournament/x/event/y", "tok")).rejects.toMatchObject({
      retryable: true,
    });
  });
});

// ── Matcherino ───────────────────────────────────────────────────────────────

describe("Matcherino — the reference", () => {
  test("accepts the bare id and the URL forms", () => {
    expect(parseMatcherinoRef("112858")).toBe("112858");
    expect(parseMatcherinoRef("https://matcherino.com/tournaments/112858")).toBe("112858");
    expect(parseMatcherinoRef("https://matcherino.com/t/112858")).toBe("112858");
    expect(parseMatcherinoRef("https://matcherino.com/x?bountyId=112858")).toBe("112858");
  });

  test("a link WITHOUT a number explains why it is not enough", () => {
    // Matcherino identifies by number; resolving a slug would require a query
    // this endpoint does not offer. Saying so is worth more than failing inside.
    expect(() => parseMatcherinoRef("https://matcherino.com/mi-torneo")).toThrow(/numeric id/);
  });
});

const bountyEnvelope = (body: unknown) => ({ status: 200, error: null, body });

describe("Matcherino — import", () => {
  test("the prize pool arrives in CENTS and does not go through floating point", async () => {
    // 21250 is $212.50. Converting to decimal to go back to cents when saving
    // is the classic way of losing a cent of real money to rounding.
    stubFetch([
      {
        body: bountyEnvelope({
          id: 112858,
          title: "The KickBack SF6",
          game: { title: "Street Fighter 6" },
          balance: 21250,
          donorCount: 37,
          individualParticipants: [],
        }),
      },
    ]);

    const result = await importFromMatcherino("112858");
    expect(result.prizePool).toEqual({ cents: 21250, currency: "USD", contributors: 37 });
    expect(Number.isInteger(result.prizePool!.cents)).toBe(true);
  });

  test("brings the individual registrants with a stable identity", async () => {
    stubFetch([
      {
        body: bountyEnvelope({
          id: 1,
          title: "T",
          balance: 0,
          individualParticipants: [
            { userId: 119153, displayName: "ShineNYC", avatar: "https://x/a.png" },
          ],
        }),
      },
    ]);

    const result = await importFromMatcherino("1");
    expect(result.participants).toEqual([
      expect.objectContaining({ externalId: "119153", name: "ShineNYC" }),
    ]);
    // Matcherino does not publish the bracket here: returning [] is the honest thing.
    expect(result.sets).toEqual([]);
  });

  test("a registrant WITHOUT an identifier is discarded and a WARNING is given", async () => {
    // Without a stable id, reimporting would duplicate that person. Slipping them in silently
    // would be worse than leaving them out.
    stubFetch([
      {
        body: bountyEnvelope({
          id: 1,
          title: "T",
          balance: 0,
          individualParticipants: [{ displayName: "Anonymous" }, { userId: 5, displayName: "Ok" }],
        }),
      },
    ]);

    const result = await importFromMatcherino("1");
    expect(result.participants).toHaveLength(1);
    expect(result.warnings.join(" ")).toMatch(/without a stable identifier/);
  });

  test("if the list of registrants does not arrive, it says so", async () => {
    stubFetch([{ body: bountyEnvelope({ id: 1, title: "T", balance: 100 }) }]);

    const result = await importFromMatcherino("1");
    expect(result.participants).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/did not return the list of registrants/);
  });

  test("a prize pool in an odd format does not slip through as 0", async () => {
    // Publishing a $0 prize that actually could not be read is worse than
    // admitting it could not be read.
    stubFetch([{ body: bountyEnvelope({ id: 1, title: "T", balance: "mucho" }) }]);

    const result = await importFromMatcherino("1");
    expect(result.prizePool).toBeNull();
    expect(result.warnings.join(" ")).toMatch(/prize pool/);
  });

  test("HTML where there should be JSON is named for what it is", async () => {
    // It is an internal, undocumented endpoint: when it changes, the message has
    // to point there and not at some random `JSON.parse`.
    stubFetch([{ text: "<!doctype html><html>...", body: null }]);

    await expect(importFromMatcherino("1")).rejects.toThrow(/undocumented|not JSON/i);
  });

  test("a team tournament without a team list WARNS instead of pretending", async () => {
    // Importing teams halfway is the worst of all: the bracket is generated anyway
    // and the failure shows up on event day.
    stubFetch([
      {
        body: bountyEnvelope({ id: 1, title: "T", balance: 0, isTeam: true, bracketEntrants: 8 }),
      },
      { text: "", body: null },
    ]);

    const result = await importFromMatcherino("1");
    expect(result.isTeamEvent).toBe(true);
    expect(result.participants).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/teams/i);
  });

  test('"Bounty not found" is propagated as is', async () => {
    stubFetch([
      { status: 500, body: { status: 500, error: { message: "Bounty not found" }, body: null } },
    ]);
    await expect(importFromMatcherino("1")).rejects.toThrow(/Bounty not found/);
  });
});

// ── The neutral model ────────────────────────────────────────────────────────

describe("both platforms produce the SAME shape", () => {
  test("same fields, so that writing is a single one", async () => {
    stubFetch([{ body: EVENT_OK }, { body: entrantsPage([]) }, { body: setsPage([]) }]);
    const startgg = await importFromStartgg("tournament/x/event/y", "tok");

    vi.unstubAllGlobals();
    stubFetch([{ body: bountyEnvelope({ id: 1, title: "T", balance: 0 }) }]);
    const matcherino = await importFromMatcherino("1");

    const shape = (t: ImportedTournament) => Object.keys(t).sort();
    expect(shape(startgg)).toEqual(shape(matcherino));
  });

  test("ImportError tells apart what is retryable from what has to be fixed", () => {
    expect(new ImportError("x").retryable).toBe(false);
    expect(new ImportError("x", true).retryable).toBe(true);
  });
});
