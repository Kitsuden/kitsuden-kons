/** What the editor reads from the kon's routes. */

export interface TemplateSummary {
  id: string;
  slug: string | null;
  title: string;
  version: string | null;
}

export interface Tier {
  id: string;
  label: string;
  color?: string | null;
}

export interface Item {
  id: string;
  label: string;
  imageUrl?: string | null;
  sourceRef?: string | null;
}

/** The open list, as the server returns it. */
export interface TierList {
  id: string;
  slug: string | null;
  title: string;
  version: string | null;
  tiers: Tier[];
  items: Item[];
  placement: Record<string, string>;
  manual?: boolean;
  catalogDatasetId?: string | null;
}

export interface Dataset {
  id: string;
  name?: string | null;
  slug?: string | null;
}

export interface SyncResult {
  data?: TierList;
  unranked?: number;
  inCatalog?: number;
  origin?: { dataset: string; imageField: string | null } | null;
}

export interface Change {
  item: Item;
  from: Tier | null;
  to: Tier | null;
}

export interface Diff {
  promoted: Change[];
  demoted: Change[];
  added: Change[];
  removed: Change[];
  unchanged: number;
}
