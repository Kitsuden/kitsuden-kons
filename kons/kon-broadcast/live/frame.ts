/**
 * Normalized frame of a MOBA game
 * ============================================================================
 *
 * Everything that comes in —Riot's Live Client Data, a proprietary ingest, or the
 * operator typing— is converted to THIS shape before anything else touches it. The
 * overlay, the panel and the statistics only know the frame; they do not know where
 * it came from.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A PRECISION FIELD AND NOT JUST DATA
 *
 * Riot's official Live Client Data API **does not expose GOLD in spectator
 * mode**. It is not an oversight: Riot decided not to provide it, and products that
 * show exact gold read it from process memory —which its own
 * ToS prohibits—.
 *
 * But it does publish the INVENTORY of all ten players with each item's price.
 * Summing it gives **net worth**, which is exact and is also what is
 * compared live. So the real gap is smaller than it looks:
 * unspent gold is missing, not the material lead.
 *
 * Hence precision is a per-field map and not a global boolean: net worth
 * can be `exact` while gold is `estimated`, and the overlay
 * has to be able to paint each as what it is. Without this, an estimated number
 * and an exact one are painted the same and nobody knows which one they are looking at — neither the
 * operator, nor the caster who will say it aloud.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Side of the map. It is the game's vocabulary, not the bracket's. */
export type TeamSide = "blue" | "red";

/** Where a number came from, and therefore how far whoever paints it can trust it. */
export type Precision =
  /** From the game, as is. */
  | "exact"
  /** Computed from what the API does publish. */
  | "estimated"
  /** Typed by the operator. */
  | "manual"
  /** No data. The overlay must HIDE the widget, not paint a zero. */
  | "unavailable";

export interface LivePlayerFrame {
  /** Position within the team, 0-4. Stable during the game. */
  slot: number;
  team: TeamSide;
  /** Riot ID shown. May have the team tag in front. */
  riotId: string;
  /** Role assigned in the draft: `top`, `jungle`, `mid`, `bot`, `support`. */
  role: string | null;
  /** Stable lowercase slug: `leesin`, `kaisa`. For internal keys. */
  championId: string;
  /**
   * Data Dragon key, in PascalCase: `LeeSin`, `Kaisa`, `MonkeyKing`.
   *
   * It is stored SEPARATELY from the slug because Riot's CDN is case-sensitive and
   * has names that cannot be derived from the displayed name —Wukong is
   * `MonkeyKing`—. It comes from `rawChampionName`, which is internal to the game and does not
   * change with the client language; deriving it from the visible name would fail
   * as soon as someone has the client in French.
   */
  championKey: string;
  championName: string;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  creepScore: number;
  /** Vision. The API gives it as `wardScore`, a composite number. */
  visionScore: number;
  /** Item ids in inventory order. Empty slots are NOT filled in. */
  items: string[];
  summonerSpells: string[];
  isDead: boolean;
  /** Seconds until respawn. 0 if alive. */
  respawnIn: number;
  /**
   * The player's gold ON HAND. `null` when the source does not publish it.
   *
   * `null` and `0` mean very different things live, and that is why they are not
   * collapsed: zero is "has no gold", null is "we don't know".
   */
  gold: number | null;

  /**
   * Net worth: sum of the price of the items they carry.
   *
   * **This IS exact in spectator mode.** The Live Client Data API omits
   * gold, but publishes the inventory of all ten players WITH each item's price
   * (`item.price`). Summing it is not an estimate: it is arithmetic on
   * data the API itself delivers.
   *
   * It is not the same as total gold earned —it lacks what has not been spent and
   * what was sold— but it is what is really compared live: who
   * has more power on the map NOW. A caster says "they have a 3k lead in
   * net worth", not "they have generated 3k more gold since minute 0".
   */
  netWorth: number | null;
}

/** A specific dragon: the type decides the soul taken by whoever reaches four. */
export interface DragonKill {
  /** `infernal`, `ocean`, `cloud`, `mountain`, `hextech`, `chemtech`, `elder`. */
  type: string;
  team: TeamSide;
  /** Game second at which it fell. */
  at: number;
}

export interface TeamObjectives {
  towers: number;
  inhibitors: number;
  barons: number;
  heralds: number;
  /** Crabs/larvae: the name changes per patch, the counter does not. */
  voidgrubs: number;
  dragons: DragonKill[];
}

export interface TeamFrame {
  side: TeamSide;
  players: LivePlayerFrame[];
  objectives: TeamObjectives;
  /** Sum of the team's gold ON HAND, or `null` if the source does not provide it. */
  gold: number | null;
  /** Sum of the team's net worth. Exact if the source publishes items. */
  netWorth: number | null;
  kills: number;
}

/** Game event, already normalized. Feeds the timeline and the chart. */
export interface LiveEvent {
  id: number;
  at: number;
  type:
    | "GameStart"
    | "FirstBlood"
    | "ChampionKill"
    | "Multikill"
    | "Ace"
    | "TurretKilled"
    | "InhibKilled"
    | "DragonKill"
    | "BaronKill"
    | "HeraldKill"
    | "VoidgrubKill"
    | "GameEnd";
  /** Who did it, if applicable. */
  actor?: string;
  victim?: string;
  assisters?: string[];
  team?: TeamSide;
  /** Dragon type, multikill count… the event-specific part. */
  detail?: string;
}

export interface FramePrecisionMap {
  gold: Precision;
  netWorth: Precision;
  items: Precision;
  vision: Precision;
  objectives: Precision;
}

export interface LiveFrame {
  /** Game seconds. It is the clock that is painted. */
  gameTime: number;
  blue: TeamFrame;
  red: TeamFrame;
  events: LiveEvent[];
  precision: FramePrecisionMap;
  /** Id of the adapter that produced the frame. For live diagnosis. */
  source: string;
}

// ── Ingest contract ──────────────────────────────────────────────────────────

/**
 * What an adapter declares it CAN provide.
 *
 * It is declared in advance, not discovered by checking whether a field came back null: the
 * operator's panel has to be able to warn "this source does not provide gold" BEFORE
 * the game starts, not when the caster asks why the widget is missing.
 */
export interface IngestCapabilities {
  gold: boolean;
  /**
   * Can provide the net worth of the ten players.
   *
   * Declared separately from gold because they are different things and availability
   * does NOT go together: the official API omits gold but does publish items with their
   * price, so it gives exact net worth without giving gold.
   */
  netWorth: boolean;
  items: boolean;
  vision: boolean;
  objectives: boolean;
  events: boolean;
  /** Can follow a game as a spectator (not just the player's own). */
  spectator: boolean;
}

export interface IngestAdapter {
  id: string;
  name: string;
  capabilities: IngestCapabilities;
  /**
   * Reads the current state. Returns `null` if there is no game in progress —which is
   * normal between games of a series, not an error.
   */
  poll(options: { signal?: AbortSignal }): Promise<LiveFrame | null>;
}

const adapters = new Map<string, IngestAdapter>();

/**
 * Registers an ingest adapter.
 *
 * It is the extension point that makes this competitive without reimplementing anything:
 * whoever has a better source —memory reading, a production relay,
 * a league's official feed— registers it here and the rest of the kon (overlay,
 * panel, graphics, statistics) works the same without touching a line.
 */
export function registerIngestAdapter(adapter: IngestAdapter): void {
  if (!adapter.id) throw new Error("[moba] an ingest adapter needs `id`");
  if (typeof adapter.poll !== "function") {
    throw new Error(`[moba] adapter "${adapter.id}" does not implement poll()`);
  }
  adapters.set(adapter.id, adapter);
}

export function getIngestAdapter(id: string): IngestAdapter | null {
  return adapters.get(id) ?? null;
}

export function listIngestAdapters(): IngestAdapter[] {
  return [...adapters.values()];
}

/** Empties the registry. For tests. */
export function resetIngestAdapters(): void {
  adapters.clear();
}

// ── Constructors ─────────────────────────────────────────────────────────────

export function emptyObjectives(): TeamObjectives {
  return { towers: 0, inhibitors: 0, barons: 0, heralds: 0, voidgrubs: 0, dragons: [] };
}

export function emptyTeam(side: TeamSide): TeamFrame {
  return {
    side,
    players: [],
    objectives: emptyObjectives(),
    gold: null,
    netWorth: null,
    kills: 0,
  };
}

export function emptyFrame(source: string): LiveFrame {
  return {
    gameTime: 0,
    blue: emptyTeam("blue"),
    red: emptyTeam("red"),
    events: [],
    precision: {
      gold: "unavailable",
      netWorth: "unavailable",
      items: "unavailable",
      vision: "unavailable",
      objectives: "unavailable",
    },
    source,
  };
}
