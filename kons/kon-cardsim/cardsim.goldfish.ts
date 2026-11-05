/**
 * CardSim — goldfish: how long a deck holds up before failing you
 * ============================================================================
 *
 * What people look for in a "practice mode" is almost never an opponent: it is knowing
 * whether their deck does what they want and how often. *"How many times do I have
 * enough ink and a 3-cost creature on turn 3?"* That needs no AI
 * at all — it needs shuffling ten thousand times and counting.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO DECISIONS THAT MAKE THE NUMBER MEAN SOMETHING
 *
 * 1. **The deal is DISJOINT by default.** If you ask for "3 ink **and** 1
 *    creature of cost ≤3", a hand with three cheap, inkable creatures
 *    does NOT satisfy both: the card you ink you do not play. Counting it
 *    twice would give a percentage higher than reality — exactly the mistake
 *    that makes you trust a deck that does not work. It is solved as a
 *    bipartite matching: each requirement takes different cards.
 *
 * 2. **The composition comes out alongside the probability.** A bare "12%" says
 *    nothing; "12%, and it's that you only run 8 inkable cards" says what to change.
 *    That is why each requirement reports how many cards in the deck meet it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything comes from the same seeded shuffle the engine uses, so a
 * report can be reproduced exactly by passing its seed — and two decks
 * can be compared on the SAME hands, which is the only way to truly compare
 * them.
 */

import { mainSectionOf, normalizeDeck, propertyValues } from "./cardsim.deck.js";
import type { CardCatalog, DeckInput } from "./cardsim.deck.js";
import { createRng, shuffle } from "./cardsim.engine.js";
import type { GameDefinition } from "./cardsim.types.js";

// ── What "a card that serves me" is ──────────────────────────────────────────

/**
 * A filter on the properties of `cardsim_cards.data`. It is the same place
 * the deck caps read from, so what works for a rule works
 * for a query.
 */
export interface CardFilter {
  /**
   * Property of `data`, with two RESERVED names that do not live there:
   * `cardId` (the card's id) and `name` (its name, if the catalog has it).
   *
   * Without `cardId` you could not ask the most commonly asked thing about a deck:
   * *"how many times do I draw my combo piece?"* — because `data` stores cost,
   * type and color, but not the card's identity.
   */
  property: string;
  /** Equality. If the card stores a list, it is enough for it to contain it. */
  equals?: string | number | boolean;
  /** Any of these values. */
  in?: (string | number | boolean)[];
  lte?: number;
  gte?: number;
  /** The property exists and is not false (`inkwell: true`). */
  truthy?: boolean;
}

export interface GoldfishRequirement {
  /** Readable: "ink", "creature of 3 or less". */
  label: string;
  /** ALL are met (AND). */
  filters: CardFilter[];
  /** How many such cards are needed. */
  count: number;
  /**
   * Inverts it: **at most** `count`, instead of at least.
   *
   * It is the missing half of "playable hand": having 2 ink is not enough,
   * you also need NOT to have seven. A cap requirement is checked
   * by counting, outside the disjoint deal — it competes for cards with no one.
   */
  atMost?: boolean;
}

export interface GoldfishQuery {
  id: string;
  label: string;
  /** Turn at which it is looked at. 1 = the opening hand only. */
  turn?: number;
  /** Alternative to `turn`: look at the first N cards, without translating turns. */
  cards?: number;
  /** All requirements at once. */
  require: GoldfishRequirement[];
  /**
   * `false` lets the same card count toward several requirements. It only makes
   * sense when the requirements are mutually exclusive by nature and you know they
   * do not overlap; by default it is NOT shared, which is what happens at the table.
   */
  disjoint?: boolean;
}

export interface GoldfishOptions {
  iterations?: number;
  seed?: number;
  /** On turn 1 you do not draw if you go first. */
  onThePlay?: boolean;
  drawsPerTurn?: number;
  /**
   * Declarative mulligan: if the opening hand does NOT meet this, it is redone —
   * as far as the game definition allows. Without a mulligan policy the
   * numbers come out pessimistic, because nobody keeps an impossible hand.
   */
  mulliganUnless?: GoldfishRequirement[];
  /** Numeric property to take the curve from. By default, the cost. */
  curveProperty?: string;
  /** How many opening hands to return as a sample, so they can be looked at. */
  sampleHands?: number;
}

export interface RequirementReport {
  label: string;
  count: number;
  /** How many cards in the deck meet this requirement. The context for the %. */
  inDeck: number;
}

export interface QueryReport {
  id: string;
  label: string;
  /** Cards seen on reaching that point. */
  cardsSeen: number;
  hits: number;
  probability: number;
  requirements: RequirementReport[];
}

export interface GoldfishReport {
  seed: number;
  iterations: number;
  deckSize: number;
  /** Average cards seen, counting mulligans. */
  averageHandSize: number;
  mulliganRate: number;
  /** Distribution of the curve property: value → how many cards. */
  curve: { value: string; cards: number }[];
  queries: QueryReport[];
  /** Sample opening hands, with the mulligan already applied. */
  sample: string[][];
}

export class GoldfishError extends Error {}

/** Filter checks at most per simulation (≈ 1 s of CPU). */
const GOLDFISH_BUDGET = 50_000_000;
/** Cards at most in the main section of the deck being simulated. */
const MAX_GOLDFISH_DECK = 300;

// ── Dealing hands to look at ─────────────────────────────────────────────────

/**
 * The subseed of hand number `i`.
 *
 * It is the piece that ties the goldfish (which COUNTS hands) to the dealer (which
 * SHOWS them): hand 3 that the interface paints is exactly iteration
 * 3 of the report. Without a common function, the two formulas would end up
 * diverging and "these are some of the 10,000 hands" would become a lie.
 */
export function handSeed(seed: number, index: number): number {
  return seed + index * 7919;
}

export interface DealtHand {
  /** Index within the batch. It is also that of the goldfish iteration. */
  index: number;
  /** The opening hand. */
  opening: string[];
  /** What would be drawn afterwards, in order. */
  drawn: string[];
}

export interface DealtHands {
  seed: number;
  deckSize: number;
  handSize: number;
  hands: DealtHand[];
}

/**
 * Deals specific hands to look at, not to count.
 *
 * It is the visceral half of "practice mode": the statistics say the deck
 * starts well 73 % of the time, but what convinces someone to try
 * a deck is looking at five real hands.
 *
 * Only the MAIN section is drawn from, just as in the goldfish: souls,
 * DON!! or the extra deck do not enter the hands.
 */
export function dealHands(
  definition: GameDefinition,
  deck: DeckInput,
  options: { count?: number; seed?: number; draws?: number; from?: number } = {}
): DealtHands {
  const cards = normalizeDeck(definition, deck)[mainSectionOf(definition).id] ?? [];
  if (!cards.length) throw new GoldfishError("The deck has no cards in its main section");

  const count = Math.min(50, Math.max(1, options.count ?? 5));
  const from = Math.max(0, options.from ?? 0);
  const seed = options.seed ?? 1;
  const handSize = Math.min(definition.openingHand, cards.length);
  const draws = Math.min(20, Math.max(0, options.draws ?? 0));

  const hands: DealtHand[] = [];
  for (let n = 0; n < count; n++) {
    const index = from + n;
    const order = shuffle(cards, createRng(handSeed(seed, index)));
    hands.push({
      index,
      opening: order.slice(0, handSize),
      drawn: order.slice(handSize, Math.min(handSize + draws, order.length)),
    });
  }

  return { seed, deckSize: cards.length, handSize, hands };
}

// ── Filters ──────────────────────────────────────────────────────────────────

/** Reserved names come from the id, not from `data`. */
function valuesOf(catalog: CardCatalog, cardId: string, property: string): unknown[] {
  if (property === "cardId") return [cardId];
  return propertyValues(catalog, cardId, property);
}

function matches(catalog: CardCatalog, cardId: string, filter: CardFilter): boolean {
  const values = valuesOf(catalog, cardId, filter.property);
  if (!values.length) return false;

  if (filter.truthy !== undefined) {
    const truthy = values.some(Boolean);
    if (truthy !== filter.truthy) return false;
  }
  if (filter.equals !== undefined && !values.some((v) => v === filter.equals)) return false;
  if (filter.in !== undefined && !values.some((v) => filter.in!.includes(v as string)))
    return false;
  // Numeric comparisons ignore anything that is not a number: a cost of "—" is not
  // "less than or equal to 3", it is that it has no cost.
  if (filter.lte !== undefined && !values.some((v) => typeof v === "number" && v <= filter.lte!)) {
    return false;
  }
  if (filter.gte !== undefined && !values.some((v) => typeof v === "number" && v >= filter.gte!)) {
    return false;
  }
  return true;
}

const satisfies = (catalog: CardCatalog, cardId: string, req: GoldfishRequirement) =>
  req.filters.every((f) => matches(catalog, cardId, f));

// ── Disjoint deal ────────────────────────────────────────────────────────────

/**
 * Can this hand cover all the requirements **with different cards**?
 *
 * It is a bipartite matching: on the left, one slot for each copy that
 * each requirement asks for ("3 ink" is 3 slots); on the right, the cards in
 * the hand. It is solved with augmenting paths (Kuhn), which for twenty slots
 * and sixty cards is instantaneous.
 *
 * Without this, "3 ink and 1 cheap creature" would be met by three cheap
 * inkable creatures — and at the table that hand does NOT do both things.
 */
function canCoverDisjoint(
  hand: string[],
  requirements: GoldfishRequirement[],
  catalog: CardCatalog
): boolean {
  const slots: GoldfishRequirement[] = [];
  for (const req of requirements) for (let i = 0; i < req.count; i++) slots.push(req);
  if (slots.length > hand.length) return false;

  /** For each slot, which cards in the hand suit it. */
  const options = slots.map((req) =>
    hand.map((card, i) => (satisfies(catalog, card, req) ? i : -1)).filter((i) => i !== -1)
  );

  const assignedTo = new Array<number>(hand.length).fill(-1);

  const augment = (slot: number, seen: boolean[]): boolean => {
    for (const card of options[slot]) {
      if (seen[card]) continue;
      seen[card] = true;
      if (assignedTo[card] === -1 || augment(assignedTo[card], seen)) {
        assignedTo[card] = slot;
        return true;
      }
    }
    return false;
  };

  for (let slot = 0; slot < slots.length; slot++) {
    if (!augment(slot, new Array<boolean>(hand.length).fill(false))) return false;
  }
  return true;
}

function coversOverlapping(
  hand: string[],
  requirements: GoldfishRequirement[],
  catalog: CardCatalog
): boolean {
  return requirements.every(
    (req) => hand.filter((card) => satisfies(catalog, card, req)).length >= req.count
  );
}

/**
 * Does this hand meet all the requirements?
 *
 * Caps (`atMost`) are checked separately, by counting: they do not compete for cards
 * with anyone, so putting them in the matching would make no sense — "at
 * most 5 ink" does not *consume* five cards, it is a condition on the hand.
 */
const covers = (
  hand: string[],
  requirements: GoldfishRequirement[],
  catalog: CardCatalog,
  disjoint: boolean
) => {
  const caps = requirements.filter((r) => r.atMost);
  for (const cap of caps) {
    if (hand.filter((card) => satisfies(catalog, card, cap)).length > cap.count) return false;
  }
  const needs = requirements.filter((r) => !r.atMost);
  if (!needs.length) return true;
  return disjoint
    ? canCoverDisjoint(hand, needs, catalog)
    : coversOverlapping(hand, needs, catalog);
};

// ── The simulation ───────────────────────────────────────────────────────────

/** Turn → cards seen, depending on the game and whether you go first. */
export function cardsSeenAt(
  definition: GameDefinition,
  turn: number,
  handSize: number,
  { onThePlay = true, drawsPerTurn = 1 }: { onThePlay?: boolean; drawsPerTurn?: number } = {}
): number {
  const extraTurns = Math.max(0, turn - 1);
  const firstTurnDraw = onThePlay ? 0 : drawsPerTurn;
  return handSize + extraTurns * drawsPerTurn + firstTurnDraw;
}

/**
 * Shuffles `iterations` times and counts. Returns the whole report.
 *
 * Only the MAIN section of the deck is used: it is the only one drawn from.
 * Souls, the extra deck or the DON!! deck do not enter the hands.
 */
export function goldfish(
  definition: GameDefinition,
  deck: DeckInput,
  catalog: CardCatalog,
  queries: GoldfishQuery[],
  options: GoldfishOptions = {}
): GoldfishReport {
  const run = prepare(definition, deck, catalog, queries, options);
  for (let i = 0; i < run.iterations; i++) run.step(i);
  return run.finish();
}

/**
 * Same as `goldfish`, but **yields the thread** every few thousand hands.
 *
 * A hundred thousand shuffles in a row is hundreds of milliseconds of blocking, and in
 * a shared API that is not "the report takes a while": it is that ALL requests
 * in that process wait, including plays in games in progress. Cutting
 * the loop into chunks lets the event loop breathe between chunks.
 *
 * It gives EXACTLY the same report as the synchronous version: each iteration
 * derives its shuffle from the seed and its index, so chunking the loop
 * does not change a single number.
 */
export async function goldfishAsync(
  definition: GameDefinition,
  deck: DeckInput,
  catalog: CardCatalog,
  queries: GoldfishQuery[],
  options: GoldfishOptions = {},
  chunkSize = 2_000
): Promise<GoldfishReport> {
  const run = prepare(definition, deck, catalog, queries, options);
  for (let i = 0; i < run.iterations; i++) {
    run.step(i);
    if ((i + 1) % chunkSize === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return run.finish();
}

interface GoldfishRun {
  iterations: number;
  step(i: number): void;
  finish(): GoldfishReport;
}

/**
 * Sets up the simulation and returns its two halves: take a step and close.
 *
 * It exists so the synchronous and asynchronous versions share down to the last
 * line of logic — if each had its own loop, the production one and the test one
 * could diverge without anyone noticing.
 */
function prepare(
  definition: GameDefinition,
  deck: DeckInput,
  catalog: CardCatalog,
  queries: GoldfishQuery[],
  options: GoldfishOptions
): GoldfishRun {
  const requestedIterations = Math.min(200_000, Math.max(100, options.iterations ?? 10_000));
  const seed = options.seed ?? 1;
  const cards = normalizeDeck(definition, deck)[mainSectionOf(definition).id] ?? [];
  if (!cards.length) throw new GoldfishError("The deck has no cards in its main section");

  const mulliganRule = definition.mulligan;
  const maxMulligans =
    options.mulliganUnless?.length && mulliganRule && mulliganRule.mode !== "none"
      ? mulliganRule.maxTimes
      : 0;
  const penalty = mulliganRule?.penalty ?? 0;

  const resolved = queries.map((q) => {
    if (q.cards === undefined && q.turn === undefined) {
      throw new GoldfishError(`The query "${q.id}" gives neither a turn nor a number of cards`);
    }
    for (const req of q.require) {
      // A cap of 0 does make sense ("no lands in the hand"); an
      // "at least 0" says nothing and is almost always a misplaced zero.
      if (req.count < (req.atMost ? 0 : 1)) {
        throw new GoldfishError(`"${q.id}" asks for ${req.count} of "${req.label}"`);
      }
      if (!req.filters.length) throw new GoldfishError(`"${req.label}" has no filter`);
    }
    return { query: q, hits: 0 };
  });

  // ── Work budget (earlier audit) ──
  // Each iteration costs, per query, slots × visible cards × filters.
  // With the per-field caps (50,000 iterations, 20 queries, 480 slots,
  // ~500 cards, 8 filters) an ANONYMOUS request asked for ~10¹¹ checks:
  // tens of minutes of one core (cardsim, its showcase and its hand generator use this).
  // Iterations are lowered until they fit in the budget; if even the
  // minimum does not fit, the query is too large.
  if (cards.length > MAX_GOLDFISH_DECK) {
    throw new GoldfishError(`The deck has ${cards.length} cards; the simulator supports ${MAX_GOLDFISH_DECK}`);
  }
  const costPerIteration = resolved.reduce((total, { query: q }) => {
    const gaps = q.require.reduce((n, r) => n + Math.max(1, r.count), 0);
    const filters = Math.max(1, ...q.require.map((r) => r.filters.length));
    const visibleValue = Math.min(cards.length, q.cards ?? cards.length);
    return total + gaps * visibleValue * filters;
  }, 1);
  const iterationsThatFit = Math.floor(GOLDFISH_BUDGET / costPerIteration);
  if (iterationsThatFit < 100) {
    throw new GoldfishError("The query is too large: reduce queries, requirements or filters");
  }
  const iterations = Math.min(requestedIterations, iterationsThatFit);

  // GAMES with a mulligan are counted, not mulligans: with two allowed, "1.4"
  // would not be a percentage and the figure would stop reading itself.
  let mulliganedGames = 0;
  let handSizeTotal = 0;
  const sample: string[][] = [];
  const wantSamples = Math.min(20, Math.max(0, options.sampleHands ?? 0));

  const step = (i: number): void => {
    // One subseed per iteration: the whole report is reproduced with `seed`,
    // and iteration N is always the same iteration N. It is what allows
    // chunking the loop without changing any number.
    const rng = createRng(handSeed(seed, i));
    let order = shuffle(cards, rng);
    let handSize = definition.openingHand;
    let tookMulligan = false;

    for (let m = 0; m < maxMulligans; m++) {
      if (covers(order.slice(0, handSize), options.mulliganUnless!, catalog, true)) break;
      // It is reshuffled with ANOTHER subseed: repeating the same one would give the same hand.
      order = shuffle(cards, createRng(handSeed(seed, i) + (m + 1) * 104_729));
      handSize = Math.max(0, handSize - penalty);
      tookMulligan = true;
    }
    if (tookMulligan) mulliganedGames++;

    handSizeTotal += handSize;
    if (sample.length < wantSamples) sample.push(order.slice(0, handSize));

    for (const entry of resolved) {
      const seen =
        entry.query.cards ??
        cardsSeenAt(definition, entry.query.turn!, handSize, {
          onThePlay: options.onThePlay,
          drawsPerTurn: options.drawsPerTurn,
        });
      const visible = order.slice(0, Math.min(seen, order.length));
      if (covers(visible, entry.query.require, catalog, entry.query.disjoint !== false)) {
        entry.hits++;
      }
    }
  };

  // The curve is static: there is no need to simulate to count the deck.
  const curveProperty = options.curveProperty ?? "cost";
  const buckets = new Map<string, number>();
  for (const cardId of cards) {
    const values = propertyValues(catalog, cardId, curveProperty);
    const key = values.length ? String(values[0]) : "—";
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const curve = [...buckets.entries()]
    .map(([value, count]) => ({ value, cards: count }))
    .sort((a, b) => {
      const na = Number(a.value);
      const nb = Number(b.value);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.value.localeCompare(b.value);
    });

  const finish = (): GoldfishReport => {
    const averageHandSize = handSizeTotal / iterations;

    return {
      seed,
      iterations,
      deckSize: cards.length,
      averageHandSize,
      mulliganRate: maxMulligans ? mulliganedGames / iterations : 0,
      curve,
      sample,
      queries: resolved.map(({ query, hits }) => ({
        id: query.id,
        label: query.label,
        cardsSeen:
          query.cards ??
          cardsSeenAt(definition, query.turn!, Math.round(averageHandSize), {
            onThePlay: options.onThePlay,
            drawsPerTurn: options.drawsPerTurn,
          }),
        hits,
        probability: hits / iterations,
        // The context without which a percentage says nothing: how many cards in the
        // deck meet each requirement.
        requirements: query.require.map((req) => ({
          label: req.label,
          count: req.count,
          inDeck: cards.filter((cardId) => satisfies(catalog, cardId, req)).length,
        })),
      })),
    };
  };

  return { iterations, step, finish };
}
