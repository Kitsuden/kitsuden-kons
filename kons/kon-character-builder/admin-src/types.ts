/** The shapes the view reads from and sends to the kon's routes (see operations.ts and the engine). */

/** Where a slot's options come from: a dataset, and which of its columns feed which stat. */
export interface OptionsFrom {
  datasetId: string;
  idField?: string | null;
  costField?: string | null;
  /** column → stat */
  statFields: Record<string, string>;
  [key: string]: unknown;
}

export interface Slot {
  id: string;
  name: string;
  capacity: number;
  options: unknown[];
  optionsFrom?: OptionsFrom;
  [key: string]: unknown;
}

export interface Budget {
  id: string;
  name: string;
  total: number;
  slots: string[];
  [key: string]: unknown;
}

/** `{name, formula}` is what kon-formulas compiles. */
export interface Derived {
  name: string;
  formula: string;
}

export interface Definition {
  id: string;
  name: string;
  baseStats: Record<string, number>;
  slots: Slot[];
  budgets: Budget[];
  derived: Derived[];
  [key: string]: unknown;
}

export interface DefinitionSummary {
  id: string;
  slug: string;
  name: string;
  published: string;
}

export interface DatasetField {
  name?: string;
  key?: string;
}

export interface Dataset {
  id: string;
  name?: string;
  slug?: string;
  schema?: DatasetField[] | unknown;
}
