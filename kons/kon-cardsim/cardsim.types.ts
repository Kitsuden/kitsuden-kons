/**
 * CardSim — the vocabulary with which a card game is DESCRIBED
 * ============================================================================
 *
 * Everything that distinguishes one TCG from another lives here as DATA. The engine
 * (`cardsim.engine.ts`) knows no game: it knows these types.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LINE THAT IS NOT CROSSED
 *
 * These types describe the STRUCTURE of a game (where the cards are, what
 * is counted, when you lose), never the EFFECT of a specific card. "Draw 2
 * and discard 1" is not modeled: the player executes it by moving cards, as at
 * a real table. Automating card texts forces a scripting language
 * with its sandbox — the pit Tabletop Simulator fell into with Lua.
 *
 * The practical consequence: adding a game is writing a `GameDefinition`,
 * not writing code. And that is why every new field here is OPTIONAL — a
 * definition from a year ago has to stay valid and keep reproducing the
 * same game.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Zones ────────────────────────────────────────────────────────────────────

/**
 * Who sees the cards in a zone. It is THE simulator's secrecy rule.
 *
 * `owner` — only its owner (the hand).
 * `all`   — everyone (the table, the discard pile).
 * `none`  — no one, not even its owner (the deck).
 */
export type ZoneVisibility = "owner" | "all" | "none";

export interface ZoneDefinition {
  id: string;
  name: string;
  visibility: ZoneVisibility;
  /** Does order matter? In a deck yes; on the table, no. */
  ordered?: boolean;
  /**
   * Cap on cards. ATTACHMENTS do not count: an XYZ with 2 materials takes up one
   * monster slot, not three.
   */
  capacity?: number;
  /**
   * Zone of the BOARD, not of a player: Naruto's missions, a shared
   * prize deck. It lives in `state.board`, not in `state.players[n].zones`.
   */
  shared?: boolean;
  /**
   * Numbered, addressable slots (Monster Zone 1-5, Active/Bench).
   * When present, `capacity` is ignored: the cap is the slots.
   */
  slots?: number;
  /** Admits attached cards (energies, materials, equipment). */
  attachable?: boolean;
  /** Cards enter face down (the prize zone of Pokémon-style games). */
  faceDownOnEnter?: boolean;
}

// ── Resources and global state ───────────────────────────────────────────────

export interface ResourceDefinition {
  id: string;
  name: string;
  /** Starting value per player: 20 life, 0 mana. */
  initial: number;
  min?: number;
  max?: number;
}

/**
 * State of the GAME, not of a player: Palworld's day/night cycle, the
 * weather, the round. Without this it would have to be faked as "player 0's
 * resource", and then two players could have different days.
 */
export interface GlobalDefinition {
  id: string;
  name: string;
  initial: string | number | boolean;
  /** If present, `setGlobal` only accepts these values. */
  values?: (string | number | boolean)[];
}

// ── Deck rules ───────────────────────────────────────────────────────────────

/**
 * A real deck is almost never "a list": it is "50 main + 10 souls", or
 * "leader + 50", or "main + extra + side". Each section has its own caps
 * and its own starting zone.
 */
export interface DeckSection {
  id: string;
  name: string;
  /** Zone where these cards start. */
  zone: string;
  minSize: number;
  maxSize: number;
  /** Is it shuffled at the start? Yu-Gi-Oh's Extra Deck is NOT. */
  shuffle?: boolean;
  /** Maximum copies within this section; if missing, `deckRules` rules. */
  maxCopies?: number;
}

/**
 * Cap per GROUP of cards: "max 8 Lucky Pals". It needs to look at a
 * card property, so `validateDeck` accepts a catalog.
 */
export interface GroupLimit {
  name: string;
  /** Property in `cardsim_cards.data` — e.g. `isLucky` or `type`. */
  property: string;
  /** Value that defines the group. If missing, every card with the property "true" counts. */
  value?: string | number | boolean;
  max: number;
}

/**
 * Cap on DISTINCT values: "two colors at most". It cannot be expressed
 * with `GroupLimit` because the limit is not how many cards, but how many
 * distinct values appear.
 */
export interface DistinctLimit {
  name: string;
  property: string;
  max: number;
  /** Values that do not count: Palworld's Colorless is free. */
  ignore?: (string | number)[];
}

export interface DeckRules {
  minSize: number;
  maxSize: number;
  /** Maximum copies of the same card. 4 in Magic, 3 in others. */
  maxCopies: number;
  /**
   * Per-card exceptions. It is the BANLIST and also the "unlimited basic
   * energies": `{"pot-of-greed": 0, "basic-fire": 99}`.
   */
  copyLimits?: Record<string, number>;
  groupLimits?: GroupLimit[];
  distinctLimits?: DistinctLimit[];
}

// ── Game structure ───────────────────────────────────────────────────────────

export interface MulliganRule {
  /** `redraw` = shuffle the hand and draw again. `none` = there is no mulligan. */
  mode: "none" | "redraw";
  /** How many times at most. Palworld and Naruto: 1. */
  maxTimes: number;
  /** Cards fewer on each redraw. 0 in modern games, 1 in the classic mulligan. */
  penalty: number;
}

/**
 * When a player LOSES. Declarative on purpose: if it were code, each
 * game would bring its own and we would be programming games again instead of defining them.
 */
export type LossWhen =
  /** Life at 0. */
  | { kind: "resourceAtOrBelow"; resource: string; value: number }
  /**
   * A resource reaches a cap. Almost always with `ofOpponent`: you lose when
   * the OPPONENT reaches 20 lore (Lorcana) or 8 points (Riftbound).
   *
   * It is needed as the counterpart of `resourceAtOrBelow` because there are two families of
   * games that cannot be expressed with one another: those won by lowering
   * the opponent's life and those won by raising one's own counter.
   */
  | { kind: "resourceAtOrAbove"; resource: string; value: number; ofOpponent?: boolean }
  /** The opponent completed their prizes / battle rewards. */
  | { kind: "zoneAtLeast"; zone: string; count: number; ofOpponent?: boolean }
  /**
   * The zone emptied. With `ofOpponent`, you lose when the OPPONENT empties theirs
   * — which is how games with a prize zone are won: you win by taking the
   * last prize of YOURS, that is, your opponent loses because THEIR zone ran out.
   */
  | { kind: "zoneEmpty"; zone: string; ofOpponent?: boolean }
  /**
   * Being unable to draw. Different from `zoneEmpty`: in Yu-Gi-Oh you lose on ATTEMPTING
   * to draw with no cards, not on reaching zero. Confusing them brings the defeat forward
   * by a whole turn.
   */
  | { kind: "cannotDraw" };

export interface LossCondition {
  id: string;
  name: string;
  when: LossWhen;
}

// ── Macros ───────────────────────────────────────────────────────────────────

/**
 * A macro step.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A MACRO IS AND IS NOT
 *
 * A macro is a **named sequence of things the player could already do by
 * hand**, with the decisions where they belong. "Draw 2 and discard 1" is
 * `draw(2)` + `chooseCards(1 → discard)`. It is the `AUTO-PAY` of Rift Atlas:
 * it automates the paperwork and **keeps showing each step**.
 *
 * What it is NOT: interpreting card text. There is no stack, no priority,
 * no continuous effects, no replacements — none of what turns a card
 * engine into a multi-year project. A badly written macro does not corrupt the game
 * because the player still confirms what happens, and everything stays in the log.
 *
 * Macros live in the DEFINITION, not on the card. That is deliberate: the session
 * stores the definition it was played with, so a replay from a month ago
 * reproduces the macros from a month ago. If they lived in `cardsim_cards`, editing
 * a card would rewrite old games silently.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type MacroStep =
  /** Draw N from one's own deck. */
  | { kind: "draw"; count: number }
  /** Shuffle one of one's own zones. */
  | { kind: "shuffle"; zone: string }
  /** Add or subtract a resource, one's own or the opponent's. */
  | { kind: "resource"; resource: string; delta: number; target?: "self" | "opponent" }
  /** Roll dice or flip a coin. The result goes to the log. */
  | { kind: "roll"; sides: number; count: number; label?: string }
  /** Move N at random between zones. The server chooses, not the player. */
  | {
      kind: "randomMove";
      from: string;
      to: string;
      count: number;
      fromOpponent?: boolean;
      toOpponent?: boolean;
    }
  /** Change the game's global state. */
  | { kind: "setGlobal"; id: string; value: string | number | boolean }
  /** Turn the card that launched the macro. The most repeated cost of all. */
  | { kind: "tapSource"; tapped?: boolean }
  /** Move the card that launched the macro. */
  | { kind: "moveSource"; to: string; toOpponent?: boolean }
  /**
   * Choose N cards from a zone and move them. IT IS the decision.
   *
   * If the zone is not seen by whoever chooses (searching the deck), the candidates are
   * revealed to them and to no one else — it is an implicit `peek`. That is why almost every
   * search macro ends with a `shuffle`, which erases what was seen.
   */
  | {
      kind: "chooseCards";
      prompt: string;
      from: string;
      to: string;
      count: number;
      fromOpponent?: boolean;
      toOpponent?: boolean;
      /** To the bottom, top or at an index of the destination. */
      position?: "top" | "bottom" | number;
      /** Allows choosing FEWER than `count`, even none. */
      upTo?: boolean;
      /** The opponent chooses (forced discard that they pick). */
      by?: "self" | "opponent";
    }
  /** Choose one option from a list (mode, color, number). It stays in the log. */
  | { kind: "chooseOption"; prompt: string; options: string[]; by?: "self" | "opponent" }
  /**
   * Confirm before continuing. With `by: "opponent"` it is Rift Atlas's *showdown assist*:
   * both agree before something is resolved.
   */
  | { kind: "confirm"; prompt: string; by?: "self" | "opponent" }
  /** Leave a line in the log. It does not change the state. */
  | { kind: "note"; text: string };

export interface MacroDefinition {
  id: string;
  name: string;
  /** Text shown on the button / on hover. */
  description?: string;
  steps: MacroStep[];
}

export interface GameDefinition {
  id: string;
  name: string;
  players: { min: number; max: number };
  zones: ZoneDefinition[];
  resources: ResourceDefinition[];
  deckRules: DeckRules;
  /** Zone where the deck starts and from which it is drawn by default. */
  deckZone: string;
  handZone: string;
  /** Cards drawn at the start. */
  openingHand: number;
  /** Turn phases, in order. */
  phases: string[];

  // ── Everything that follows is OPTIONAL: an old definition stays valid ───────

  /** Game state (day/night…). */
  globals?: GlobalDefinition[];
  /** Deck sections. If missing, the deck is a list and starts at `deckZone`. */
  sections?: DeckSection[];
  mulligan?: MulliganRule;
  lossConditions?: LossCondition[];
  /** `random` = the engine draws lots for who starts (Palworld's rock-paper-scissors). */
  firstPlayer?: "seat0" | "random";
  /** Cards created in play (tokens). Referenced by `cardId`. */
  tokens?: { cardId: string; name: string }[];
  /**
   * Game macro library. Cards reference them by id from
   * their `data.macros`, and the interface paints a button for each one.
   *
   * The library belonging to the GAME and not the card is what makes this
   * cheap: most effects are the same handful of patterns ("draw N",
   * "search 1 in the deck", "discard N"), so forty macros cover
   * hundreds of cards.
   */
  macros?: MacroDefinition[];
}
