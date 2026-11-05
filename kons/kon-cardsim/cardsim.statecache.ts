/**
 * CardSim — incremental cache of game state
 * ============================================================================
 *
 * The price of storing actions instead of state is that READING costs
 * replaying. A 300-action game queried by two players and three
 * spectators in a loop is re-simulated whole dozens of times per second, and the
 * cost grows with the game: right at the end, which is when most people are watching.
 *
 * This cache makes it incremental. If we have the state at action
 * 300 and 301 arrives, ONE action is applied instead of three hundred.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MUST NOT BE BROKEN
 *
 * A stale state cache is not a performance problem: it is two
 * players seeing different boards. Three rules hold it up:
 *
 * 1. **The epoch.** Almost everything that happens to a game is ADDING actions,
 *    and from there it can continue. But undo TRUNCATES and sitting CHANGES the
 *    decks: in those two cases the cached prefix no longer describes this game.
 *    The session carries a counter that goes up in those two places, and an entry from
 *    another epoch is discarded without looking at it.
 * 2. **The inner object is never lent out.** A copy is returned. Whoever
 *    calls can mutate it —`applyAction` mutates— without corrupting what is cached.
 * 3. **It is an optimization, not a source of truth.** If something does not add up, it is
 *    replayed from scratch. Losing the cache only costs time.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It lives IN-PROCESS on purpose. Passing it through Redis would force serializing the
 * whole state on every read, which for a normal game costs more than
 * rebuilding it. Each process keeps its own and nothing happens: the state is a
 * pure function of `{definition, decks, seed, actions}`, so two
 * processes compute the same thing without talking to each other.
 */

import type { CardCatalog, DeckInput } from "./cardsim.deck.js";
import { applyAction, replay } from "./cardsim.engine.js";
import type { Action, CardInstance, SessionState } from "./cardsim.engine.js";
import { seedOf } from "./cardsim.seed.js";

/** What the cache needs to know about a session. */
export interface CacheableSession {
  id: string;
  seed: number;
  /** Randomness secret (cardsim.seed.ts); NULL in old games. */
  secretRng?: string | null;
  decks: DeckInput[];
  actions: Action[];
  /** Goes up on undo and on sitting. A different epoch invalidates the prefix. */
  stateEpoch: number;
}

interface Entry {
  epoch: number;
  count: number;
  state: SessionState;
}

function cloneCards(cards: CardInstance[]): CardInstance[] {
  return cards.map((c) => ({
    ...c,
    counters: { ...c.counters },
    knownTo: c.knownTo ? [...c.knownTo] : undefined,
  }));
}

function cloneZones(zones: Record<string, CardInstance[]>): Record<string, CardInstance[]> {
  const out: Record<string, CardInstance[]> = {};
  for (const [id, cards] of Object.entries(zones)) out[id] = cloneCards(cards);
  return out;
}

/**
 * Deep copy of what is MUTABLE. The definition is shared by reference
 * because nobody touches it —and it is the heaviest part of the state—, and so are the
 * log lines: once written they are not rewritten, only added to.
 */
export function cloneState(state: SessionState): SessionState {
  return {
    definition: state.definition,
    players: state.players.map((p) => ({
      ...p,
      resources: { ...p.resources },
      zones: cloneZones(p.zones),
    })),
    board: cloneZones(state.board),
    globals: { ...state.globals },
    turn: state.turn,
    activePlayer: state.activePlayer,
    phaseIndex: state.phaseIndex,
    nextInstanceId: state.nextInstanceId,
    rngCursor: state.rngCursor,
    log: [...state.log],
    result: state.result ? { ...state.result } : null,
    pending: state.pending
      ? {
          ...state.pending,
          candidates: state.pending.candidates ? [...state.pending.candidates] : undefined,
          options: state.pending.options ? [...state.pending.options] : undefined,
        }
      : null,
  };
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Actions that have been applied on top of a cached state. */
  applied: number;
  /** Actions it would have cost to replay from scratch. */
  avoided: number;
}

export class SessionStateCache {
  private readonly entries = new Map<string, Entry>();
  private readonly stats: CacheStats = { hits: 0, misses: 0, applied: 0, avoided: 0 };

  /** Poor man's LRU but enough: `Map` keeps insertion order. */
  constructor(private readonly maxEntries = 250) {}

  /**
   * The state after all of the session's actions.
   *
   * Returns the caller's OWN copy: they can mutate it (apply one more
   * action) without touching what is cached.
   */
  stateFor(
    session: CacheableSession,
    definition: SessionState["definition"],
    catalog: CardCatalog = {}
  ): SessionState {
    const entry = this.entries.get(session.id);
    const usable =
      entry && entry.epoch === session.stateEpoch && entry.count <= session.actions.length;

    let state: SessionState;
    if (usable) {
      // It starts from the cached copy and only the new actions are applied.
      state = cloneState(entry.state);
      const pendingItems = session.actions.slice(entry.count);
      for (const action of pendingItems) applyAction(state, action, seedOf(session));
      this.stats.hits++;
      this.stats.applied += pendingItems.length;
      this.stats.avoided += entry.count;
    } else {
      state = replay(definition, session.decks, seedOf(session), session.actions, catalog);
      this.stats.misses++;
    }

    this.remember(session.id, session.stateEpoch, session.actions.length, state);
    return state;
  }

  /**
   * Stores an already computed state. Called by the action route after
   * applying the play, so the next read does not have to repeat it.
   *
   * It stores a COPY: if it kept the caller's object, the next
   * mutation of that object would rewrite the cache behind its back.
   */
  remember(sessionId: string, epoch: number, count: number, state: SessionState): void {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, { epoch, count, state: cloneState(state) });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Forgets a game. On undo it is called in addition to raising the epoch. */
  forget(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  snapshot(): CacheStats {
    return { ...this.stats };
  }
}
