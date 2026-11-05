/**
 * The cases: what someone asks their agent for, and how to tell whether it did it
 * ============================================================================
 *
 * Each case is a request in plain language —with no ids or tool names,
 * as someone building their app would write it— and is graded by the
 * FINAL STATE of the database, not by what the agent says it did.
 *
 * Each one also comes with:
 *
 *   · `prepare` — the starting state, set up with the same tools.
 *   · `oracle` — a reference solution, also using the agent's tools. If the
 *     oracle does not pass a case, what is wrong is the case or the environment,
 *     not the model.
 *
 * ── ORIGIN ─────────────────────────────────────────────────────────────────
 *
 * Synthetic: they come from the guide's recipes and from the traps that the kons'
 * tests already document —player id versus participant, `bestOf`
 * versus `firstTo`, pairing with the round half done, correcting a result,
 * resyncing without losing what was placed—. Real user cases are missing,
 * and those are the most valuable.
 */

import type { Environment } from "./environment";

export interface Grade {
  completed: boolean;
  /** What is not as it should be. Empty if everything is fine. */
  failures: string[];
}

export interface Scenario {
  id: string;
  /** `tags[0]` groups in the report; the rest are labels. */
  tags: string[];
  prompt: string;
  prepare?: (e: Environment) => Promise<void>;
  oracle: (e: Environment) => Promise<void>;
  grade: (e: Environment) => Promise<Grade>;
}

// ── Utilities ────────────────────────────────────────────────────────────────

const equal = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const fromJson = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

class Revision {
  readonly failures: string[] = [];

  require(meets: boolean, failure: string): boolean {
    if (!meets) this.failures.push(failure);
    return meets;
  }

  get result(): Grade {
    return { completed: this.failures.length === 0, failures: [...this.failures] };
  }
}

// ── Tier lists ───────────────────────────────────────────────────────────────

interface SavedTierList {
  slug: string;
  tiers: { id: string; label: string }[];
  items: { id: string; label: string }[];
  placement: Record<string, string>;
}

const cards = (...names: string[]) => names.map((n) => ({ id: n.toLowerCase(), label: n }));

async function theTierList(
  e: Environment,
  rev: Revision,
  title: string
): Promise<SavedTierList | null> {
  const rows = await e.sql(
    `SELECT slug, tiers, items, placement FROM tier_lists
      WHERE kind = 'template' AND lower(trim(title)) = lower($1)`,
    [title]
  );
  if (
    !rev.require(rows.length === 1, `there are ${rows.length} tier lists «${title}», expected 1`)
  ) {
    return null;
  }
  const [f] = rows;
  return {
    slug: String(f.slug),
    tiers: fromJson(f.tiers),
    items: fromJson(f.items),
    placement: fromJson(f.placement) ?? {},
  };
}

/** `undefined` if the card is not there; `null` if it is unranked; otherwise, the label of its row. */
function rowOf(list: SavedTierList, name: string): string | null | undefined {
  const item = list.items.find((i) => equal(i.label, name));
  if (!item) return undefined;
  const tier = list.tiers.find((t) => t.id === list.placement[item.id]);
  return tier ? tier.label.trim().toUpperCase() : null;
}

function requireRows(
  rev: Revision,
  list: SavedTierList,
  expected: Record<string, string | null>
) {
  const n = Object.keys(expected).length;
  rev.require(list.items.length === n, `has ${list.items.length} cards, expected ${n}`);
  for (const [name, row] of Object.entries(expected)) {
    const real = rowOf(list, name);
    if (real === undefined) {
      rev.require(false, `missing ${name}`);
      continue;
    }
    const where = (f: string | null) => (f ? `in ${f}` : "unranked");
    rev.require(real === row, `${name} is ${where(real)}, expected ${where(row)}`);
  }
}

/** The starting list for several cases: Aria, Boro and Ciro, placed according to `place`. */
async function currentMeta(e: Environment, place: Record<string, string>) {
  await e.tool("tierlist_create", {
    title: "Current meta",
    catalog: cards("Aria", "Boro", "Ciro"),
  });
  for (const [itemId, tierId] of Object.entries(place)) {
    await e.tool("tierlist_place", { slug: "current-meta", itemId, tierId });
  }
}

async function listSlug(e: Environment, title: string): Promise<string> {
  const { tierLists } = await e.tool("tierlist_list", { search: title });
  const list = (tierLists as { slug: string; title: string }[]).find((l) =>
    equal(l.title, title)
  );
  if (!list) throw new Error(`no tier list «${title}»`);
  return list.slug;
}

// ── Tournaments ──────────────────────────────────────────────────────────────

/** The level order the prompts use: in each set, the higher-level player wins. */
const LEVEL = ["Aria", "Boro", "Ciro", "Dara"];
const stronger = (a: string, b: string) => (LEVEL.indexOf(a) <= LEVEL.indexOf(b) ? a : b);

interface Side {
  participantId: string;
  name: string;
}

interface ToolSet {
  matchId: string;
  round: number;
  sides: Side[];
}

interface SavedSet {
  id: string;
  round: number;
  p1: string;
  p2: string;
  winner: string | null;
  s1: number;
  s2: number;
}

async function theTournament(
  e: Environment,
  rev: Revision,
  title: string
): Promise<{ id: string; bracket_format: string } | null> {
  const rows = await e.sql<{ id: string; bracket_format: string }>(
    "SELECT id, bracket_format FROM esports_tournaments WHERE lower(trim(title)) = lower($1)",
    [title]
  );
  if (!rev.require(rows.length === 1, `there are ${rows.length} tournaments «${title}», expected 1`)) {
    return null;
  }
  return rows[0];
}

/** participantId → alias. */
async function aliasOf(e: Environment, tournamentId: string): Promise<Map<string, string>> {
  const rows = await e.sql<{ id: string; alias: string }>(
    `SELECT tp.id, p.alias FROM esports_tournament_participants tp
       JOIN esports_players p ON p.id = tp.player_id
      WHERE tp.tournament_id = $1`,
    [tournamentId]
  );
  return new Map(rows.map((f) => [f.id, f.alias]));
}

/** Sets with both sides filled in: no byes or slots still to be decided. */
async function playedSets(e: Environment, tournamentId: string): Promise<SavedSet[]> {
  return e.sql<SavedSet>(
    `SELECT id, round, participant_1_id AS p1, participant_2_id AS p2, winner_id AS winner,
            participant_1_score AS s1, participant_2_score AS s2
       FROM esports_matches
      WHERE tournament_id = $1 AND participant_1_id IS NOT NULL AND participant_2_id IS NOT NULL
      ORDER BY round, match_order`,
    [tournamentId]
  );
}

const setWith = (sets: SavedSet[], alias: Map<string, string>, name: string) =>
  sets.find((s) => alias.get(s.p1) === name || alias.get(s.p2) === name);

const winner = (s: SavedSet | undefined, alias: Map<string, string>) =>
  s?.winner ? alias.get(s.winner) : undefined;

function requireRegistrants(rev: Revision, alias: Map<string, string>, expectedValue: string[]) {
  const real = [...alias.values()].sort();
  const requests = [...expectedValue].sort();
  rev.require(
    real.join(",") === requests.join(","),
    `registered: ${real.join(", ") || "nobody"}; expected ${requests.join(", ")}`
  );
}

function requireStrongerWins(rev: Revision, sets: SavedSet[], alias: Map<string, string>) {
  for (const s of sets) {
    const a = alias.get(s.p1) ?? "?";
    const b = alias.get(s.p2) ?? "?";
    const expected = stronger(a, b);
    const real = winner(s, alias);
    rev.require(
      real === expected,
      `round ${s.round}, ${a} vs ${b}: ${real ? `won ${real}` : "no winner"}, expected ${expected}`
    );
  }
}

async function preparedTournament(
  e: Environment,
  title: string,
  bracketFormat: string,
  players: string[],
  extra: Record<string, unknown> = {}
): Promise<string> {
  const t = await e.tool("tournament_create", { title: title, bracketFormat, ...extra });
  await e.tool("tournament_add_players", {
    tournamentId: t.tournamentId,
    aliases: players,
  });
  return t.tournamentId;
}

async function tournamentId(e: Environment, title: string): Promise<string> {
  const { tournaments } = await e.tool("tournament_list", { search: title });
  const t = (tournaments as { tournamentId: string; title: string }[]).find((x) =>
    equal(x.title, title)
  );
  if (!t) throw new Error(`no tournament «${title}»`);
  return t.tournamentId;
}

async function openSets(e: Environment, tournamentId: string): Promise<ToolSet[]> {
  const { openSets } = await e.tool("tournament_sets", { tournamentId: tournamentId });
  return openSets;
}

const sideOf = (s: ToolSet, name: string) => s.sides.find((l) => l.name === name);

async function reportByLevel(e: Environment, tournamentId: string) {
  for (const s of await openSets(e, tournamentId)) {
    const wins = sideOf(s, stronger(s.sides[0].name, s.sides[1].name))!;
    await e.tool("tournament_report_set", {
      tournamentId: tournamentId,
      matchId: s.matchId,
      winnerId: wins.participantId,
    });
  }
}

/** Swiss with 3 rounds and the four from `LEVEL`, with round 1 paired. */
async function thursdaySwiss(e: Environment): Promise<string> {
  const id = await preparedTournament(e, "Thursday Swiss", "swiss", LEVEL, { swissRounds: 3 });
  await e.tool("tournament_start", { tournamentId: id });
  return id;
}

// ── Broadcast ────────────────────────────────────────────────────────────────

interface IssuanceSet {
  firstTo: number;
  eventTitle: string | null;
  round: string | null;
  sideA: { name?: string } | null;
  sideB: { name?: string } | null;
}

async function theIssuanceSet(e: Environment, rev: Revision): Promise<IssuanceSet | null> {
  const { docs } = (await e.api("/broadcast/matches")) as { docs: IssuanceSet[] };
  if (!rev.require(docs.length === 1, `there are ${docs.length} broadcast sets, expected 1`)) {
    return null;
  }
  return docs[0];
}

function requireSides(rev: Revision, set: IssuanceSet, names: [string, string]) {
  const real = [set.sideA?.name ?? "", set.sideB?.name ?? ""].map((n) => n.trim());
  const norm = (xs: string[]) =>
    xs
      .map((x) => x.toLowerCase())
      .sort()
      .join(",");
  rev.require(
    norm(real) === norm(names),
    `sides: ${real.join(" vs ")}; expected ${names.join(" vs ")}`
  );
}

// ── Cases ────────────────────────────────────────────────────────────────────

export const CASES: Scenario[] = [
  {
    id: "tierlist-create-and-place",
    tags: ["tierlist", "create"],
    prompt:
      "Create a tier list called «Arena Champions» with Aria, Boro, Ciro, Dara and Eko. Put Aria and Boro in S and Ciro in A; leave the rest unranked.",
    async oracle(e) {
      const list = await e.tool("tierlist_create", {
        title: "Arena Champions",
        catalog: cards("Aria", "Boro", "Ciro", "Dara", "Eko"),
      });
      for (const [itemId, tierId] of [
        ["aria", "s"],
        ["boro", "s"],
        ["ciro", "a"],
      ]) {
        await e.tool("tierlist_place", { slug: list.slug, itemId, tierId });
      }
    },
    async grade(e) {
      const rev = new Revision();
      const list = await theTierList(e, rev, "Arena Champions");
      if (list)
        requireRows(rev, list, { Aria: "S", Boro: "S", Ciro: "A", Dara: null, Eko: null });
      return rev.result;
    },
  },

  {
    id: "tierlist-new-without-moving",
    tags: ["tierlist", "sync"],
    prompt:
      "In the «Current meta» tier list two new characters have appeared, Fenix and Gala. Add them without moving anyone from where they are.",
    prepare: (e) => currentMeta(e, { aria: "s", boro: "a" }),
    async oracle(e) {
      const slug = await listSlug(e, "Current meta");
      const actual = await e.tool("tierlist_get", { slug });
      const alreadyAre = [
        ...actual.tiers.flatMap((t: { items: unknown[] }) => t.items),
        ...actual.unranked,
      ];
      await e.tool("tierlist_sync", {
        slug,
        catalog: [...alreadyAre, ...cards("Fenix", "Gala")],
      });
    },
    async grade(e) {
      const rev = new Revision();
      const list = await theTierList(e, rev, "Current meta");
      if (list) {
        requireRows(rev, list, { Aria: "S", Boro: "A", Ciro: null, Fenix: null, Gala: null });
      }
      return rev.result;
    },
  },

  {
    id: "tierlist-move-to-pool",
    tags: ["tierlist", "remove"],
    prompt:
      "Boro is no longer in the meta: take him out of his row in «Current meta» and leave him unranked, but keep him in the list.",
    prepare: (e) => currentMeta(e, { aria: "s", boro: "s" }),
    async oracle(e) {
      const slug = await listSlug(e, "Current meta");
      await e.tool("tierlist_place", { slug, itemId: "boro", tierId: null });
    },
    async grade(e) {
      const rev = new Revision();
      const list = await theTierList(e, rev, "Current meta");
      if (list) requireRows(rev, list, { Aria: "S", Boro: null, Ciro: null });
      return rev.result;
    },
  },

  {
    id: "tierlist-swap",
    tags: ["tierlist", "move"],
    prompt: "In «Current meta» swap Aria and Boro: Boro moves up to S and Aria drops to A.",
    prepare: (e) => currentMeta(e, { aria: "s", boro: "a", ciro: "b" }),
    async oracle(e) {
      const slug = await listSlug(e, "Current meta");
      await e.tool("tierlist_place", { slug, itemId: "boro", tierId: "s" });
      await e.tool("tierlist_place", { slug, itemId: "aria", tierId: "a" });
    },
    async grade(e) {
      const rev = new Revision();
      const list = await theTierList(e, rev, "Current meta");
      if (list) requireRows(rev, list, { Aria: "A", Boro: "S", Ciro: "B" });
      return rev.result;
    },
  },

  {
    id: "swiss-start-to-finish",
    tags: ["swiss", "full-flow"],
    prompt:
      "Organize a Swiss tournament «Autumn League» with 2 rounds with Aria, Boro, Ciro and Dara, and play it all the way through. The skill order is Aria > Boro > Ciro > Dara: in each set the higher-skilled player always wins.",
    async oracle(e) {
      const id = await preparedTournament(e, "Autumn League", "swiss", LEVEL, { swissRounds: 2 });
      await e.tool("tournament_start", { tournamentId: id });
      await reportByLevel(e, id);
      await e.tool("tournament_next_round", { tournamentId: id });
      await reportByLevel(e, id);
    },
    async grade(e) {
      const rev = new Revision();
      const t = await theTournament(e, rev, "Autumn League");
      if (!t) return rev.result;
      if (
        !rev.require(t.bracket_format === "swiss", `the format is ${t.bracket_format}, not swiss`)
      ) {
        return rev.result;
      }
      const alias = await aliasOf(e, t.id);
      requireRegistrants(rev, alias, LEVEL);
      requireStrongerWins(rev, await playedSets(e, t.id), alias);

      const { data } = (await e.api(`/esports/tournament/${t.id}/swiss`)) as {
        data: {
          round: number;
          totalRounds: number;
          complete: boolean;
          standings: { participantId: string; place: number }[];
        };
      };
      rev.require(data.totalRounds === 2, `the Swiss has ${data.totalRounds} rounds, not 2`);
      rev.require(data.complete, `the Swiss is not finished (it is at round ${data.round})`);
      const first = data.standings.find((s) => s.place === 1);
      const leader = first ? alias.get(first.participantId) : undefined;
      rev.require(leader === "Aria", `first place: ${leader ?? "nobody"}, expected Aria`);
      return rev.result;
    },
  },

  {
    id: "swiss-report-and-pair",
    tags: ["swiss", "report"],
    prompt:
      "In the «Thursday Swiss» tournament round 1 has already been played. The skill order is Aria > Boro > Ciro > Dara and in each set the higher-skilled player won. Report the results and pair round 2.",
    prepare: async (e) => {
      await thursdaySwiss(e);
    },
    async oracle(e) {
      const id = await tournamentId(e, "Thursday Swiss");
      await reportByLevel(e, id);
      await e.tool("tournament_next_round", { tournamentId: id });
    },
    async grade(e) {
      const rev = new Revision();
      const t = await theTournament(e, rev, "Thursday Swiss");
      if (!t) return rev.result;
      const alias = await aliasOf(e, t.id);
      const sets = await playedSets(e, t.id);
      requireStrongerWins(
        rev,
        sets.filter((s) => s.round === 1),
        alias
      );
      const round2 = sets.filter((s) => s.round === 2);
      rev.require(round2.length === 2, `round 2 has ${round2.length} sets, expected 2`);
      rev.require(
        round2.every((s) => !s.winner),
        "there are results in round 2 that nobody reported"
      );
      return rev.result;
    },
  },

  {
    id: "swiss-half-finished-round",
    tags: ["swiss", "no-invent"],
    prompt:
      "In the «Thursday Swiss» only Aria's set has finished, and she won it. Report it and, if possible, pair round 2.",
    prepare: async (e) => {
      await thursdaySwiss(e);
    },
    async oracle(e) {
      const id = await tournamentId(e, "Thursday Swiss");
      const set = (await openSets(e, id)).find((s) => sideOf(s, "Aria"))!;
      await e.tool("tournament_report_set", {
        tournamentId: id,
        matchId: set.matchId,
        winnerId: sideOf(set, "Aria")!.participantId,
      });
    },
    async grade(e) {
      const rev = new Revision();
      const t = await theTournament(e, rev, "Thursday Swiss");
      if (!t) return rev.result;
      const alias = await aliasOf(e, t.id);
      const sets = await playedSets(e, t.id);
      const round1 = sets.filter((s) => s.round === 1);
      const fromAria = setWith(round1, alias, "Aria");
      rev.require(winner(fromAria, alias) === "Aria", "Aria's set is not won by Aria");
      const other = round1.find((s) => s !== fromAria);
      rev.require(
        !!other && !other.winner,
        `the other round 1 set has a winner (${winner(other, alias)}) that nobody had reported`
      );
      rev.require(
        sets.every((s) => s.round === 1),
        "round 2 was paired with round 1 half finished"
      );
      return rev.result;
    },
  },

  {
    id: "swiss-correct-result",
    tags: ["swiss", "correct"],
    prompt:
      "I made a mistake reporting round 1 of the «Thursday Swiss»: Dara's set was won by Dara, not by the opponent. Fix it.",
    prepare: async (e) => {
      const id = await thursdaySwiss(e);
      await reportByLevel(e, id);
    },
    async oracle(e) {
      const id = await tournamentId(e, "Thursday Swiss");
      const { completedSets } = await e.tool("tournament_sets", {
        tournamentId: id,
        includeCompleted: true,
      });
      const set = (completedSets as ToolSet[]).find((s) => sideOf(s, "Dara"))!;
      await e.tool("tournament_report_set", {
        tournamentId: id,
        matchId: set.matchId,
        winnerId: sideOf(set, "Dara")!.participantId,
      });
    },
    async grade(e) {
      const rev = new Revision();
      const t = await theTournament(e, rev, "Thursday Swiss");
      if (!t) return rev.result;
      const alias = await aliasOf(e, t.id);
      const sets = await playedSets(e, t.id);
      const round1 = sets.filter((s) => s.round === 1);
      const fromDara = setWith(round1, alias, "Dara");
      const real = winner(fromDara, alias);
      rev.require(real === "Dara", `Dara's set is won by ${real ?? "nobody"}`);
      requireStrongerWins(
        rev,
        round1.filter((s) => s !== fromDara),
        alias
      );
      rev.require(
        sets.every((s) => s.round === 1),
        "round 2 was paired and nobody asked for it"
      );
      return rev.result;
    },
  },

  {
    id: "elimination-create-8",
    tags: ["elimination", "create"],
    prompt:
      "Create a single-elimination tournament «Lightning Cup» with 8 players (Aria, Boro, Ciro, Dara, Eko, Fenix, Gala and Hugo) and generate the bracket.",
    async oracle(e) {
      const id = await preparedTournament(e, "Lightning Cup", "single_elimination", [
        ...LEVEL,
        "Eko",
        "Fenix",
        "Gala",
        "Hugo",
      ]);
      await e.tool("tournament_start", { tournamentId: id });
    },
    async grade(e) {
      const rev = new Revision();
      const t = await theTournament(e, rev, "Lightning Cup");
      if (!t) return rev.result;
      rev.require(
        t.bracket_format === "single_elimination",
        `the format is ${t.bracket_format}, not single_elimination`
      );
      requireRegistrants(rev, await aliasOf(e, t.id), [...LEVEL, "Eko", "Fenix", "Gala", "Hugo"]);
      const firstRound = (await playedSets(e, t.id)).filter((s) => s.round === 1);
      rev.require(
        firstRound.length === 4,
        `the first round has ${firstRound.length} sets, expected 4`
      );
      return rev.result;
    },
  },

  {
    id: "elimination-semifinal-with-score",
    tags: ["elimination", "scoreboard"],
    prompt: "In the «Lightning Cup», Aria won her semifinal 2-1. Report it with the score.",
    prepare: async (e) => {
      const id = await preparedTournament(e, "Lightning Cup", "single_elimination", LEVEL);
      await e.tool("tournament_start", { tournamentId: id });
    },
    async oracle(e) {
      const id = await tournamentId(e, "Lightning Cup");
      const set = (await openSets(e, id)).find((s) => sideOf(s, "Aria"))!;
      const ariaFirst = set.sides[0].name === "Aria";
      await e.tool("tournament_report_set", {
        tournamentId: id,
        matchId: set.matchId,
        winnerId: sideOf(set, "Aria")!.participantId,
        participant1Score: ariaFirst ? 2 : 1,
        participant2Score: ariaFirst ? 1 : 2,
      });
    },
    async grade(e) {
      const rev = new Revision();
      const t = await theTournament(e, rev, "Lightning Cup");
      if (!t) return rev.result;
      const alias = await aliasOf(e, t.id);
      const semis = (await playedSets(e, t.id)).filter((s) => s.round === 1);
      const fromAria = setWith(semis, alias, "Aria");
      if (!rev.require(!!fromAria, "Aria plays no semifinal") || !fromAria) {
        return rev.result;
      }
      rev.require(winner(fromAria, alias) === "Aria", "Aria's semifinal is not won by Aria");
      const ariaFirst = alias.get(fromAria.p1) === "Aria";
      const [its, rival] = ariaFirst ? [fromAria.s1, fromAria.s2] : [fromAria.s2, fromAria.s1];
      rev.require(its === 2 && rival === 1, `Aria's score is ${its}-${rival}, not 2-1`);
      rev.require(
        semis.filter((s) => s !== fromAria).every((s) => !s.winner),
        "the other semifinal has a winner that nobody reported"
      );
      const idAria = [...alias].find(([, a]) => a === "Aria")?.[0] ?? "";
      const [final] = await e.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM esports_matches
          WHERE tournament_id = $1 AND round = 2
            AND (participant_1_id = $2 OR participant_2_id = $2)`,
        [t.id, idAria]
      );
      rev.require(final.n === 1, "Aria has not advanced to the final");
      return rev.result;
    },
  },

  {
    id: "league-round-robin",
    tags: ["league", "create-and-report"],
    prompt:
      "Create a round-robin league «Winter League» with Aria, Boro and Ciro, generate the matchups and report that Aria beat Boro.",
    async oracle(e) {
      const id = await preparedTournament(e, "Winter League", "round_robin", [
        "Aria",
        "Boro",
        "Ciro",
      ]);
      await e.tool("tournament_start", { tournamentId: id });
      const set = (await openSets(e, id)).find((s) => sideOf(s, "Aria") && sideOf(s, "Boro"))!;
      await e.tool("tournament_report_set", {
        tournamentId: id,
        matchId: set.matchId,
        winnerId: sideOf(set, "Aria")!.participantId,
      });
    },
    async grade(e) {
      const rev = new Revision();
      const t = await theTournament(e, rev, "Winter League");
      if (!t) return rev.result;
      rev.require(
        t.bracket_format === "round_robin",
        `the format is ${t.bracket_format}, not round_robin`
      );
      const alias = await aliasOf(e, t.id);
      requireRegistrants(rev, alias, ["Aria", "Boro", "Ciro"]);
      const sets = await playedSets(e, t.id);
      rev.require(sets.length === 3, `there are ${sets.length} matchups; in a 3-player league there are 3`);
      const ariaBoro = sets.find(
        (s) => [alias.get(s.p1), alias.get(s.p2)].sort().join(",") === "Aria,Boro"
      );
      rev.require(
        winner(ariaBoro, alias) === "Aria",
        "the Aria vs Boro match is not won by Aria"
      );
      rev.require(
        sets.filter((s) => s !== ariaBoro).every((s) => !s.winner),
        "there are other results that nobody reported"
      );
      return rev.result;
    },
  },

  {
    id: "checkin-mark-arrivals",
    tags: ["checkin", "ids"],
    prompt:
      "Boro and Ciro have just arrived at the table for the «Lightning Cup». Mark them as present.",
    prepare: async (e) => {
      const id = await preparedTournament(e, "Lightning Cup", "single_elimination", LEVEL);
      await e.tool("tournament_checkin", { tournamentId: id, action: "open", minutes: 30 });
    },
    async oracle(e) {
      const id = await tournamentId(e, "Lightning Cup");
      const t = await e.tool("tournament_get", { tournamentId: id });
      for (const name of ["Boro", "Ciro"]) {
        const p = (t.participants as { participantId: string; name: string }[]).find(
          (x) => x.name === name
        )!;
        await e.tool("tournament_checkin", {
          tournamentId: id,
          action: "mark",
          participantId: p.participantId,
        });
      }
    },
    async grade(e) {
      const rev = new Revision();
      const t = await theTournament(e, rev, "Lightning Cup");
      if (!t) return rev.result;
      const rows = await e.sql<{ alias: string }>(
        `SELECT p.alias FROM esports_tournament_participants tp
           JOIN esports_players p ON p.id = tp.player_id
          WHERE tp.tournament_id = $1 AND tp.checked_in_at IS NOT NULL`,
        [t.id]
      );
      const presentItems = rows.map((f) => f.alias).sort();
      rev.require(
        presentItems.join(",") === "Boro,Ciro",
        `present: ${presentItems.join(", ") || "nobody"}; expected Boro, Ciro`
      );
      return rev.result;
    },
  },

  {
    id: "checkin-drop-absent",
    tags: ["checkin", "confirm"],
    prompt:
      "The check-in for the «Lightning Cup» is over. Close it and remove from the tournament anyone who did not show up. Do not generate the bracket yet.",
    prepare: async (e) => {
      const id = await preparedTournament(e, "Lightning Cup", "single_elimination", [
        ...LEVEL,
        "Eko",
      ]);
      await e.tool("tournament_checkin", { tournamentId: id, action: "open", minutes: 30 });
      const t = await e.tool("tournament_get", { tournamentId: id });
      for (const p of t.participants as { participantId: string; name: string }[]) {
        if (p.name === "Eko") continue;
        await e.tool("tournament_checkin", {
          tournamentId: id,
          action: "mark",
          participantId: p.participantId,
        });
      }
    },
    async oracle(e) {
      const id = await tournamentId(e, "Lightning Cup");
      await e.tool("tournament_checkin", { tournamentId: id, action: "close" });
      await e.tool("tournament_checkin", {
        tournamentId: id,
        action: "drop",
        confirm: true,
      });
    },
    async grade(e) {
      const rev = new Revision();
      const t = await theTournament(e, rev, "Lightning Cup");
      if (!t) return rev.result;
      requireRegistrants(rev, await aliasOf(e, t.id), LEVEL);
      const [timeWindow] = await e.sql<{ closed: boolean | null }>(
        "SELECT check_in_closes_at <= now() AS closed FROM esports_tournaments WHERE id = $1",
        [t.id]
      );
      rev.require(timeWindow.closed === true, "the check-in window is still open");
      const [sets] = await e.sql<{ n: number }>(
        "SELECT count(*)::int AS n FROM esports_matches WHERE tournament_id = $1",
        [t.id]
      );
      rev.require(sets.n === 0, "the bracket was generated although it was asked not to");
      return rev.result;
    },
  },

  {
    id: "broadcast-grand-final-bo5",
    tags: ["broadcast", "bestOf"],
    prompt: "Set up the stream scoreboard for the Grand Final: Aria against Boro, best of 5.",
    async oracle(e) {
      await e.tool("broadcast_create_match", {
        round: "Grand Final",
        bestOf: 5,
        sideA: { name: "Aria" },
        sideB: { name: "Boro" },
      });
    },
    async grade(e) {
      const rev = new Revision();
      const set = await theIssuanceSet(e, rev);
      if (set) {
        rev.require(set.firstTo === 3, `first to ${set.firstTo}; best of 5 is first to 3`);
        requireSides(rev, set, ["Aria", "Boro"]);
      }
      return rev.result;
    },
  },

  {
    id: "broadcast-event-bo3",
    tags: ["broadcast", "fields"],
    prompt:
      "Create the overlay set for the event «Fight Friday», round «Winners Final»: Ciro against Dara, Bo3.",
    async oracle(e) {
      await e.tool("broadcast_create_match", {
        eventTitle: "Fight Friday",
        round: "Winners Final",
        bestOf: 3,
        sideA: { name: "Ciro" },
        sideB: { name: "Dara" },
      });
    },
    async grade(e) {
      const rev = new Revision();
      const set = await theIssuanceSet(e, rev);
      if (set) {
        rev.require(
          equal(set.eventTitle ?? "", "Fight Friday"),
          `event: «${set.eventTitle ?? ""}»`
        );
        rev.require(equal(set.round ?? "", "Winners Final"), `round: «${set.round ?? ""}»`);
        rev.require(set.firstTo === 2, `first to ${set.firstTo}; best of 3 is first to 2`);
        requireSides(rev, set, ["Ciro", "Dara"]);
      }
      return rev.result;
    },
  },
];
