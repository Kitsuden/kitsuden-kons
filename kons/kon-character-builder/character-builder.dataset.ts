/**
 * `DatasetCatalogEntry` and NOT `DatasetEntry`.
 *
 * Two types with that name coexist in `@kitsuden/shared` and the barrel
 * disambiguates them: `DatasetEntry` is the one inferred from Zod (the raw row, with
 * `datasetId` and WITHOUT `title`) and `DatasetCatalogEntry` is the catalog one, which does
 * have it. Here `entry.title` is read for the option name, so it is
 * the second one; with the other, `title` does not exist and the mapping does not compile.
 */
import { datasetImageUrl, datasetNumber, type DatasetCatalogEntry } from "@kitsuden/shared";

import type {
  BuilderDefinition,
  Modifier,
  SlotDefinition,
  SlotOption,
} from "./character-builder.engine.js";

/**
 * A slot's options come from a CMS dataset
 * ============================================================================
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────
 *
 * `builder_definitions.definition` stores the options INLINE. For a game
 * with four weapons that is fine; for one with three hundred items it means the
 * whole catalog lives inside a JSON document that has to be rewritten
 * every patch, with no per-row history and with nobody able to edit one item
 * without touching the whole builder definition.
 *
 * And that catalog is usually already in a dataset, edited by the team, with its
 * access control. Duplicating it means having two truths.
 *
 * ── WHAT MUST BE DECLARED ──────────────────────────────────────────────────
 *
 * A dataset stores fields; a builder needs MODIFIERS. Nobody can deduce
 * that the dataset's `attack` column feeds the formulas' `atk_flat` stat:
 * they are two different vocabularies and only the author knows them.
 *
 * That is why `statFields` is an EXPLICIT field → stat map. Guessing by name
 * would give builds with plausible but wrong numbers, which is the worst possible
 * result in a tool whose only job is to calculate correctly.
 */

export interface DatasetOptionSource {
  /** Dataset this slot's options come from. */
  datasetId: string;
  /**
   * Field with the option's stable id. Without it, the row id.
   *
   * It is what users' builds store: changing it leaves everything already
   * saved pointing at nothing.
   */
  idField?: string | null;
  /** Field with the cost against the budget (talent points, level…). */
  costField?: string | null;
  /** Dataset field → input stat it modifies. `{ attack: "atk_flat" }` */
  statFields: Record<string, string>;
  /**
   * Field that groups the slot's options: at most one per group (see
   * `SlotOption.group`). `"part"` in armor: one helmet, one chest piece…
   */
  groupField?: string | null;
  /**
   * Only the rows whose field has that value: `{ va_en: "Armadura" }`. This way two slots
   * can come from the same dataset without sharing options (weapon jewels and
   * armor jewels), which is what `compileBuilder` requires.
   */
  where?: Record<string, string> | null;
}

/** A slot can bring its options from a dataset in addition to the hand-written ones. */
export type SlotWithDataset = SlotDefinition & { optionsFrom?: DatasetOptionSource };

export interface MappedOptions {
  options: SlotOption[];
  /** Discarded rows with their reason: a missing option must be explainable. */
  skipped: { entryId: string; reason: string }[];
}

/**
 * Converts dataset rows into slot options.
 *
 * Pure: it is where the errors that matter are (unstable id, number that is
 * not a number) and they must be testable without a database.
 */
export function optionsFromEntries(
  entries: DatasetCatalogEntry[],
  source: DatasetOptionSource,
  /**
   * Catalog image field (`readDatasetCatalog` → `imageField`). Without
   * it, a builder with three hundred options is a list of names.
   */
  imageField: string | null = null
): MappedOptions {
  const options: SlotOption[] = [];
  const skipped: { entryId: string; reason: string }[] = [];
  const seen = new Set<string>();

  const conditions = Object.entries(source.where ?? {});

  for (const entry of entries) {
    // Outside this slot: not a discard, it belongs to another (it does not go to `skipped`)
    if (conditions.some(([fieldValue, valueValue]) => String(entry.data[fieldValue] ?? "").trim() !== valueValue))
      continue;

    const raw = source.idField ? entry.data[source.idField] : entry.id;
    const id = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";

    if (!id) {
      skipped.push({
        entryId: entry.id,
        reason: source.idField ? `no value in "${source.idField}"` : "no row id",
      });
      continue;
    }
    /**
     * A repeated id is NOT collapsed here: `compileBuilder` throws "the option
     * is in two slots" and that error is correct and must be seen. What is
     * avoided is duplicating it WITHIN the same slot, which would only produce a list
     * with the same entry twice.
     */
    if (seen.has(id)) {
      skipped.push({ entryId: entry.id, reason: `"${id}" repeated in the same slot` });
      continue;
    }
    seen.add(id);

    const modifiers: Modifier[] = [];
    for (const [field, stat] of Object.entries(source.statFields)) {
      const value = datasetNumber(entry.data[field]);
      /**
       * An empty field means "this option does not touch that stat", not zero.
       * Adding zeros would fill every option with inert modifiers and make any
       * explanation of why a build adds up to what it does unreadable.
       */
      if (value !== undefined && value !== 0) modifiers.push({ stat, value });
    }

    const cost = source.costField ? datasetNumber(entry.data[source.costField]) : undefined;
    const imageUrl = imageField ? datasetImageUrl(entry.data[imageField]) : null;
    const rawGroup = source.groupField ? entry.data[source.groupField] : undefined;
    const group =
      typeof rawGroup === "string" || typeof rawGroup === "number"
        ? String(rawGroup).trim()
        : "";

    options.push({
      id,
      name: entry.title,
      modifiers,
      ...(cost !== undefined ? { cost } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(group ? { group } : {}),
    });
  }

  return { options, skipped };
}

/**
 * Returns the definition with the dataset options already inserted.
 *
 * Dataset ones go AFTER the hand-written ones: if an id matches, the inline one wins.
 * That lets you fix a wrongly entered dataset row by hand without
 * having to fix the dataset first, and it is the least surprising direction
 * (the specific wins over the general).
 */
export function withDatasetOptions(
  definition: BuilderDefinition,
  resolved: Map<string, SlotOption[]>
): BuilderDefinition {
  if (!resolved.size) return definition;
  return {
    ...definition,
    slots: definition.slots.map((slot) => {
      const extra = resolved.get(slot.id);
      if (!extra?.length) return slot;
      const inline = new Set(slot.options.map((o) => o.id));
      return { ...slot, options: [...slot.options, ...extra.filter((o) => !inline.has(o.id))] };
    }),
  };
}

/** The slots that declare a dataset origin. */
export function datasetSlots(definition: BuilderDefinition): SlotWithDataset[] {
  return (definition.slots as SlotWithDataset[]).filter((s) => s.optionsFrom?.datasetId);
}
