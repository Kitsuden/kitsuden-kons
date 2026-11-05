/**
 * Card simulator engine — game definition + deterministic session
 * ============================================================================
 *
 * It is not ONE card game: it is the machine to DEFINE card games and
 * play them. A TCG is described with data (`cardsim.types.ts`) and this engine
 * runs any definition. Adding a game is uploading its definition, not
 * writing code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL DECISION: EVENT SOURCING WITH SEEDED RNG
 *
 * A game's state is NOT stored: the LIST OF ACTIONS is stored, and the
 * state is rebuilt by replaying them. With a seeded shuffle, the same
 * list ALWAYS produces the same game. That buys, with a single decision:
 *
 *   · **Free replay** — replaying the list is rewinding the game.
 *   · **Cheap synchronization** — a spectator is sent the list, not a giant
 *     state; from then on, only each new action.
 *   · **Structural anti-cheat** — the server is the one that shuffles, rolls
 *     the dice and applies; a client cannot "know" the deck order
 *     because the order does not travel: the server's seed and the view of its
 *     seat travel.
 *   · **Undo** — undoing is truncating the list and replaying. There is no
 *     need to store intermediate states or inverse actions.
 *   · **Debugging** — a bug from a real game is reproduced exactly in a
 *     test by pasting its action list.
 *
 * The price: ALL randomness has to go through `rngCursor`. A single
 * call to `Math.random()` breaks the replay — and breaks it silently, because
 * the rebuilt game diverges with no error to give it away.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * What this engine does NOT do, on purpose: interpret the TEXT of the cards.
 * "Draw 2 and discard 1" is an effect of the specific game; automating it requires a
 * scripting language with its sandbox — the trap Tabletop
 * Simulator falls into with Lua and all its problems. Here the cards are MOVED
 * (players carry out the effects by hand) and the STRUCTURE —zones, caps,
 * secrecy, defeats— is policed by the engine.
 */

import {
  normalizeDeck,
  sectionsOf,
  validateDeck,
  validateGameDefinition,
  type CardCatalog,
  type DeckInput,
} from "./cardsim.deck.js";
import type {
  GameDefinition,
  LossCondition,
  MacroDefinition,
  ZoneDefinition,
} from "./cardsim.types.js";

export * from "./cardsim.types.js";
export {
  mainSectionOf,
  normalizeDeck,
  sectionsOf,
  validateDeck,
  validateGameDefinition,
} from "./cardsim.deck.js";
export type { CardCatalog, DeckInput } from "./cardsim.deck.js";

// ── Deterministic RNG ────────────────────────────────────────────────────────

/**
 * A game's seed: a number (old games, the browser's solitaire) or a
 * FUNCTION that gives the subseed for each use of randomness.
 *
 * Earlier audit: with a 31-bit number and subseeds
 * `seed + cursor·7919`, a player could deduce the permutation of their hand (the
 * `instanceId`s went in deck order), try all 2³¹ seeds and learn their
 * deck, the opponent's and all future randomness. The server now passes a function
 * with HMAC over a 256-bit secret that never leaves it: each subseed
 * is independent and there is nothing to brute-force. With a function, the
 * `instanceId`s are also shuffled when the game is created (see `createSession`).
 */
export type Seed = number | ((cursor: number) => number);

/**
 * Mulberry32: fast, good distribution for shuffling, and REPRODUCIBLE.
 *
 * `Math.random()` is forbidden throughout the engine.
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with injected RNG. Never `sort(() => random)`, which is biased. */
export function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── State ────────────────────────────────────────────────────────────────────

/**
 * An instance of a card in play. `instanceId` tells it apart from its copies:
 * two "Bolt"s on the table are two objects, and turning one does not turn the other.
 */
export interface CardInstance {
  instanceId: number;
  cardId: string;
  /** Face down even if it is in a visible zone. */
  faceDown: boolean;
  /** Turned (tapped/rested/in defense). The engine does not know what it means; the game does. */
  tapped: boolean;
  /** Arbitrary counters: +1/+1, damage, poison, asleep… */
  counters: Record<string, number>;
  /** Slot occupied in a zone with `slots`. */
  slot?: number | null;
  /** `instanceId` of the card it is attached to (energy, material, equipment). */
  attachedTo?: number | null;
  /** Created in play, not from the deck: on leaving, it ceases to exist. */
  token?: boolean;
  /**
   * Seats that HAVE already seen this card even though it was not theirs to see.
   *
   * It is what makes "I reveal this card", "I look at your hand" and "I see the top 3
   * of my deck" possible without breaking secrecy for everyone else. It is CLEARED on entering
   * a hidden zone and on shuffling: otherwise, returning a revealed card to the deck
   * would leave its position marked forever.
   */
  knownTo?: number[];
}

export interface PlayerState {
  resources: Record<string, number>;
  /** zoneId → cards. Ordered ones keep the order; index 0 = top. */
  zones: Record<string, CardInstance[]>;
  conceded: boolean;
  /** Defeated by a game condition (life at 0, unable to draw…). */
  lost: boolean;
  /** Why they lost — shown at the table and in the replay. */
  lostReason?: string;
  /** Mulligans used. */
  mulligans: number;
}

/**
 * A line of the log. It exists because there are things that HAPPEN and are not seen in the
 * final state: a die roll, a card revealed and returned, a message.
 * It is derived from the action log, so the replay rebuilds it the same.
 */
export interface LogEntry {
  seq: number;
  type: string;
  player: number | null;
  text: string;
  data?: Record<string, unknown>;
  /**
   * Seats that see this line. `null` = everyone, spectators included.
   * A list means secrecy: looking at your own deck is not announced with the
   * result, only with "player 1 looked at their deck".
   */
  visibleTo?: number[] | null;
}

export interface GameResult {
  winners: number[];
  reason: string;
}

export interface SessionState {
  definition: GameDefinition;
  players: PlayerState[];
  /** Shared zones of the board (`shared: true`), which belong to no one. */
  board: Record<string, CardInstance[]>;
  /** Game state: day/night, weather, round. */
  globals: Record<string, string | number | boolean>;
  turn: number;
  activePlayer: number;
  phaseIndex: number;
  /** Counter for `instanceId`. Part of the state: the replay must match. */
  nextInstanceId: number;
  /** Seeds consumed: each use of randomness takes the next one. */
  rngCursor: number;
  log: LogEntry[];
  /** `null` while the game continues. */
  result: GameResult | null;
  /**
   * Macro stopped waiting for a decision. While it is set, the table is
   * LOCKED except for whoever must decide: otherwise, the opponent could play
   * around a half-made choice and the result would depend on who
   * sent their request first.
   */
  pending: PendingChoice | null;
}

/**
 * A macro stopped midway. It lives in the state —and not in a server
 * variable— because the state is REBUILT: if the pending decision
 * were not part of it, a replay would skip the step and the game would diverge.
 */
export interface PendingChoice {
  macroId: string;
  /** Step being waited on. When resolved, the macro continues from the next one. */
  step: number;
  /** Seat that launched the macro. */
  owner: number;
  /** Seat whose turn it is to decide; not always the same as `owner`. */
  player: number;
  /** Card that launched the macro, for steps that speak of "this card". */
  source: number | null;
  prompt: string;
  kind: "cards" | "option" | "confirm";
  /**
   * The legal candidates. Choosing outside this list is illegal — without this,
   * "discard 1 from your hand" would accept discarding a card from the opponent's deck.
   *
   * `viewFor` does NOT show them to anyone but whoever decides: the
   * `instanceId`s are handed out in deck-construction order, so
   * showing them would leak positions to anyone who knows the list.
   */
  candidates?: number[];
  options?: string[];
  count?: number;
  upTo?: boolean;
}

export class CardSimError extends Error {}

// ── Actions ──────────────────────────────────────────────────────────────────

/** Where a card enters its destination zone. By default, at the end. */
export type Position = "top" | "bottom" | number;

export type Action =
  // Movement
  | { type: "draw"; player: number; count: number }
  | {
      type: "move";
      player: number;
      instanceId: number;
      toZone: string;
      toPlayer: number;
      position?: Position;
      slot?: number;
      faceDown?: boolean;
    }
  | {
      type: "moveZone";
      player: number;
      fromZone: string;
      fromPlayer: number;
      toZone: string;
      toPlayer: number;
    }
  | { type: "shuffleZone"; player: number; zone: string }
  // Card state
  | { type: "flip"; player: number; instanceId: number }
  | { type: "tap"; player: number; instanceId: number; tapped: boolean }
  | { type: "counter"; player: number; instanceId: number; name: string; delta: number }
  | { type: "attach"; player: number; instanceId: number; toInstanceId: number }
  | { type: "detach"; player: number; instanceId: number }
  | { type: "token"; player: number; cardId: string; toZone: string; toPlayer: number }
  | { type: "destroyToken"; player: number; instanceId: number }
  // Resources and game
  | { type: "resource"; player: number; target: number; resource: string; delta: number }
  | { type: "setGlobal"; player: number; id: string; value: string | number | boolean }
  | { type: "nextPhase"; player: number }
  | { type: "endTurn"; player: number }
  | { type: "concede"; player: number }
  | { type: "mulligan"; player: number }
  // Randomness
  | { type: "roll"; player: number; sides: number; count: number; label?: string }
  | {
      type: "randomMove";
      player: number;
      fromZone: string;
      fromPlayer: number;
      toZone: string;
      toPlayer: number;
      count: number;
    }
  | { type: "randomizeFirstPlayer"; player: number }
  // Information
  | { type: "reveal"; player: number; instanceIds: number[]; to?: number[] | null }
  | { type: "peek"; player: number; zone: string; targetPlayer: number; count: number }
  | { type: "chat"; player: number; text: string }
  | { type: "note"; player: number; text: string }
  // Macros
  | { type: "macro"; player: number; macroId: string; sourceInstanceId?: number }
  /** Resolves the pending decision and the macro continues from the next step. */
  | {
      type: "decide";
      player: number;
      instanceIds?: number[];
      option?: string;
      confirm?: boolean;
    }
  | { type: "cancelMacro"; player: number };

// ── Zone access ──────────────────────────────────────────────────────────────

function zoneDef(def: GameDefinition, zoneId: string): ZoneDefinition {
  const zone = def.zones.find((z) => z.id === zoneId);
  if (!zone) throw new CardSimError(`Zone "${zoneId}" does not exist`);
  return zone;
}

/**
 * The cards in a zone. A shared zone lives in `board` and has NO
 * owner: asking for it "of player 1" and "of player 0" returns the same array.
 */
function zoneCards(state: SessionState, zoneId: string, player: number): CardInstance[] {
  const zone = zoneDef(state.definition, zoneId);
  if (zone.shared) return state.board[zoneId];
  const owner = state.players[player];
  if (!owner) throw new CardSimError(`Player ${player} does not exist`);
  return owner.zones[zoneId];
}

/** The cards that OCCUPY space: an attachment does not use up a table slot. */
function occupants(cards: CardInstance[]): CardInstance[] {
  return cards.filter((c) => c.attachedTo === null || c.attachedTo === undefined);
}

interface Found {
  card: CardInstance;
  cards: CardInstance[];
  index: number;
  zoneId: string;
  /** `null` if it is in a shared zone. */
  owner: number | null;
}

function findCard(state: SessionState, instanceId: number): Found | null {
  for (const [zoneId, cards] of Object.entries(state.board)) {
    const index = cards.findIndex((c) => c.instanceId === instanceId);
    if (index !== -1) return { card: cards[index], cards, index, zoneId, owner: null };
  }
  for (let seat = 0; seat < state.players.length; seat++) {
    for (const [zoneId, cards] of Object.entries(state.players[seat].zones)) {
      const index = cards.findIndex((c) => c.instanceId === instanceId);
      if (index !== -1) return { card: cards[index], cards, index, zoneId, owner: seat };
    }
  }
  return null;
}

function requireCard(state: SessionState, instanceId: number): Found {
  const found = findCard(state, instanceId);
  if (!found) throw new CardSimError(`Card ${instanceId} is not in play`);
  return found;
}

/** A card's attachments, within its same zone. */
function attachmentsOf(cards: CardInstance[], parentId: number): CardInstance[] {
  return cards.filter((c) => c.attachedTo === parentId);
}

// ── Registry ─────────────────────────────────────────────────────────────────

function log(
  state: SessionState,
  entry: Omit<LogEntry, "seq"> & { visibleTo?: number[] | null }
): void {
  state.log.push({ seq: state.log.length, visibleTo: null, ...entry });
}

/**
 * Consumes a subseed. Each use of randomness in the game takes the NEXT one,
 * so the Nth use is always the same in the replay, wherever it is in
 * the action list.
 */
function nextRng(state: SessionState, seed: Seed): () => number {
  const sub = typeof seed === "function" ? seed(state.rngCursor) : seed + state.rngCursor * 7919;
  const rng = createRng(sub);
  state.rngCursor++;
  return rng;
}

/**
 * On entering a zone nobody sees, the card FORGETS who had seen it.
 * Without this, returning a revealed card to the deck would leave it marked forever
 * and the opponent would know exactly what they are going to draw.
 */
function forgetIfHidden(def: GameDefinition, card: CardInstance, zoneId: string): void {
  if (zoneDef(def, zoneId).visibility === "none") card.knownTo = [];
}

// ── Creating the session ─────────────────────────────────────────────────────

/**
 * Creates the session: validates decks, distributes the sections, shuffles with the seed,
 * draws lots for who starts if needed and draws the opening hand.
 *
 * Everything random derives from ONE seed and from the ORDER of the actions.
 */
export function createSession(
  definition: GameDefinition,
  decks: DeckInput[],
  seed: Seed,
  catalog: CardCatalog = {}
): SessionState {
  const defErrors = validateGameDefinition(definition);
  if (defErrors.length) throw new CardSimError(`Invalid definition: ${defErrors.join("; ")}`);

  if (decks.length < definition.players.min || decks.length > definition.players.max) {
    throw new CardSimError(
      `"${definition.name}" is for ${definition.players.min}-${definition.players.max} players`
    );
  }
  decks.forEach((deck, i) => {
    const errors = validateDeck(definition, deck, catalog);
    if (errors.length) throw new CardSimError(`Deck of player ${i}: ${errors.join("; ")}`);
  });

  const sections = sectionsOf(definition);
  let nextInstanceId = 1;

  const state: SessionState = {
    definition,
    players: decks.map((deck) => {
      const bySection = normalizeDeck(definition, deck);
      const zones: Record<string, CardInstance[]> = {};
      for (const zone of definition.zones) if (!zone.shared) zones[zone.id] = [];

      for (const section of sections) {
        // A section that starts in a shared zone is ignored here: shared
        // ones belong to no one and are filled with `token`/`move`.
        if (!zones[section.zone]) continue;
        const faceDown = zoneDef(definition, section.zone).visibility !== "all";
        for (const cardId of bySection[section.id] ?? []) {
          zones[section.zone].push({
            instanceId: nextInstanceId++,
            cardId,
            faceDown,
            tapped: false,
            counters: {},
            slot: null,
            attachedTo: null,
            knownTo: [],
          });
        }
      }

      return {
        resources: Object.fromEntries(definition.resources.map((r) => [r.id, r.initial])),
        zones,
        conceded: false,
        lost: false,
        mulligans: 0,
      };
    }),
    board: Object.fromEntries(
      definition.zones.filter((z) => z.shared).map((z) => [z.id, [] as CardInstance[]])
    ),
    globals: Object.fromEntries((definition.globals ?? []).map((g) => [g.id, g.initial])),
    turn: 1,
    activePlayer: 0,
    phaseIndex: 0,
    nextInstanceId,
    rngCursor: 0,
    log: [],
    result: null,
    pending: null,
  };

  // Games with a secret seed: the `instanceId`s are handed out at random. In
  // deck order, the id of each card in the hand said which position of the
  // deck it came from, and consecutive copies gave away face-down cards.
  if (typeof seed === "function") {
    const all = state.players.flatMap((p) => Object.values(p.zones).flat());
    const ids = shuffle(
      all.map((c) => c.instanceId),
      nextRng(state, seed)
    );
    all.forEach((c, i) => {
      c.instanceId = ids[i]!;
    });
  }

  // Shuffling, drawing lots and drawing are engine ACTIONS, not a special state:
  // that way the replay reproduces them by the same path as everything else.
  for (let p = 0; p < decks.length; p++) {
    for (const section of sections) {
      if (section.shuffle === false) continue;
      if (section.shuffle || section.zone === definition.deckZone) {
        applyAction(state, { type: "shuffleZone", player: p, zone: section.zone }, seed);
      }
    }
  }

  if (definition.firstPlayer === "random") {
    applyAction(state, { type: "randomizeFirstPlayer", player: 0 }, seed);
  }

  for (let p = 0; p < decks.length; p++) {
    if (definition.openingHand > 0) {
      applyAction(state, { type: "draw", player: p, count: definition.openingHand }, seed);
    }
  }

  return state;
}

// ── Applying an action ───────────────────────────────────────────────────────

/** Actions that are admitted while the table is locked by a pending decision. */
const ALWAYS_ALLOWED = new Set(["chat", "concede"]);

/**
 * Applies an action MUTATING the state. Throws if it is illegal — and an illegal
 * action must NOT be added to the log: the log only contains what happened.
 *
 * It is the PUBLIC door: it checks turn and table permissions and delegates to
 * `applyOne`. The internal steps of a macro enter through `applyOne`
 * directly, because if they went through here they would block themselves with the
 * decision they have just left pending.
 */
export function applyAction(state: SessionState, action: Action, seed: Seed): void {
  const player = state.players[action.player];
  if (!player) throw new CardSimError(`Player ${action.player} does not exist`);

  // With the game over, only talking is allowed. Allowing plays after the end
  // would leave replays that "continue" after the result and impossible scores.
  if (state.result && action.type !== "chat") {
    throw new CardSimError("The game has already ended");
  }
  if ((player.conceded || player.lost) && !ALWAYS_ALLOWED.has(action.type)) {
    throw new CardSimError(`Player ${action.player} is already out of the game`);
  }

  // With a macro half-done, the table is stopped. Without this, the opponent could
  // play while you choose and the result would depend on who sent first.
  if (state.pending && !ALWAYS_ALLOWED.has(action.type)) {
    if (action.type !== "decide" && action.type !== "cancelMacro") {
      throw new CardSimError(`There is a pending decision: ${state.pending.prompt}`);
    }
    if (action.player !== state.pending.player) {
      throw new CardSimError(`The decision belongs to player ${state.pending.player + 1}`);
    }
  }
  if (!state.pending && (action.type === "decide" || action.type === "cancelMacro")) {
    throw new CardSimError("There is no pending decision");
  }

  applyOne(state, action, seed);
  evaluateResult(state);
}

/**
 * Does this action reveal something its author has no right to see?
 * ==========================================================================
 *
 * The engine executes what it is asked, like a physical table: it knows nothing of game
 * rules. That is fine among players acting in good faith, but the server
 * receives actions from a client that may be tampered with, and several actions
 * valid for the engine BRING TO LIGHT the opponent's secrets:
 *
 *   · `peek` on the opponent's hand or deck.
 *   · `move`/`flip`/`reveal`/`attach` of an opponent's card you cannot see (you
 *     take it to a public zone, or flip it, and now you know which one it is).
 *   · `moveZone`/`randomMove` from a hidden zone of the opponent.
 *   · `macro` with `sourceInstanceId` of a hidden card of the opponent (a
 *     `moveSource` step would move it).
 *   · `tap`/`counter` on hidden cards of the opponent: they do not reveal, but their
 *     error/success serves as an oracle for which zone each `instanceId` is in.
 *
 * The rule: with a DIRECT action you only touch what is yours, what is shared, or the
 * opponent's cards you can already identify (face up in a public zone, or revealed
 * to you). To uncover another's secret, its owner does it (`reveal`), or
 * a MACRO that the game definition declares — the definition is written by the
 * team, not the client, and macro steps do not go through here.
 *
 * It does not go inside `applyAction` on purpose: `replay` replays logs already
 * stored and the browser's solo game uses the same engine. This
 * is the customs check for what ENTERS over the network, and the route calls it before applying.
 *
 * It throws `CardSimError` with a uniform message: saying "it is in the hand" versus
 * "it is in the deck" would be another oracle.
 */
export function checkSecrecy(state: SessionState, action: Action): void {
  const actor = action.player;
  const def = state.definition;
  const denied = () =>
    new CardSimError(
      "You cannot touch another player's hidden card: its owner moves or reveals it"
    );

  /** The actor can act on this card without uncovering anything they cannot see. */
  const touchable = (instanceId: number, revealing: boolean): void => {
    const found = findCard(state, instanceId);
    if (!found) throw new CardSimError(`Card ${instanceId} is not in play`);
    if (found.owner === null || found.owner === actor) return;
    const zone = zoneDef(def, found.zoneId);
    if (canIdentify(found.card, zone, actor, found.owner)) return;
    // Face down in a public zone: turning it or putting a counter on it does not uncover
    // anything (and is part of the game: turning the opponent's played card). Moving it,
    // flipping it or revealing it does.
    if (!revealing && zone.visibility === "all") return;
    throw denied();
  };

  /** Another player's zone that the actor cannot see in full. */
  const foreignHidden = (zoneId: string, owner: number): boolean => {
    const zone = zoneDef(def, zoneId);
    if (zone.shared || owner === actor) return false;
    if (zone.visibility !== "all") return true;
    // Public, but with face-down cards they do not know.
    const cards = state.players[owner]?.zones[zoneId] ?? [];
    return cards.some((c) => !canIdentify(c, zone, actor, owner));
  };

  switch (action.type) {
    case "move":
    case "flip":
    case "detach":
    case "destroyToken":
      touchable(action.instanceId, action.type === "move" || action.type === "flip");
      return;
    case "tap":
    case "counter":
      touchable(action.instanceId, false);
      return;
    case "attach":
      touchable(action.instanceId, true);
      touchable(action.toInstanceId, false);
      return;
    case "reveal":
      for (const id of action.instanceIds ?? []) touchable(id, true);
      return;
    case "peek": {
      const zone = zoneDef(def, action.zone);
      if (!zone.shared && action.targetPlayer !== actor) throw denied();
      return;
    }
    case "moveZone":
    case "randomMove": {
      const zone = zoneDef(def, action.fromZone);
      if (zone.visibility !== "all" && !zone.shared && action.fromPlayer !== actor) throw denied();
      // From a public zone with others' face-down cards, taking them to a
      // public destination would uncover them all at once.
      if (foreignHidden(action.fromZone, action.fromPlayer)) {
        const to = zoneDef(def, action.toZone);
        if (to.visibility !== "none" && to.faceDownOnEnter !== true) throw denied();
      }
      return;
    }
    case "macro":
      if (action.sourceInstanceId !== undefined) touchable(action.sourceInstanceId, true);
      return;
    default:
      return;
  }
}

function applyOne(state: SessionState, action: Action, seed: Seed): void {
  const def = state.definition;
  const player = state.players[action.player];

  switch (action.type) {
    case "draw": {
      if (action.count < 0) throw new CardSimError("Cannot draw a negative amount");
      const deck = player.zones[def.deckZone];
      if (deck.length < action.count) {
        // Running out of deck is a LOSS in most games, but only if
        // the definition says so: in others you simply cannot draw.
        const deckOut = (def.lossConditions ?? []).find((l) => l.when.kind === "cannotDraw");
        if (deckOut) {
          player.lost = true;
          player.lostReason = deckOut.name;
          log(state, {
            type: "loss",
            player: action.player,
            text: `Player ${action.player + 1}: ${deckOut.name}`,
          });
          break;
        }
        throw new CardSimError(
          `Player ${action.player} tries to draw ${action.count} with ${deck.length} in the deck`
        );
      }
      const drawn = deck.splice(0, action.count);
      const handVisibility = zoneDef(def, def.handZone).visibility;
      for (const card of drawn) {
        card.faceDown = handVisibility === "none";
        card.knownTo = [];
      }
      player.zones[def.handZone].push(...drawn);
      log(state, {
        type: "draw",
        player: action.player,
        text: `roba ${action.count}`,
        data: { count: action.count },
      });
      break;
    }

    case "move": {
      const zone = zoneDef(def, action.toZone);
      const found = requireCard(state, action.instanceId);
      const destination = zoneCards(state, action.toZone, action.toPlayer);

      // Moving an ATTACHED card detaches it: it leaves from under its parent.
      const moving = [found.card, ...attachmentsOf(found.cards, found.card.instanceId)];
      const sameZone = found.cards === destination;

      if (!sameZone) {
        const incoming = occupants(moving).length;
        if (zone.slots === undefined && zone.capacity !== undefined) {
          if (occupants(destination).length + incoming > zone.capacity) {
            throw new CardSimError(`"${zone.name}" is full (${zone.capacity})`);
          }
        }
      }

      // Slot: the request is respected or the first free one is taken.
      let slot: number | null = null;
      if (zone.slots !== undefined) {
        const taken = new Set(
          occupants(destination)
            .filter((c) => c.instanceId !== found.card.instanceId)
            .map((c) => c.slot)
        );
        if (action.slot !== undefined) {
          if (action.slot < 0 || action.slot >= zone.slots) {
            throw new CardSimError(`"${zone.name}" has no slot ${action.slot}`);
          }
          if (taken.has(action.slot)) {
            throw new CardSimError(`Slot ${action.slot} of "${zone.name}" is occupied`);
          }
          slot = action.slot;
        } else {
          slot = null;
          for (let i = 0; i < zone.slots; i++) {
            if (!taken.has(i)) {
              slot = i;
              break;
            }
          }
          if (slot === null) throw new CardSimError(`"${zone.name}" is full (${zone.slots})`);
        }
      }

      for (const card of moving) {
        const index = found.cards.indexOf(card);
        if (index !== -1) found.cards.splice(index, 1);
      }

      // On entering the deck the card is covered; in the rest it is uncovered, unless
      // the zone deals face down or whoever moves it asks for it.
      found.card.faceDown =
        action.faceDown ?? (zone.visibility === "none" || zone.faceDownOnEnter === true);
      found.card.tapped = false;
      found.card.slot = slot;
      found.card.attachedTo = null;
      forgetIfHidden(def, found.card, action.toZone);

      for (const card of moving.slice(1)) {
        card.faceDown = found.card.faceDown;
        card.slot = null;
        // Attachments follow their card. If the destination does not admit attachments,
        // they travel anyway but loose: it is what happens when an XYZ goes to the
        // graveyard and its materials follow.
        card.attachedTo = zone.attachable ? found.card.instanceId : null;
        forgetIfHidden(def, card, action.toZone);
      }

      insertAt(destination, moving, zone, action.position);
      log(state, {
        type: "move",
        player: action.player,
        text: `moves a card to ${zone.name}`,
        data: { instanceId: action.instanceId, toZone: action.toZone, toPlayer: action.toPlayer },
      });
      break;
    }

    case "moveZone": {
      const zone = zoneDef(def, action.toZone);
      const from = zoneCards(state, action.fromZone, action.fromPlayer);
      const to = zoneCards(state, action.toZone, action.toPlayer);
      if (from === to) break;
      const moving = from.splice(0, from.length);
      for (const card of moving) {
        card.faceDown = zone.visibility === "none" || zone.faceDownOnEnter === true;
        card.tapped = false;
        card.slot = null;
        card.attachedTo = null;
        forgetIfHidden(def, card, action.toZone);
      }
      to.push(...moving);
      log(state, {
        type: "moveZone",
        player: action.player,
        text: `moves ${moving.length} cards to ${zone.name}`,
        data: { count: moving.length, toZone: action.toZone },
      });
      break;
    }

    case "shuffleZone": {
      const zone = zoneDef(def, action.zone);
      if (!zone.ordered) {
        throw new CardSimError(`"${action.zone}" is not an ordered zone: there is nothing to shuffle`);
      }
      const cards = zoneCards(state, action.zone, action.player);
      const shuffled = shuffle(cards, nextRng(state, seed));
      // Shuffling CLEARS what each one had seen: otherwise, looking at the deck and
      // shuffling it would leave the cards seen marked for the rest of the game.
      for (const card of shuffled) card.knownTo = [];
      cards.splice(0, cards.length, ...shuffled);
      log(state, { type: "shuffle", player: action.player, text: `baraja ${zone.name}` });
      break;
    }

    case "flip": {
      const { card } = requireCard(state, action.instanceId);
      card.faceDown = !card.faceDown;
      log(state, {
        type: "flip",
        player: action.player,
        text: card.faceDown ? "places a card face down" : "flips a card",
      });
      break;
    }

    case "tap": {
      const { card } = requireCard(state, action.instanceId);
      card.tapped = action.tapped;
      break;
    }

    case "counter": {
      const { card } = requireCard(state, action.instanceId);
      const next = (card.counters[action.name] ?? 0) + action.delta;
      if (next === 0) delete card.counters[action.name];
      else card.counters[action.name] = next;
      break;
    }

    case "attach": {
      const child = requireCard(state, action.instanceId);
      const parent = requireCard(state, action.toInstanceId);
      if (child.card.instanceId === parent.card.instanceId) {
        throw new CardSimError("A card cannot be attached to itself");
      }
      const zone = zoneDef(def, parent.zoneId);
      if (!zone.attachable) {
        throw new CardSimError(`"${zone.name}" does not accept attached cards`);
      }
      // Attaching to an attachment would make chains and a possible cycle; a card with
      // material is attached as a block or not attached.
      if (parent.card.attachedTo !== null && parent.card.attachedTo !== undefined) {
        throw new CardSimError("Cannot attach to a card that is already attached");
      }

      const moving = [child.card, ...attachmentsOf(child.cards, child.card.instanceId)];
      for (const card of moving) {
        const index = child.cards.indexOf(card);
        if (index !== -1) child.cards.splice(index, 1);
        card.slot = null;
        card.attachedTo = parent.card.instanceId;
        card.faceDown = parent.card.faceDown;
        forgetIfHidden(def, card, parent.zoneId);
      }
      parent.cards.splice(parent.cards.indexOf(parent.card) + 1, 0, ...moving);
      log(state, {
        type: "attach",
        player: action.player,
        text: "attaches a card",
        data: { instanceId: action.instanceId, toInstanceId: action.toInstanceId },
      });
      break;
    }

    case "detach": {
      const { card, zoneId } = requireCard(state, action.instanceId);
      if (card.attachedTo === null || card.attachedTo === undefined) {
        throw new CardSimError("That card is not attached to any");
      }
      const zone = zoneDef(def, zoneId);
      if (zone.slots === undefined && zone.capacity !== undefined) {
        const cards = findCard(state, action.instanceId)!.cards;
        if (occupants(cards).length >= zone.capacity) {
          throw new CardSimError(`"${zone.name}" is full (${zone.capacity}): it does not fit loose`);
        }
      }
      card.attachedTo = null;
      log(state, { type: "detach", player: action.player, text: "detaches a card" });
      break;
    }

    case "token": {
      const allowed = def.tokens ?? [];
      if (allowed.length && !allowed.some((t) => t.cardId === action.cardId)) {
        throw new CardSimError(`"${action.cardId}" is not a token of this game`);
      }
      const zone = zoneDef(def, action.toZone);
      const destination = zoneCards(state, action.toZone, action.toPlayer);
      if (zone.slots === undefined && zone.capacity !== undefined) {
        if (occupants(destination).length >= zone.capacity) {
          throw new CardSimError(`"${zone.name}" is full (${zone.capacity})`);
        }
      }
      let slot: number | null = null;
      if (zone.slots !== undefined) {
        const taken = new Set(occupants(destination).map((c) => c.slot));
        for (let i = 0; i < zone.slots; i++) {
          if (!taken.has(i)) {
            slot = i;
            break;
          }
        }
        if (slot === null) throw new CardSimError(`"${zone.name}" is full (${zone.slots})`);
      }
      destination.push({
        instanceId: state.nextInstanceId++,
        cardId: action.cardId,
        faceDown: zone.visibility === "none" || zone.faceDownOnEnter === true,
        tapped: false,
        counters: {},
        slot,
        attachedTo: null,
        token: true,
        knownTo: [],
      });
      log(state, {
        type: "token",
        player: action.player,
        text: `creates a token (${action.cardId})`,
        data: { cardId: action.cardId },
      });
      break;
    }

    case "destroyToken": {
      const found = requireCard(state, action.instanceId);
      if (!found.card.token) {
        throw new CardSimError("Only tokens are destroyed; a real card is moved to a zone");
      }
      // A token that disappears takes with it whatever it had attached.
      for (const child of attachmentsOf(found.cards, found.card.instanceId)) {
        child.attachedTo = null;
      }
      found.cards.splice(found.cards.indexOf(found.card), 1);
      log(state, { type: "destroyToken", player: action.player, text: "a token ceases to exist" });
      break;
    }

    case "resource": {
      const resource = def.resources.find((r) => r.id === action.resource);
      if (!resource) throw new CardSimError(`Resource "${action.resource}" does not exist`);
      const target = state.players[action.target];
      if (!target) throw new CardSimError(`Player ${action.target} does not exist`);
      const raw = target.resources[action.resource] + action.delta;
      // It is clamped to the limits instead of rejected: "heal 5" with 18/20
      // life is legal in every game and must leave 20, not an error.
      target.resources[action.resource] = Math.min(
        resource.max ?? Number.POSITIVE_INFINITY,
        Math.max(resource.min ?? Number.NEGATIVE_INFINITY, raw)
      );
      log(state, {
        type: "resource",
        player: action.player,
        text: `${resource.name} of player ${action.target + 1}: ${target.resources[action.resource]}`,
        data: { target: action.target, resource: action.resource, delta: action.delta },
      });
      break;
    }

    case "setGlobal": {
      const global = (def.globals ?? []).find((g) => g.id === action.id);
      if (!global) throw new CardSimError(`The global state "${action.id}" does not exist`);
      if (global.values?.length && !global.values.includes(action.value)) {
        throw new CardSimError(`"${action.value}" is not a valid value of "${global.name}"`);
      }
      state.globals[action.id] = action.value;
      log(state, {
        type: "global",
        player: action.player,
        text: `${global.name}: ${String(action.value)}`,
        data: { id: action.id, value: action.value },
      });
      break;
    }

    case "mulligan": {
      const rule = def.mulligan;
      if (!rule || rule.mode === "none") throw new CardSimError("This game has no mulligan");
      if (player.mulligans >= rule.maxTimes) {
        throw new CardSimError(`You have already used your ${rule.maxTimes} mulligan(s)`);
      }
      player.mulligans++;
      const hand = player.zones[def.handZone];
      const size = Math.max(0, hand.length - rule.penalty);
      // Returning, shuffling and drawing again: goes through the same routes as everything
      // else, so secrecy and the RNG behave the same.
      applyOne(
        state,
        {
          type: "moveZone",
          player: action.player,
          fromZone: def.handZone,
          fromPlayer: action.player,
          toZone: def.deckZone,
          toPlayer: action.player,
        },
        seed
      );
      applyOne(state, { type: "shuffleZone", player: action.player, zone: def.deckZone }, seed);
      applyOne(state, { type: "draw", player: action.player, count: size }, seed);
      log(state, {
        type: "mulligan",
        player: action.player,
        text: `takes a mulligan and draws ${size}`,
        data: { size },
      });
      break;
    }

    case "roll": {
      if (action.sides < 2 || action.sides > 1000) {
        throw new CardSimError("A die has between 2 and 1000 sides");
      }
      if (action.count < 1 || action.count > 20) {
        throw new CardSimError("Between 1 and 20 dice are rolled");
      }
      const rng = nextRng(state, seed);
      const results = Array.from(
        { length: action.count },
        () => 1 + Math.floor(rng() * action.sides)
      );
      const what = action.sides === 2 ? "coin" : `d${action.sides}`;
      log(state, {
        type: "roll",
        player: action.player,
        text: `${action.label ? `${action.label}: ` : ""}${what} → ${results.join(", ")}`,
        data: { sides: action.sides, results },
      });
      break;
    }

    case "randomMove": {
      const from = zoneCards(state, action.fromZone, action.fromPlayer);
      const zone = zoneDef(def, action.toZone);
      const to = zoneCards(state, action.toZone, action.toPlayer);
      const pool = occupants(from);
      if (action.count < 1) throw new CardSimError("At least one card must be moved");
      if (pool.length < action.count) {
        throw new CardSimError(`There are only ${pool.length} cards in "${action.fromZone}"`);
      }
      // The SERVER chooses. If the client chose, "discard one at random" would be
      // "discard the one that hurts you least".
      const picked = shuffle(pool, nextRng(state, seed)).slice(0, action.count);
      for (const card of picked) {
        for (const child of attachmentsOf(from, card.instanceId)) {
          child.attachedTo = null;
          from.splice(from.indexOf(child), 1);
          child.faceDown = zone.visibility === "none" || zone.faceDownOnEnter === true;
          forgetIfHidden(def, child, action.toZone);
          to.push(child);
        }
        from.splice(from.indexOf(card), 1);
        card.faceDown = zone.visibility === "none" || zone.faceDownOnEnter === true;
        card.tapped = false;
        card.slot = null;
        card.attachedTo = null;
        forgetIfHidden(def, card, action.toZone);
        to.push(card);
      }
      log(state, {
        type: "randomMove",
        player: action.player,
        text: `${action.count} card(s) at random to ${zone.name}`,
        data: { count: action.count, toZone: action.toZone },
      });
      break;
    }

    case "randomizeFirstPlayer": {
      const rng = nextRng(state, seed);
      state.activePlayer = Math.floor(rng() * state.players.length);
      log(state, {
        type: "firstPlayer",
        player: null,
        text: `starts: player ${state.activePlayer + 1}`,
        data: { activePlayer: state.activePlayer },
      });
      break;
    }

    case "reveal": {
      const to = action.to ?? null;
      if (to && to.some((seat) => !state.players[seat])) {
        throw new CardSimError("Revealing to a seat that does not exist");
      }
      const revealed: string[] = [];
      for (const instanceId of action.instanceIds) {
        const { card } = requireCard(state, instanceId);
        const seats = to ?? state.players.map((_, i) => i);
        card.knownTo = [...new Set([...(card.knownTo ?? []), ...seats])];
        revealed.push(card.cardId);
      }
      log(state, {
        type: "reveal",
        player: action.player,
        text:
          to === null
            ? `reveals: ${revealed.join(", ")}`
            : `reveals ${revealed.length} card(s) to ${to.map((s) => s + 1).join(", ")}`,
        data: { cardIds: revealed },
        // Revealing to SOME is not shown to the rest: it is announced that it happened, not what.
        visibleTo: to === null ? null : [...new Set([action.player, ...to])],
      });
      break;
    }

    case "peek": {
      if (action.count < 1) throw new CardSimError("At least one card must be looked at");
      const cards = zoneCards(state, action.zone, action.targetPlayer);
      const seen = cards.slice(0, action.count);
      for (const card of seen) {
        card.knownTo = [...new Set([...(card.knownTo ?? []), action.player])];
      }
      // The TABLE sees that you looked; the contents are yours alone. Announcing the
      // result to everyone would turn "I search my deck" into public information.
      log(state, {
        type: "peek",
        player: action.player,
        text: `looks at ${seen.length} card(s) of ${zoneDef(def, action.zone).name}`,
        data: { zone: action.zone, count: seen.length },
      });
      break;
    }

    case "nextPhase": {
      if (action.player !== state.activePlayer) {
        throw new CardSimError("Only the active player changes phase");
      }
      state.phaseIndex = (state.phaseIndex + 1) % Math.max(1, def.phases.length);
      break;
    }

    case "endTurn": {
      if (action.player !== state.activePlayer) {
        throw new CardSimError("Only the active player ends their turn");
      }
      state.phaseIndex = 0;
      // Those who are out are skipped: their turn does not exist.
      let next = state.activePlayer;
      do {
        next = (next + 1) % state.players.length;
      } while (isOut(state.players[next]) && next !== state.activePlayer);
      if (next <= state.activePlayer) state.turn++;
      state.activePlayer = next;
      log(state, {
        type: "endTurn",
        player: action.player,
        text: `ends the turn; now playing: player ${next + 1}`,
      });
      break;
    }

    case "concede": {
      player.conceded = true;
      player.lostReason = "concedes";
      log(state, {
        type: "concede",
        player: action.player,
        text: `player ${action.player + 1} concedes`,
      });
      break;
    }

    case "chat": {
      const text = action.text.trim();
      if (!text) throw new CardSimError("Empty message");
      if (text.length > 500) throw new CardSimError("Message too long (maximum 500)");
      log(state, { type: "chat", player: action.player, text });
      break;
    }

    case "note": {
      const text = action.text.trim();
      if (!text) throw new CardSimError("Empty note");
      if (text.length > 300) throw new CardSimError("Note too long (maximum 300)");
      log(state, { type: "note", player: action.player, text });
      break;
    }

    case "macro": {
      const macro = (def.macros ?? []).find((m) => m.id === action.macroId);
      if (!macro) throw new CardSimError(`The macro "${action.macroId}" does not exist in this game`);
      // The source card has to exist IF declared: a macro that
      // says "turn this card" on a ghost card must not start.
      if (action.sourceInstanceId !== undefined) requireCard(state, action.sourceInstanceId);
      log(state, {
        type: "macro",
        player: action.player,
        text: `uses "${macro.name}"`,
        data: { macroId: macro.id },
      });
      runMacro(state, macro, 0, action.player, action.sourceInstanceId ?? null, seed);
      break;
    }

    case "decide": {
      const pending = state.pending!;
      const macro = (def.macros ?? []).find((m) => m.id === pending.macroId);
      if (!macro) throw new CardSimError("The pending macro no longer exists");
      resolveDecision(state, pending, action, seed);
      state.pending = null;
      runMacro(state, macro, pending.step + 1, pending.owner, pending.source, seed);
      break;
    }

    case "cancelMacro": {
      const pending = state.pending!;
      // Cancelling leaves what was already done applied — just as if the player
      // had done the steps by hand and stopped midway. That is why it is announced
      // in the log with the macro's name: the opponent has to see it.
      state.pending = null;
      log(state, {
        type: "cancelMacro",
        player: action.player,
        text: `cancels "${pending.macroId}" halfway (step ${pending.step + 1})`,
        data: { macroId: pending.macroId, step: pending.step },
      });
      break;
    }
  }
}

// ── Macros ───────────────────────────────────────────────────────────────────

/** The other seat. At tables of more than two, the next one still in the game. */
function opponentOf(state: SessionState, seat: number): number {
  for (let i = 1; i < state.players.length; i++) {
    const candidate = (seat + i) % state.players.length;
    if (!isOut(state.players[candidate])) return candidate;
  }
  return seat;
}

const sideOf = (state: SessionState, owner: number, side?: "self" | "opponent") =>
  side === "opponent" ? opponentOf(state, owner) : owner;

/**
 * Executes a macro's steps from `from`.
 *
 * It stops as soon as a step needs a decision: it leaves `state.pending` and returns.
 * The game resumes on its own when the `decide` action arrives, which continues
 * from the next step. That back-and-forth is what allows automating the
 * paperwork without inventing an effect interpreter.
 */
function runMacro(
  state: SessionState,
  macro: MacroDefinition,
  from: number,
  owner: number,
  source: number | null,
  seed: Seed
): void {
  for (let i = from; i < macro.steps.length; i++) {
    const step = macro.steps[i];

    switch (step.kind) {
      case "draw":
        applyOne(state, { type: "draw", player: owner, count: step.count }, seed);
        break;

      case "shuffle":
        applyOne(state, { type: "shuffleZone", player: owner, zone: step.zone }, seed);
        break;

      case "resource":
        applyOne(
          state,
          {
            type: "resource",
            player: owner,
            target: sideOf(state, owner, step.target),
            resource: step.resource,
            delta: step.delta,
          },
          seed
        );
        break;

      case "roll":
        applyOne(
          state,
          { type: "roll", player: owner, sides: step.sides, count: step.count, label: step.label },
          seed
        );
        break;

      case "randomMove":
        applyOne(
          state,
          {
            type: "randomMove",
            player: owner,
            fromZone: step.from,
            fromPlayer: sideOf(state, owner, step.fromOpponent ? "opponent" : "self"),
            toZone: step.to,
            toPlayer: sideOf(state, owner, step.toOpponent ? "opponent" : "self"),
            count: step.count,
          },
          seed
        );
        break;

      case "setGlobal":
        applyOne(state, { type: "setGlobal", player: owner, id: step.id, value: step.value }, seed);
        break;

      case "tapSource": {
        if (source === null) throw new CardSimError("This macro needs a source card");
        applyOne(
          state,
          { type: "tap", player: owner, instanceId: source, tapped: step.tapped ?? true },
          seed
        );
        break;
      }

      case "moveSource": {
        if (source === null) throw new CardSimError("This macro needs a source card");
        applyOne(
          state,
          {
            type: "move",
            player: owner,
            instanceId: source,
            toZone: step.to,
            toPlayer: sideOf(state, owner, step.toOpponent ? "opponent" : "self"),
          },
          seed
        );
        break;
      }

      case "note":
        applyOne(state, { type: "note", player: owner, text: step.text }, seed);
        break;

      case "chooseCards": {
        const decider = sideOf(state, owner, step.by);
        const fromSeat = sideOf(state, owner, step.fromOpponent ? "opponent" : "self");
        const pool = occupants(zoneCards(state, step.from, fromSeat));

        // With no candidates there is nothing to choose: the macro continues instead of
        // leaving the player trapped in an empty dialog.
        if (!pool.length) {
          log(state, {
            type: "macroSkip",
            player: owner,
            text: `${step.prompt}: there are no cards in ${zoneDef(state.definition, step.from).name}`,
          });
          break;
        }
        if (pool.length < step.count && !step.upTo) {
          throw new CardSimError(`"${step.prompt}" asks for ${step.count} and there are only ${pool.length}`);
        }

        // It cannot be chosen blindly: if the zone is not seen by whoever decides, the
        // candidates are revealed to THEM and to no one else. It is an implicit `peek`, and
        // that is why almost every search macro ends with a `shuffle`.
        for (const card of pool) {
          card.knownTo = [...new Set([...(card.knownTo ?? []), decider])];
        }

        state.pending = {
          macroId: macro.id,
          step: i,
          owner,
          player: decider,
          source,
          prompt: step.prompt,
          kind: "cards",
          candidates: pool.map((c) => c.instanceId),
          count: Math.min(step.count, pool.length),
          upTo: step.upTo,
        };
        return;
      }

      case "chooseOption":
        state.pending = {
          macroId: macro.id,
          step: i,
          owner,
          player: sideOf(state, owner, step.by),
          source,
          prompt: step.prompt,
          kind: "option",
          options: step.options,
        };
        return;

      case "confirm":
        state.pending = {
          macroId: macro.id,
          step: i,
          owner,
          player: sideOf(state, owner, step.by),
          source,
          prompt: step.prompt,
          kind: "confirm",
        };
        return;
    }
  }

  log(state, {
    type: "macroEnd",
    player: owner,
    text: `finishes "${macro.name}"`,
    data: { macroId: macro.id },
  });
}

/**
 * Applies the decision that resolves the pending step.
 *
 * Everything chosen is checked against the candidates the engine computed. Without
 * that, "discard 1 from your hand" would accept discarding from the opponent's deck — the
 * client sends `instanceId`, and an arbitrary `instanceId` is easy to type.
 */
function resolveDecision(
  state: SessionState,
  pending: PendingChoice,
  action: Extract<Action, { type: "decide" }>,
  seed: Seed
): void {
  const macro = (state.definition.macros ?? []).find((m) => m.id === pending.macroId)!;
  const step = macro.steps[pending.step];

  if (pending.kind === "confirm") {
    if (action.confirm === false) {
      // Saying NO cuts the macro here. It is what makes the step useful: the
      // opponent may disagree with the combat order.
      log(state, {
        type: "decide",
        player: action.player,
        text: `rejects: ${pending.prompt}`,
      });
      throw new CardSimError(`Rejected: ${pending.prompt}`);
    }
    log(state, { type: "decide", player: action.player, text: `confirms: ${pending.prompt}` });
    return;
  }

  if (pending.kind === "option") {
    const chosen = action.option;
    if (!chosen || !pending.options?.includes(chosen)) {
      throw new CardSimError(`"${chosen ?? ""}" is not one of the options`);
    }
    log(state, {
      type: "decide",
      player: action.player,
      text: `${pending.prompt} → ${chosen}`,
      data: { option: chosen },
    });
    return;
  }

  // kind === "cards"
  if (step.kind !== "chooseCards") throw new CardSimError("The pending step does not ask for cards");
  const chosen = action.instanceIds ?? [];
  const legal = new Set(pending.candidates ?? []);

  if (new Set(chosen).size !== chosen.length) {
    throw new CardSimError("The same card cannot be chosen twice");
  }
  for (const id of chosen) {
    if (!legal.has(id)) throw new CardSimError(`Card ${id} is not a valid option`);
  }
  const expected = pending.count ?? 0;
  if (pending.upTo ? chosen.length > expected : chosen.length !== expected) {
    throw new CardSimError(
      pending.upTo
        ? `Choose at most ${expected} card(s)`
        : `Choose exactly ${expected} card(s)`
    );
  }

  const toSeat = sideOf(state, pending.owner, step.toOpponent ? "opponent" : "self");
  for (const instanceId of chosen) {
    applyOne(
      state,
      {
        type: "move",
        player: pending.owner,
        instanceId,
        toZone: step.to,
        toPlayer: toSeat,
        position: step.position,
      },
      seed
    );
  }

  // The log says HOW MANY, not which: if the destination is public they are already visible, and
  // if it is the hand, saying it here would leak what the zone hides.
  log(state, {
    type: "decide",
    player: action.player,
    text: `${pending.prompt} → ${chosen.length} card(s) a ${zoneDef(state.definition, step.to).name}`,
    data: { count: chosen.length, toZone: step.to },
  });
}

/** Places the cards at the destination respecting `position`. */
function insertAt(
  destination: CardInstance[],
  cards: CardInstance[],
  zone: ZoneDefinition,
  position: Position | undefined
): void {
  if (position === undefined || position === "bottom" || !zone.ordered) {
    destination.push(...cards);
    return;
  }
  // Index 0 = top of the deck, so "top" is the start of the array.
  const index = position === "top" ? 0 : Math.max(0, Math.min(destination.length, position));
  destination.splice(index, 0, ...cards);
}

function isOut(player: PlayerState): boolean {
  return player.conceded || player.lost;
}

// ── Defeat conditions ────────────────────────────────────────────────────────

/**
 * The seats a condition looks at. `ofOpponent` inverts the subject:
 * you lose when the OPPONENT collects their six prizes. Without this the condition
 * would have to be written backwards and the defeat message would come out on the wrong
 * player — "Player 1: prizes complete" when the one who completed them was 2.
 */
function subjectSeats(state: SessionState, seat: number, ofOpponent?: boolean): number[] {
  if (!ofOpponent) return [seat];
  return state.players.map((_, i) => i).filter((i) => i !== seat);
}

function cardsInZone(state: SessionState, seat: number, zoneId: string): CardInstance[] {
  const zone = state.definition.zones.find((z) => z.id === zoneId);
  return (zone?.shared ? state.board[zoneId] : state.players[seat].zones[zoneId]) ?? [];
}

function playerMeets(state: SessionState, seat: number, condition: LossCondition): boolean {
  const w = condition.when;
  switch (w.kind) {
    case "resourceAtOrBelow":
      return (state.players[seat].resources[w.resource] ?? Number.POSITIVE_INFINITY) <= w.value;
    case "resourceAtOrAbove":
      return subjectSeats(state, seat, w.ofOpponent).some(
        (s) => (state.players[s].resources[w.resource] ?? Number.NEGATIVE_INFINITY) >= w.value
      );
    case "zoneEmpty":
      return subjectSeats(state, seat, w.ofOpponent).some(
        (s) => cardsInZone(state, s, w.zone).length === 0
      );
    case "zoneAtLeast":
      return subjectSeats(state, seat, w.ofOpponent).some(
        (s) => cardsInZone(state, s, w.zone).length >= w.count
      );
    case "cannotDraw":
      // The mark is set by `draw` on failing; there is nothing to look at here.
      return false;
  }
}

/**
 * Recomputes who has lost and whether the game ended. It runs after EVERY
 * action: it is derived, so the replay reaches the same result.
 */
function evaluateResult(state: SessionState): void {
  if (state.result) return;

  for (const condition of state.definition.lossConditions ?? []) {
    for (let seat = 0; seat < state.players.length; seat++) {
      const player = state.players[seat];
      if (isOut(player)) continue;
      if (playerMeets(state, seat, condition)) {
        player.lost = true;
        player.lostReason = condition.name;
        log(state, {
          type: "loss",
          player: seat,
          text: `Player ${seat + 1}: ${condition.name}`,
        });
      }
    }
  }

  const alive = state.players.map((_, i) => i).filter((i) => !isOut(state.players[i]));
  if (alive.length === 1 && state.players.length > 1) {
    state.result = {
      winners: alive,
      reason: state.players.find((p) => isOut(p))?.lostReason ?? "last one standing",
    };
  } else if (alive.length === 0) {
    state.result = { winners: [], reason: "draw" };
  }
  if (state.result) {
    log(state, {
      type: "result",
      player: null,
      text: state.result.winners.length
        ? `winner: player ${state.result.winners[0] + 1} (${state.result.reason})`
        : "draw",
      data: { ...state.result },
    });
  }
}

// ── Replay ───────────────────────────────────────────────────────────────────

/**
 * Rebuilds a game from its log. It IS the load function: a
 * persisted session is `{definition, decks, seed, actions}` and nothing more.
 */
export function replay(
  definition: GameDefinition,
  decks: DeckInput[],
  seed: Seed,
  actions: Action[],
  catalog: CardCatalog = {}
): SessionState {
  const state = createSession(definition, decks, seed, catalog);
  for (const action of actions) applyAction(state, action, seed);
  return state;
}

// ── Per-player views ─────────────────────────────────────────────────────────

export interface RedactedCard {
  instanceId: number;
  /** `null` = this spectator cannot see which card it is. */
  cardId: string | null;
  faceDown: boolean;
  tapped: boolean;
  counters: Record<string, number>;
  slot?: number | null;
  attachedTo?: number | null;
  token?: boolean;
}

export interface PlayerView {
  resources: Record<string, number>;
  zones: Record<string, RedactedCard[]>;
  conceded: boolean;
  lost: boolean;
  lostReason?: string;
  mulligans: number;
  /** How many cards are in zones it cannot see (the deck, others' hands). */
  hiddenCounts: Record<string, number>;
}

/**
 * The pending decision AS a seat sees it.
 *
 * Everyone sees THAT there is a decision and whose it is —the table is stopped, you have to
 * know who is being waited on—, but the CANDIDATES only travel to whoever decides.
 * The `instanceId`s are handed out in deck-construction order, so
 * showing the opponent among which instances you are choosing would leak positions if they
 * know your list.
 */
export interface PendingView {
  macroId: string;
  player: number;
  prompt: string;
  kind: "cards" | "option" | "confirm";
  count?: number;
  upTo?: boolean;
  /** Only for whoever decides. */
  candidates?: number[];
  options?: string[];
}

export interface SessionView {
  turn: number;
  activePlayer: number;
  phase: string;
  globals: Record<string, string | number | boolean>;
  players: PlayerView[];
  board: Record<string, RedactedCard[]>;
  log: LogEntry[];
  result: GameResult | null;
  pending: PendingView | null;
}

/**
 * Can `viewer` know WHICH card this is?
 *
 * Three paths, and all three have to be there: the zone is public, it is yours and not
 * face down, or someone showed it to you (`knownTo`). Removing the third
 * would break reveal and search; removing the second would hide your own hand.
 */
function canIdentify(
  card: CardInstance,
  zone: ZoneDefinition,
  viewer: number | null,
  owner: number | null
): boolean {
  if (viewer !== null && (card.knownTo ?? []).includes(viewer)) return true;
  if (zone.visibility === "none") return false;
  const isOwner = viewer !== null && viewer === owner;
  // Face down in a public zone: you see THAT there is a card, not WHICH — except for its
  // owner, who put it there and knows perfectly well what it is.
  if (card.faceDown) return isOwner;
  return zone.visibility === "all" || isOwner;
}

function redact(
  card: CardInstance,
  zone: ZoneDefinition,
  viewer: number | null,
  owner: number | null
): RedactedCard {
  return {
    instanceId: card.instanceId,
    cardId: canIdentify(card, zone, viewer, owner) ? card.cardId : null,
    faceDown: card.faceDown,
    tapped: card.tapped,
    counters: card.counters,
    slot: card.slot ?? null,
    attachedTo: card.attachedTo ?? null,
    token: card.token,
  };
}

/**
 * The game's view FOR a specific seat — the simulator's
 * security function.
 *
 * The server NEVER sends the full state: it sends this view. The opponent's
 * hand travels as "5 face-down cards" without a `cardId`, and the deck order
 * does not travel in any form. A cheating client can read all its traffic
 * and still know nothing it would not see at a real table.
 *
 * `viewer: null` is the spectator: sees what is public and no secret — the same
 * as in Broadcast's overlay, where only what can be seen goes on screen.
 */
export function viewFor(state: SessionState, viewer: number | null): SessionView {
  const def = state.definition;

  const players = state.players.map((player, seat) => {
    const zones: Record<string, RedactedCard[]> = {};
    const hiddenCounts: Record<string, number> = {};

    for (const zone of def.zones) {
      if (zone.shared) continue;
      const cards = player.zones[zone.id] ?? [];
      const visible = zone.visibility === "all" || (zone.visibility === "owner" && viewer === seat);
      // A hidden zone may contain cards that YOU do know (they were
      // revealed to you, or you looked at the deck). Those travel; the rest, only the number.
      const known = cards.filter((c) => viewer !== null && (c.knownTo ?? []).includes(viewer));

      if (visible) {
        zones[zone.id] = cards.map((c) => redact(c, zone, viewer, seat));
      } else {
        zones[zone.id] = known.map((c) => redact(c, zone, viewer, seat));
        hiddenCounts[zone.id] = cards.length - known.length;
      }
    }

    return {
      resources: player.resources,
      zones,
      conceded: player.conceded,
      lost: player.lost,
      lostReason: player.lostReason,
      mulligans: player.mulligans,
      hiddenCounts,
    };
  });

  const board: Record<string, RedactedCard[]> = {};
  for (const zone of def.zones) {
    if (!zone.shared) continue;
    board[zone.id] = (state.board[zone.id] ?? []).map((c) => redact(c, zone, viewer, null));
  }

  return {
    turn: state.turn,
    activePlayer: state.activePlayer,
    phase: def.phases[state.phaseIndex] ?? "",
    globals: state.globals,
    players,
    board,
    log: state.log.filter(
      (e) =>
        e.visibleTo === null ||
        e.visibleTo === undefined ||
        (viewer !== null && e.visibleTo.includes(viewer))
    ),
    result: state.result,
    pending: redactPending(state.pending, viewer),
  };
}

function redactPending(pending: PendingChoice | null, viewer: number | null): PendingView | null {
  if (!pending) return null;
  const base: PendingView = {
    macroId: pending.macroId,
    player: pending.player,
    prompt: pending.prompt,
    kind: pending.kind,
    count: pending.count,
    upTo: pending.upTo,
  };
  // Options and candidates, only to whoever decides.
  if (viewer !== null && viewer === pending.player) {
    base.candidates = pending.candidates;
    base.options = pending.options;
  }
  return base;
}
