/**
 * CardSim — ready-to-use game definitions
 * ============================================================================
 *
 * Seven real games described ONLY with data. There is not a line of code per
 * game: if the engine can handle these seven, it can handle the whole family.
 *
 * They were chosen because each one breaks something different:
 *
 *   · **Palworld** — deck in two sections (50 + 10 souls), cap per group
 *     (8 Lucky), cap on distinct colors, global day/night state and a draw
 *     of lots for who starts.
 *   · **Naruto** — SHARED zone (missions belong to no one) and victory
 *     by accumulating rewards, not by bringing life to zero.
 *   · **Cyberpunk** — attachments: gear and programs go ON TOP of a
 *     unit and follow it wherever it goes.
 *   · **Yu-Gi-Oh** — the hard board case: three sections, numbered
 *     slots, tokens, attached materials and defeat by being unable to draw.
 *   · **One Piece** — resources that are CARDS (the DON!!, which also
 *     attaches) and life that is also face-down cards.
 *   · **Riftbound** — you win by ADDING up to 8, not by going down to zero; and the
 *     battlefields belong to the board.
 *   · **Lorcana** — the inkwell: face-down cards that stop being what
 *     they were, and victory at 20 lore.
 *
 * The last three are the ones that brought `resourceAtOrAbove` to the engine: without it
 * there is no way to express games won by raising a counter.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ABOUT THE NUMBERS
 *
 * Deck caps and colors come from the published rules. The board slots
 * of newly released games (Palworld, Naruto, Cyberpunk,
 * Riftbound) are a reading of the playmat of their simulators, not a cited
 * rulebook: if the official one says otherwise, the number is changed and that's it — it is
 * data, not code, and no saved game breaks because sessions
 * store the definition they were played with.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { GameDefinition } from "./cardsim.types.js";

/**
 * Palworld OFFICIAL CARD GAME (Bushiroad).
 * Deck: 50 main + 10 souls · 4 copies per name · max. 2 colors
 * (Colorless free) · max. 8 Lucky Pals.
 */
export const PALWORLD_TCG: GameDefinition = {
  id: "palworld-tcg",
  name: "Palworld OFFICIAL CARD GAME",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "soulDeck", name: "Souls Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    // Souls in play are public and are turned to pay ("TAP 3 SOUL: DRAW 1").
    { id: "soul", name: "Souls", visibility: "all" },
    { id: "field", name: "Field", visibility: "all", slots: 5, attachable: true },
    { id: "structures", name: "Structures and gear", visibility: "all", slots: 4 },
    { id: "grave", name: "Graveyard", visibility: "all" },
    { id: "exile", name: "Exilio", visibility: "all" },
  ],
  resources: [
    { id: "hp", name: "HP", initial: 10, min: 0, max: 10 },
    { id: "wood", name: "Madera", initial: 0, min: 0 },
    { id: "fruit", name: "Fruit", initial: 0, min: 0 },
  ],
  globals: [
    // Day/night belongs to the GAME, not to a player: if it were a resource, the
    // two sides could be at different moments of the cycle.
    { id: "cycle", name: "Cycle", initial: "day", values: ["day", "night"] },
  ],
  sections: [
    { id: "main", name: "Main deck", zone: "deck", minSize: 50, maxSize: 50, shuffle: true },
    {
      id: "soul",
      name: "Souls Deck",
      zone: "soulDeck",
      minSize: 10,
      maxSize: 10,
      shuffle: true,
    },
  ],
  deckRules: {
    minSize: 50,
    maxSize: 50,
    maxCopies: 4,
    groupLimits: [{ name: "Pals Lucky", property: "isLucky", value: true, max: 8 }],
    distinctLimits: [{ name: "Colors", property: "colors", max: 2, ignore: ["Colorless"] }],
  },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["Stand", "Draw", "Work", "Main", "Attack", "End"],
  mulligan: { mode: "redraw", maxTimes: 1, penalty: 0 },
  // The official simulator's rock-paper-scissors: who starts is chance, and the
  // server's chance is the only one that cannot be rigged.
  firstPlayer: "random",
  lossConditions: [
    {
      id: "hp",
      name: "runs out of HP",
      when: { kind: "resourceAtOrBelow", resource: "hp", value: 0 },
    },
    { id: "deckout", name: "cannot draw", when: { kind: "cannotDraw" } },
  ],
};

/**
 * NARUTO CARD GAME (Bandai).
 * Leader + 50 cards · 4 copies per name. MISSIONS belong to the board: they are
 * contested by both, so they live in a shared zone.
 */
export const NARUTO_CARD_GAME: GameDefinition = {
  id: "naruto-cardgame",
  name: "NARUTO CARD GAME",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    { id: "leader", name: "Leader", visibility: "all", capacity: 1 },
    { id: "battleLine", name: "Battle line", visibility: "all", slots: 5, attachable: true },
    // Chakra is cards placed face up that are turned to pay: it is a
    // zone, not a counter — you can look at how many are ready.
    { id: "chakra", name: "Chakra", visibility: "all" },
    { id: "missions", name: "Misiones", visibility: "all", shared: true, slots: 3 },
    { id: "rewards", name: "Recompensas", visibility: "all" },
    { id: "trash", name: "Discard", visibility: "all" },
  ],
  resources: [],
  sections: [
    { id: "leader", name: "Leader", zone: "leader", minSize: 1, maxSize: 1, shuffle: false },
    { id: "main", name: "Main deck", zone: "deck", minSize: 50, maxSize: 50, shuffle: true },
  ],
  deckRules: { minSize: 50, maxSize: 50, maxCopies: 4 },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["Ready", "Draw", "Chakra", "Main", "Battle", "End"],
  mulligan: { mode: "redraw", maxTimes: 1, penalty: 0 },
  firstPlayer: "random",
  lossConditions: [
    // You win by COMPLETING missions: you lose when the opponent collects their three
    // rewards. Written the right way round, the message comes out on the correct player.
    {
      id: "rewards",
      name: "the opponent completed their rewards",
      when: { kind: "zoneAtLeast", zone: "rewards", count: 3, ofOpponent: true },
    },
    { id: "deckout", name: "cannot draw", when: { kind: "cannotDraw" } },
  ],
};

/**
 * Cyberpunk 2077 TCG.
 * Legend + 50-card deck · one color · gear and programs ATTACH to
 * units and follow them wherever they go.
 */
export const CYBERPUNK_TCG: GameDefinition = {
  id: "cyberpunk-tcg",
  name: "Cyberpunk 2077 TCG",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    { id: "legend", name: "Legend", visibility: "all", capacity: 1, attachable: true },
    { id: "units", name: "Units", visibility: "all", slots: 6, attachable: true },
    { id: "resources", name: "Resources", visibility: "all" },
    { id: "trash", name: "Trash", visibility: "all" },
  ],
  resources: [{ id: "streetCred", name: "Street Cred", initial: 0, min: 0 }],
  sections: [
    { id: "legend", name: "Legend", zone: "legend", minSize: 1, maxSize: 1, shuffle: false },
    { id: "main", name: "Main deck", zone: "deck", minSize: 50, maxSize: 50, shuffle: true },
  ],
  deckRules: {
    minSize: 50,
    maxSize: 50,
    maxCopies: 4,
    distinctLimits: [{ name: "Colors", property: "colors", max: 1 }],
  },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["Ready", "Draw", "Resource", "Main", "Combat", "End"],
  mulligan: { mode: "redraw", maxTimes: 1, penalty: 0 },
  firstPlayer: "random",
  lossConditions: [{ id: "deckout", name: "cannot draw", when: { kind: "cannotDraw" } }],
};

/**
 * Yu-Gi-Oh! — the board that Duelingbook makes.
 *
 * It is the most demanding preset and that is why it is here: three deck sections, five
 * numbered monster slots, attached materials, tokens and defeat by being unable
 * to draw. If something in the engine fell short, it would show here first.
 *
 * `copyLimits` IS the banlist: `{"pot-of-greed": 0}` bans, `1` limits. A new
 * format (Goat, Edison, Speed) is this same definition with another map.
 */
export const YUGIOH_ADVANCED: GameDefinition = {
  id: "yugioh-advanced",
  name: "Yu-Gi-Oh! (Advanced)",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "extra", name: "Extra Deck", visibility: "none", ordered: true },
    // The side deck is NOT in play: it is not seen, not drawn from, and between games it is
    // swapped with the main. Modeling it as a zone leaves it where it belongs.
    { id: "side", name: "Side Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    { id: "monsters", name: "Monster Zone", visibility: "all", slots: 5, attachable: true },
    { id: "spells", name: "Spell & Trap Zone", visibility: "all", slots: 5, attachable: true },
    { id: "field", name: "Field Zone", visibility: "all", capacity: 1 },
    { id: "pendulum", name: "Pendulum Zone", visibility: "all", slots: 2 },
    { id: "graveyard", name: "Graveyard", visibility: "all" },
    { id: "banished", name: "Banished", visibility: "all" },
  ],
  resources: [{ id: "lp", name: "Life Points", initial: 8000, min: 0 }],
  sections: [
    { id: "main", name: "Main Deck", zone: "deck", minSize: 40, maxSize: 60, shuffle: true },
    // The Extra Deck is not shuffled: it is looked at in full when needed.
    { id: "extra", name: "Extra Deck", zone: "extra", minSize: 0, maxSize: 15, shuffle: false },
    { id: "side", name: "Side Deck", zone: "side", minSize: 0, maxSize: 15, shuffle: false },
  ],
  deckRules: { minSize: 40, maxSize: 60, maxCopies: 3 },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["Draw", "Standby", "Main 1", "Battle", "Main 2", "End"],
  mulligan: { mode: "none", maxTimes: 0, penalty: 0 },
  firstPlayer: "random",
  tokens: [{ cardId: "token", name: "Token" }],
  lossConditions: [
    {
      id: "lp",
      name: "their Life Points reach 0",
      when: { kind: "resourceAtOrBelow", resource: "lp", value: 0 },
    },
    { id: "deckout", name: "cannot draw", when: { kind: "cannotDraw" } },
  ],
};

/**
 * ONE PIECE CARD GAME (Bandai).
 *
 * The game that forces modeling the DON!! as a separate deck: it is not a counter,
 * it is ten cards that are raised, turned to pay and ATTACHED to a
 * character to give it power. A number could not be attached to anything.
 *
 * Life is also face-down cards: on taking damage, one goes to the hand
 * —that is why `faceDownOnEnter` and why damage is a macro, not a resource.
 */
export const ONEPIECE_CARD_GAME: GameDefinition = {
  id: "onepiece-cardgame",
  name: "ONE PIECE CARD GAME",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "donDeck", name: "DON!! Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    { id: "leader", name: "Leader", visibility: "all", capacity: 1, attachable: true },
    { id: "characters", name: "Character area", visibility: "all", slots: 5, attachable: true },
    { id: "stage", name: "Stage", visibility: "all", capacity: 1 },
    // The DON!! in play: it is turned to pay and attached to give +1000.
    { id: "cost", name: "Cost area", visibility: "all" },
    // Life is face-down CARDS: on taking damage, one goes to the hand.
    { id: "life", name: "Life", visibility: "owner", ordered: true, faceDownOnEnter: true },
    { id: "trash", name: "Discard", visibility: "all" },
  ],
  resources: [],
  sections: [
    { id: "leader", name: "Leader", zone: "leader", minSize: 1, maxSize: 1, shuffle: false },
    { id: "main", name: "Main deck", zone: "deck", minSize: 50, maxSize: 50, shuffle: true },
    // The ten DON!! are ten copies of the SAME card, so the general
    // cap of 4 cannot be applied here or no legal deck would pass.
    {
      id: "don",
      name: "DON!! Deck",
      zone: "donDeck",
      minSize: 10,
      maxSize: 10,
      shuffle: false,
      maxCopies: 10,
    },
  ],
  deckRules: {
    minSize: 50,
    maxSize: 50,
    maxCopies: 4,
    // The real rule is "of your leader's color". The engine cannot look at ANOTHER
    // card to validate the deck, but the cap of 2 is its consequence: there are no
    // leaders of more than two colors, so a three-color deck is certainly illegal.
    distinctLimits: [{ name: "Colors", property: "colors", max: 2 }],
  },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["Refresh", "DON!!", "Main", "Battle", "End"],
  mulligan: { mode: "redraw", maxTimes: 1, penalty: 0 },
  firstPlayer: "random",
  lossConditions: [{ id: "deckout", name: "cannot draw", when: { kind: "cannotDraw" } }],
  macros: [
    {
      id: "don-2",
      name: "Raise 2 DON!!",
      description: "Each turn's DON!!: two cards from the DON!! deck to the cost area.",
      steps: [
        {
          kind: "chooseCards",
          prompt: "Raises 2 DON!!",
          from: "donDeck",
          to: "cost",
          count: 2,
          upTo: true,
        },
      ],
    },
    {
      id: "damage",
      name: "Take 1 damage",
      description: "A life card goes to your hand. If none remain, the game is decided.",
      steps: [
        {
          kind: "chooseCards",
          prompt: "Takes the life card",
          from: "life",
          to: "hand",
          count: 1,
          position: "top",
        },
      ],
    },
    {
      id: "trash-1-draw-1",
      name: "Discard 1 and draw 1",
      steps: [
        { kind: "chooseCards", prompt: "Discard 1", from: "hand", to: "trash", count: 1 },
        { kind: "draw", count: 1 },
      ],
    },
  ],
};

/**
 * Riftbound: League of Legends TCG (Riot).
 *
 * The BATTLEFIELDS belong to the board, not to anyone: they are contested, and whoever
 * holds them scores. It is the same case as Naruto's missions and that is why they go in
 * a `shared` zone.
 *
 * And you win by ADDING: at 8 points. That is why `resourceAtOrAbove` exists — with only
 * "whoever drops to 0 loses" there would be no way to express this family of games.
 */
export const RIFTBOUND_TCG: GameDefinition = {
  id: "riftbound-tcg",
  name: "Riftbound: League of Legends TCG",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "runeDeck", name: "Rune deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    { id: "legend", name: "Legend", visibility: "all", capacity: 1 },
    { id: "champion", name: "Champion", visibility: "all", capacity: 1, attachable: true },
    { id: "base", name: "Base", visibility: "all", slots: 8, attachable: true },
    { id: "battlefields", name: "Battlefields", visibility: "all", shared: true, slots: 3 },
    { id: "runes", name: "Runes in play", visibility: "all" },
    { id: "trash", name: "Graveyard", visibility: "all" },
  ],
  resources: [{ id: "points", name: "Points", initial: 0, min: 0, max: 8 }],
  sections: [
    { id: "legend", name: "Legend", zone: "legend", minSize: 1, maxSize: 1, shuffle: false },
    { id: "main", name: "Main deck", zone: "deck", minSize: 40, maxSize: 60, shuffle: true },
    // A rune deck can be the same rune twelve times, so the general
    // cap of 3 does not apply to it.
    {
      id: "runes",
      name: "Rune deck",
      zone: "runeDeck",
      minSize: 12,
      maxSize: 12,
      shuffle: true,
      maxCopies: 12,
    },
  ],
  deckRules: {
    minSize: 40,
    maxSize: 60,
    maxCopies: 3,
    // Same case as One Piece: the rule looks at the legend, which the validator
    // cannot consult. The cap of 2 domains is its consequence, and
    // colorless cards do not count.
    distinctLimits: [{ name: "Domains", property: "colors", max: 2, ignore: ["Colorless"] }],
  },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["Awaken", "Draw", "Channel", "Action", "Showdown", "End"],
  mulligan: { mode: "redraw", maxTimes: 1, penalty: 0 },
  firstPlayer: "random",
  lossConditions: [
    {
      id: "points",
      name: "the opponent reached 8 points",
      when: { kind: "resourceAtOrAbove", resource: "points", value: 8, ofOpponent: true },
    },
    { id: "deckout", name: "cannot draw", when: { kind: "cannotDraw" } },
  ],
  macros: [
    {
      id: "channel-rune",
      name: "Channel a rune",
      description: "A rune from the rune deck goes into play.",
      steps: [
        {
          kind: "chooseCards",
          prompt: "Channels a rune",
          from: "runeDeck",
          to: "runes",
          count: 1,
          position: "top",
        },
      ],
    },
    {
      id: "score-1",
      name: "Score 1",
      steps: [{ kind: "resource", resource: "points", delta: 1 }],
    },
    {
      id: "showdown",
      name: "Agree on the order of the showdown",
      description: "The showdown assistant: both confirm before resolving.",
      steps: [
        { kind: "confirm", prompt: "Do you agree with the showdown order?", by: "opponent" },
        { kind: "note", text: "showdown order agreed by both" },
      ],
    },
  ],
};

/**
 * Disney Lorcana (Ravensburger).
 *
 * The INKWELL is what has to be modeled well: any card with the border
 * marked can be played FACE DOWN as ink. It is its own zone, face down
 * (`faceDownOnEnter`), and that is why putting it there is a macro and not just any
 * move — the card stops being what it was.
 *
 * You win by reaching 20 lore, so it also uses `resourceAtOrAbove`.
 */
export const LORCANA: GameDefinition = {
  id: "lorcana",
  name: "Disney Lorcana",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    // Ink goes face down: you see HOW MUCH you have, not which cards it came from.
    { id: "inkwell", name: "Tintero", visibility: "owner", faceDownOnEnter: true },
    { id: "play", name: "In play", visibility: "all", attachable: true },
    { id: "discard", name: "Discard", visibility: "all" },
  ],
  resources: [{ id: "lore", name: "Lore", initial: 0, min: 0, max: 20 }],
  deckRules: {
    minSize: 60,
    maxSize: 200,
    maxCopies: 4,
    distinctLimits: [{ name: "Tintas", property: "colors", max: 2 }],
  },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 7,
  phases: ["Ready", "Set", "Draw", "Main"],
  // Lorcana lets you change the opening hand once. The engine redoes it entirely,
  // which is the normal case; returning only some is a manual `chooseCards`.
  mulligan: { mode: "redraw", maxTimes: 1, penalty: 0 },
  firstPlayer: "random",
  lossConditions: [
    {
      id: "lore",
      name: "the opponent reached 20 lore",
      when: { kind: "resourceAtOrAbove", resource: "lore", value: 20, ofOpponent: true },
    },
    { id: "deckout", name: "cannot draw", when: { kind: "cannotDraw" } },
  ],
  macros: [
    {
      id: "ink",
      name: "Put a card in the inkwell",
      description: "The most repeated play of each turn: a card from the hand becomes ink.",
      steps: [
        {
          kind: "chooseCards",
          prompt: "Which card do you put in the inkwell?",
          from: "hand",
          to: "inkwell",
          count: 1,
        },
      ],
    },
    {
      id: "quest",
      name: "Quest: gain lore",
      description: "Exert a character and add its lore. The value is chosen from the list.",
      steps: [
        { kind: "tapSource" },
        { kind: "chooseOption", prompt: "How much lore?", options: ["1", "2", "3", "4"] },
        { kind: "note", text: "quest completed" },
      ],
    },
    {
      id: "lore-1",
      name: "+1 lore",
      steps: [{ kind: "resource", resource: "lore", delta: 1 }],
    },
    {
      id: "draw-discard",
      name: "Draw 1 and discard 1",
      steps: [
        { kind: "draw", count: 1 },
        { kind: "chooseCards", prompt: "Discard 1", from: "hand", to: "discard", count: 1 },
      ],
    },
  ],
};

export const PRESETS: Record<string, GameDefinition> = {
  [PALWORLD_TCG.id]: PALWORLD_TCG,
  [NARUTO_CARD_GAME.id]: NARUTO_CARD_GAME,
  [CYBERPUNK_TCG.id]: CYBERPUNK_TCG,
  [YUGIOH_ADVANCED.id]: YUGIOH_ADVANCED,
  [ONEPIECE_CARD_GAME.id]: ONEPIECE_CARD_GAME,
  [RIFTBOUND_TCG.id]: RIFTBOUND_TCG,
  [LORCANA.id]: LORCANA,
};
