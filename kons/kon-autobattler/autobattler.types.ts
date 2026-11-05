/**
 * Autobattler — the vocabulary used to DESCRIBE a set
 * ============================================================================
 *
 * As in cardsim: the game is described with data and the engine runs it.
 * Here the game is an autobattler (TFT, Battlegrounds, Underlords) and what is
 * described is a SET: its units, its traits with thresholds, its items and its
 * board.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MAKES THIS DIFFERENT FROM A CARD GAME
 *
 * In a TCG cards move between zones. In an autobattler they do not move:
 * **they combine**, and traits emerge from that combination. Placing nine
 * units is not placing nine cards — it is activating a set of bonuses
 * that no unit has written on it, because they depend on HOW MANY distinct
 * units share each trait.
 *
 * That is why this kon's engine moves nothing: it counts and resolves thresholds.
 * It is a small problem and very easy to get wrong.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** A trait threshold: "with 4 Challengers, silver level". */
export interface TraitTier {
  /** Distinct units needed. */
  min: number;
  /**
   * Tier cap. Riot uses 25000 as "no cap"; it is kept as is so as
   * not to invent a number that then does not match when compared with the source.
   */
  max: number;
  /**
   * Tier color as the game publishes it (1 bronze, 3 silver, 5 gold,
   * 6 prismatic). The number is stored: translating it to a name would be inventing
   * a scale that changes between sets.
   */
  style: number;
  /** Tier values (bonuses), as they come. The engine does not interpret them. */
  variables?: Record<string, unknown>;
}

export interface TraitDefinition {
  id: string;
  name: string;
  description?: string | null;
  /** Sorted from lowest to highest. The engine re-sorts them just in case. */
  tiers: TraitTier[];
  icon?: string | null;
}

export interface UnitDefinition {
  id: string;
  name: string;
  /** Gold cost: it is also the unit's level in the shop. */
  cost: number;
  /** Trait ids. This is where ALL the synergy calculation comes from. */
  traits: string[];
  role?: string | null;
  stats?: Record<string, number> | null;
  ability?: { name?: string; description?: string | null } | null;
  icon?: string | null;
}

export interface ItemDefinition {
  id: string;
  name: string;
  description?: string | null;
  /** Ids of the components that form it. Empty = it is a component. */
  composition: string[];
  /** Only one copy per unit. */
  unique?: boolean;
  tags?: string[];
  icon?: string | null;
}

export interface AugmentDefinition {
  id: string;
  name: string;
  description?: string | null;
  /** Silver/gold/prismatic, if the set publishes it. */
  tier?: string | null;
  icon?: string | null;
}

/**
 * The set's rules. Everything a validator needs to know that changes
 * between games —and sometimes between sets of the same game.
 */
export interface SetRules {
  /** Rows and columns of your own board. In TFT, 4 × 7. */
  boardRows: number;
  boardCols: number;
  /** Items per unit. In TFT, 3. */
  itemsPerUnit: number;
  /** Units on the board by summoner level: `teamSizeByLevel[9] = 9`. */
  teamSizeByLevel: Record<number, number>;
  /** Augments chosen in a game. In TFT, 3. */
  augmentSlots: number;
  /** Unit costs that exist, for validating and for drawing. */
  costs: number[];
}

export interface SetDefinition {
  id: string;
  name: string;
  rules: SetRules;
  units: UnitDefinition[];
  traits: TraitDefinition[];
  items: ItemDefinition[];
  augments: AugmentDefinition[];
}

// ── A composition ────────────────────────────────────────────────────────────

/** A placed unit: what it is, where it is and what it carries. */
export interface CompSlot {
  unitId: string;
  /** 0 = back row… The engine only checks that it falls within the board. */
  row: number;
  col: number;
  /** Item ids. */
  items?: string[];
  /**
   * Traits ADDED to this unit by an emblem.
   *
   * They exist because an emblem changes the synergy count without changing the
   * unit: without this, a comp with an emblem would compute all its traits wrong, which
   * is exactly what people come to look up.
   */
  extraTraits?: string[];
  /**
   * CORE unit: the one you must have for the comp to be that comp.
   *
   * It is an editorial annotation, not something deduced. A unit can be
   * essential for its ability and provide no unusual trait, so
   * computing it from synergies would give the wrong list.
   */
  core?: boolean;
  /** Stars (1-3). It does not affect traits, but it does affect what the comp costs. */
  star?: number;
}

export interface Comp {
  slots: CompSlot[];
  /** Summoner level it is played at. It decides how many units fit. */
  level?: number;
  augments?: string[];
  /**
   * Carousel priority: components in the order they are picked.
   *
   * Not deduced either. It depends on which unit carries the item and which is
   * obtained earlier in the game — information from whoever writes the guide, not from the
   * set. It is stored as an ordered list because the order IS the data.
   */
  carousel?: string[];
}
