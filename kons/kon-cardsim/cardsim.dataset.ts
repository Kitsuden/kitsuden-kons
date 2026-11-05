import { datasetImageUrl, type DatasetCatalogEntry } from "@kitsuden/shared";

/**
 * A CMS dataset turned into a card catalog
 * ============================================================================
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * `POST /games/:slug/cards` forces sending the whole catalog in the body.
 * That works for a scraper dump, but leaves out the CMS's normal case: the
 * cards are ALREADY in a dataset, edited by the team, with their access
 * control and their history. Copying them to `cardsim_cards` by hand creates two truths
 * that drift apart as soon as someone fixes a typo in only one place.
 *
 * ── WHERE THE DECISION IS ──────────────────────────────────────────────────
 *
 * There is only one that is not mechanical: **what the `cardId` is**.
 *
 * `cardsim_cards.card_id` is the STABLE id that decks reference. If it
 * changes, all saved decks point to nothing. The dataset does not declare
 * which of its fields is that id —there is no "code" field type—, so it is
 * NOT guessed: either whoever syncs says so (`idField`), or the dataset row's
 * id is used, and the response says which of the two happened.
 *
 * Guessing by column name ("if it is called `code` it will be the code") is right
 * sometimes, and being right sometimes with a stable id is worse than always failing: the
 * day it fails there are already decks saved against the previous id.
 */

/** The shape the card import route already consumes. */
export interface CardImport {
  cardId: string;
  name: string;
  imageUrl?: string;
  data: Record<string, unknown>;
}

export interface DatasetCardMapping {
  /** Dataset field that carries the card's stable id. */
  idField?: string | null;
  /** Field declared as an image by the dataset. */
  imageField?: string | null;
}

export interface DatasetCardsResult {
  cards: CardImport[];
  /** Where each `cardId` came from: the requested field or the row id. */
  idSource: string;
  /** Discarded rows and why. A silent import is not auditable. */
  skipped: { entryId: string; reason: string }[];
}

/**
 * Converts a dataset's rows into cards.
 *
 * Pure on purpose: the mapping is what must be testable without a database,
 * and it is where the two errors that matter are —unstable id and duplicates—.
 */
export function cardsFromEntries(
  entries: DatasetCatalogEntry[],
  mapping: DatasetCardMapping = {}
): DatasetCardsResult {
  const { idField, imageField } = mapping;
  const cards: CardImport[] = [];
  const skipped: { entryId: string; reason: string }[] = [];

  /**
   * Duplicates are detected HERE, not in the unique index.
   *
   * A real catalog repeats ids —in Palworld `SOUL-001` comes once for each
   * starter deck— and an import that blows up midway over two identical
   * rows leaves the catalog half-done without saying which ones were.
   */
  const seen = new Map<string, number>();

  for (const entry of entries) {
    const raw = idField ? entry.data[idField] : entry.id;
    const cardId =
      typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";

    if (!cardId) {
      skipped.push({
        entryId: entry.id,
        reason: idField ? `no value in "${idField}"` : "no row id",
      });
      continue;
    }
    if (!entry.title?.trim()) {
      skipped.push({ entryId: entry.id, reason: "no title" });
      continue;
    }

    const prior = seen.get(cardId);
    if (prior !== undefined) {
      // The last one wins, same as in the batch import, but it is reported.
      skipped.push({ entryId: entry.id, reason: `"${cardId}" repeated: replaces the previous one` });
      cards[prior] = build(entry, cardId, imageField);
      continue;
    }

    seen.set(cardId, cards.length);
    cards.push(build(entry, cardId, imageField));
  }

  return { cards, idSource: idField ? `field "${idField}"` : "dataset row id", skipped };
}

function build(entry: DatasetCatalogEntry, cardId: string, imageField?: string | null): CardImport {
  const imageUrl = imageField ? datasetImageUrl(entry.data[imageField]) : null;
  return {
    cardId,
    name: entry.title,
    ...(imageUrl ? { imageUrl } : {}),
    /**
     * The data goes WHOLE. `validateDeck` reads from here the caps per group and
     * per distinct colors, and there is no way to know from this side which field
     * the game definition will use: trimming them breaks deck rules that
     * have not been written yet.
     */
    data: entry.data,
  };
}
