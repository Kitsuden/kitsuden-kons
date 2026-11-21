/**
 * `@kitsuden/kon-cardsim/arbiter` — the rules arbiter contract
 * ============================================================================
 *
 * The engine keeps the STRUCTURE of a game (zones, secrecy, turns) and players carry out card
 * effects by hand. An arbiter is the optional piece that knows a game's RULES — "one land per
 * turn", "this card draws two when it enters" — and enforces them. Same engine, same log: a room
 * plays free (no arbiter) or with rules (an arbiter), and both kinds coexist.
 *
 * ── HOW IT SITS AT THE TABLE ───────────────────────────────────────────────
 *
 * Like a special seat that sees everything and speaks only through actions:
 *
 *   1. `check` runs BEFORE a player's action is applied, with the full state (it must see hidden
 *      cards to judge them). It may refuse with a reason; nothing enters the log.
 *   2. `after` runs AFTER it is applied and may answer with follow-up actions (a triggered draw,
 *      a forced discard), on behalf of whichever seat they belong to.
 *
 * Follow-ups are recorded as ORDINARY actions. That is the property that matters: a game played
 * with an arbiter replays without it, undo still truncates a list, and the relay and `viewFor`
 * do not change. The arbiter is server-side code (it sees every secret); it never runs in a
 * player's browser.
 *
 * ── WHAT THIS FILE IS, AND IS NOT ──────────────────────────────────────────
 *
 * The contract (`Arbiter`) and a reference runner (`arbitrate`) that applies it to the engine, with
 * the limits that keep a buggy arbiter from looping. Hooking it into `send-action` for rooms that
 * ask for one is the next step; no game ships an arbiter yet.
 */

import { applyAction, CardSimError, type Action, type GameDefinition, type SessionState } from "./cardsim.engine.js";

export interface ArbiterInput {
  definition: GameDefinition;
  /** The full state: hidden cards included. Read-only for the arbiter. */
  state: Readonly<SessionState>;
  /** The action being judged (with its `player` already forced to the acting seat). */
  action: Action;
}

export type ArbiterVerdict = { allow: true } | { allow: false; reason: string };

export interface Arbiter {
  /** Stable id a room refers to (`"onepiece-basic"`). */
  readonly id: string;
  /** The games (cardsim definition ids) it knows the rules of. */
  readonly games: readonly string[];
  /** Before the action: may refuse it. Must not mutate `state`. */
  check(input: ArbiterInput): ArbiterVerdict | Promise<ArbiterVerdict>;
  /** After the action: the actions the rules trigger, in order. Empty when nothing happens. */
  after?(input: ArbiterInput): Action[] | Promise<Action[]>;
}

export class ArbiterRefusal extends Error {
  constructor(
    readonly arbiterId: string,
    readonly reason: string
  ) {
    super(reason);
    this.name = "ArbiterRefusal";
  }
}

/** A rules engine that keeps triggering itself is a bug; it stops here, loudly. */
export const MAX_FOLLOW_UPS = 32;

/**
 * Judges and applies one player's action, then the follow-ups the rules trigger.
 *
 * Returns every action applied, in order — exactly what the server appends to the log. Throws
 * `ArbiterRefusal` (the action was refused: nothing applied) or `CardSimError` (the arbiter asked
 * for something the engine refuses: the arbiter is wrong, and the player's action is NOT left
 * half-done because the caller replays from the stored log on any throw).
 */
export async function arbitrate(
  arbiter: Arbiter,
  input: { definition: GameDefinition; state: SessionState; action: Action; seed: Parameters<typeof applyAction>[2] }
): Promise<Action[]> {
  const { definition, state, seed } = input;
  if (!arbiter.games.includes(definition.id)) {
    throw new ArbiterRefusal(arbiter.id, `This arbiter does not know the rules of ${definition.id}`);
  }

  const verdict = await arbiter.check({ definition, state, action: input.action });
  if (!verdict.allow) throw new ArbiterRefusal(arbiter.id, verdict.reason);

  applyAction(state, input.action, seed);
  const applied: Action[] = [input.action];

  // Breadth-first: what the action triggers, then what those trigger.
  const queue: Action[] = [...((await arbiter.after?.({ definition, state, action: input.action })) ?? [])];
  while (queue.length) {
    if (applied.length > MAX_FOLLOW_UPS) {
      throw new CardSimError(`The arbiter "${arbiter.id}" triggered more than ${MAX_FOLLOW_UPS} actions`);
    }
    const next = queue.shift()!;
    applyAction(state, next, seed);
    applied.push(next);
    queue.push(...((await arbiter.after?.({ definition, state, action: next })) ?? []));
  }
  return applied;
}
