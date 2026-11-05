/** What the views read from the broadcast routes (only the fields they use). */

export interface ViewContext {
  apiBase?: string;
  theme?: "light" | "dark";
  locale?: string;
  /** Not part of the host's context today; read in case a host passes it. */
  params?: { gameId?: string };
}

export interface Side {
  name: string;
  sponsor: string;
  score: number;
  chars: string[];
  losers: boolean;
  color: string;
}

export type ScreenKey = "versus" | "ko" | "casters";

export interface Match {
  id: string;
  eventTitle: string;
  round: string | null;
  firstTo: number;
  sideA: Side;
  sideB: Side;
  screens?: Partial<Record<ScreenKey, boolean>>;
  fearless: string;
}

export interface DraftStep {
  team: "blue" | "red";
  action: "ban" | "pick";
  index: number;
}

export interface Game {
  id: string;
  matchId: string;
  gameNumber: number;
  status?: string | null;
  sideAFirst: boolean;
  draft?: { current: DraftStep | null; complete: boolean } | null;
}

export interface Classification {
  id: string;
  name: string;
  description?: string;
  games?: { id: string; name: string }[];
}

export interface Adapter {
  id: string;
  name: string;
  capabilities: { gold?: boolean };
}
