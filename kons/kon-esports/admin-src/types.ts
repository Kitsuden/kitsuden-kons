/** What the routes the booth calls return, as far as the booth reads them. */

export type BracketFormat = "single_elimination" | "double_elimination" | "swiss" | "round_robin";

export interface TournamentItem {
  id: string;
  title: string;
  /** 1v1, 2v2…: the list does not carry `bracketFormat`. */
  format?: string | null;
  status?: string | null;
}

export interface TournamentRecord {
  bracketFormat?: BracketFormat | null;
  status?: string | null;
  participants?: {
    id: string;
    player?: { alias?: string | null; country?: string | null } | null;
    team?: { name?: string | null } | null;
  }[];
}

export interface NameEntry {
  name: string;
  country?: string | null;
}

export interface CheckIn {
  state: "disabled" | "scheduled" | "open" | "closed" | string;
  /** Seconds until it opens or closes, by the server's clock. */
  countdown: number | null;
  summary: {
    checkedIn: number;
    total: number;
    missingIds?: string[];
    checkedInIds?: string[];
  };
}

export interface ResolvePlan {
  plan: { participantIds: string[]; remaining: number };
}

export interface Phase {
  id: string;
  name: string;
  groups?: number;
  status: "pending" | "active" | "complete" | string;
}

export interface Station {
  id: string;
  name: string;
  kind: "physical" | "lobby" | string;
  accessDetails?: string | null;
}

/** A real row of `esports_matches`: where station and stream queue live. */
export interface MatchRow {
  id: string;
  bracketMatchId?: string | null;
  participant1Id?: string | null;
  participant2Id?: string | null;
  winnerId?: string | null;
  status?: string | null;
  stationId?: string | null;
  streamQueuePosition?: number | null;
}

/** A set as the bracket draws it: `id` is the slot ("W1M1"), `rowId` the real row. */
export interface BracketSet {
  id: string;
  rowId?: string | null;
  participants: (string | null | undefined)[];
  winnerId?: string | null;
  status?: string | null;
}

export interface Bracket {
  winners?: BracketSet[];
  losers?: BracketSet[];
  grandFinal?: BracketSet[];
  names?: Record<string, NameEntry>;
  standings?: AliveRow[];
}

/** Who is still alive: not a ranking, there is no placement. */
export interface AliveRow {
  participantId: string;
  name?: string | null;
  losses: number;
  status: "champion" | "active" | "eliminated" | string;
}

export interface SwissStanding {
  place?: number;
  participantId: string;
  record?: { wins?: number; losses?: number; draws?: number; points?: number };
  omw?: number;
}

export interface SwissState {
  round: number;
  totalRounds: number;
  complete: boolean;
  standings?: SwissStanding[];
}

export interface EvidenceItem {
  url?: string | null;
  trusted?: boolean;
  caption?: string | null;
}

export interface Dispute {
  matchId: string;
  bracketMatchId?: string | null;
  reconciliation?: { conflict?: string | null } | null;
  reports?: { reportedBy: string; winnerId: string; scores?: [number, number] | null }[];
  evidence?: { reportedBy: string; items?: EvidenceItem[] }[];
}

/** Something the server said that stays on screen until the TO dismisses it. */
export interface Notice {
  variant: "info" | "warning";
  title: string;
  text: string;
}
