/**
 * Who answers a conversation: the state machine
 * ============================================================================
 *
 *   bot       a flow or an AI bot answers
 *   queued    nobody yet; it waits for a person
 *   human     one person (assignee_id) answers; the bot is silent
 *   snoozed   nobody until a date, or until the contact writes
 *   resolved  closed; a new message reopens it
 *
 * The transitions are data, not conditionals spread across the code: every change goes through
 * `transition()`, which refuses anything not in TRANSITIONS. The pure part lives here so it can be tested
 * exhaustively; koe.conversations.ts applies it inside one transaction with the row locked, so two people
 * cannot take the same conversation.
 */

import type { ConversationState } from "./koe.schema";

export type Trigger =
  /** The bot or a rule asks for a person (keyword, sensitive intent, low confidence, N failures). */
  | "handoff"
  /** The bot finished the conversation. */
  | "bot_resolved"
  /** A person takes it, or the assigner gives it to someone. */
  | "assign"
  /** Nobody can take it now (out of hours) and the channel lets the bot keep it. */
  | "back_to_bot"
  /** The person hands it back to the bot. */
  | "return_to_bot"
  /** The person lets it go back to the queue (or went offline). */
  | "release"
  | "snooze"
  /** The snooze date came, or the contact wrote. */
  | "wake"
  | "resolve"
  /** A message arrived on a resolved conversation. */
  | "reopen"
  /** Reassign to another person, staying human. */
  | "reassign";

/** For each state, the triggers it accepts and where each leads. `reopen` and `wake` targets depend on settings. */
export const TRANSITIONS: Record<ConversationState, Partial<Record<Trigger, ConversationState[]>>> = {
  bot: { handoff: ["queued"], bot_resolved: ["resolved"], assign: ["human"], resolve: ["resolved"], snooze: ["snoozed"] },
  queued: { assign: ["human"], back_to_bot: ["bot"], resolve: ["resolved"], snooze: ["snoozed"] },
  human: {
    return_to_bot: ["bot"],
    release: ["queued"],
    snooze: ["snoozed"],
    resolve: ["resolved"],
    reassign: ["human"],
  },
  snoozed: { wake: ["human", "queued", "bot"], assign: ["human"], resolve: ["resolved"] },
  resolved: { reopen: ["bot", "queued", "human"], assign: ["human"] },
};

export class TransitionError extends Error {
  constructor(
    readonly from: ConversationState,
    readonly trigger: Trigger,
    readonly to?: ConversationState
  ) {
    super(`A conversation in "${from}" cannot ${trigger.replace(/_/g, " ")}${to ? ` to "${to}"` : ""}`);
    this.name = "TransitionError";
  }
}

export interface TransitionInput {
  from: ConversationState;
  trigger: Trigger;
  /** Required when a trigger has several possible targets (wake, reopen). */
  to?: ConversationState;
  /** Who will answer after `assign`/`reassign`/`wake → human`. */
  assigneeId?: string | null;
  currentAssigneeId?: string | null;
  snoozedUntil?: Date | null;
}

export interface TransitionResult {
  from: ConversationState;
  to: ConversationState;
  assigneeId: string | null;
  snoozedUntil: Date | null;
}

/** The single gate for every change of state. Throws TransitionError for anything not allowed. */
export function transition(input: TransitionInput): TransitionResult {
  const targets = TRANSITIONS[input.from][input.trigger];
  if (!targets) throw new TransitionError(input.from, input.trigger);
  const to = input.to ?? (targets.length === 1 ? targets[0]! : undefined);
  if (!to || !targets.includes(to)) throw new TransitionError(input.from, input.trigger, input.to);

  let assigneeId: string | null = null;
  if (to === "human") {
    assigneeId = input.assigneeId ?? (input.trigger === "wake" || input.trigger === "reopen" ? input.currentAssigneeId ?? null : null);
    if (!assigneeId) throw new TransitionError(input.from, input.trigger, to);
    if (input.trigger === "reassign" && assigneeId === input.currentAssigneeId) throw new TransitionError(input.from, input.trigger, to);
  } else if (to === "snoozed") {
    // Snoozing keeps who had it, so waking returns it to them.
    assigneeId = input.currentAssigneeId ?? null;
  }

  let snoozedUntil: Date | null = null;
  if (to === "snoozed") {
    if (!input.snoozedUntil || input.snoozedUntil.getTime() <= Date.now()) throw new TransitionError(input.from, input.trigger, to);
    snoozedUntil = input.snoozedUntil;
  }
  return { from: input.from, to, assigneeId, snoozedUntil };
}

/** Whether the bot (a flow or an AI bot) may write in a conversation in this state. Checked in send(). */
export function botMaySpeak(state: ConversationState): boolean {
  return state === "bot";
}

/** Every (state, trigger) pair, allowed or not: for exhaustive tests and the docs. */
export const ALL_STATES: ConversationState[] = ["bot", "queued", "human", "snoozed", "resolved"];
export const ALL_TRIGGERS: Trigger[] = [
  "handoff",
  "bot_resolved",
  "assign",
  "back_to_bot",
  "return_to_bot",
  "release",
  "snooze",
  "wake",
  "resolve",
  "reopen",
  "reassign",
];
