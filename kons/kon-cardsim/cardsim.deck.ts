/**
 * CardSim — validation of definitions and decks
 * ============================================================================
 *
 * It is separated from the engine because it runs at a DIFFERENT moment and with a different
 * cost of error: the definition is validated when PUBLISHING the game and the deck when SAVING it,
 * not in the middle of a game. Finding out your deck is illegal with the opponent
 * waiting at the table is the worst possible way to find out.
 */

import type { DeckSection, DistinctLimit, GameDefinition, GroupLimit } from "./cardsim.types.js";

/** Card properties by `cardId` — what is in `cardsim_cards.data`. */
export type CardCatalog = Record<string, Record<string, unknown>>;

/**
 * A deck is a map of sections. A bare list is also accepted because
 * most games have a single section and because sessions saved
 * before sections existed must keep replaying the same.
 */
export type DeckInput = string[] | Record<string, string[]>;

/**
 * The sections of a game that does not declare them: just one, the whole deck, in
 * `deckZone`. Having it centralized keeps the engine and the validator from disagreeing
 * about where the cards start.
 */
export function sectionsOf(def: GameDefinition): DeckSection[] {
  if (def.sections?.length) return def.sections;
  return [
    {
      id: "main",
      name: "Deck",
      zone: def.deckZone,
      minSize: def.deckRules.minSize,
      maxSize: def.deckRules.maxSize,
      shuffle: true,
    },
  ];
}

/** The section that IS the deck: it is drawn from and `openingHand` points to it. */
export function mainSectionOf(def: GameDefinition): DeckSection {
  const sections = sectionsOf(def);
  return sections.find((s) => s.zone === def.deckZone) ?? sections[0];
}

/** Bare list → map of sections. A list is always the main section. */
export function normalizeDeck(def: GameDefinition, deck: DeckInput): Record<string, string[]> {
  if (Array.isArray(deck)) return { [mainSectionOf(def).id]: deck };
  return deck;
}

// ── Definition ───────────────────────────────────────────────────────────────

export function validateGameDefinition(def: GameDefinition): string[] {
  const errors: string[] = [];
  const zoneIds = new Set<string>();

  for (const zone of def.zones) {
    if (zoneIds.has(zone.id)) errors.push(`Duplicate zone: "${zone.id}"`);
    zoneIds.add(zone.id);
    if (zone.slots !== undefined && zone.slots < 1) {
      errors.push(`The zone "${zone.id}" declares ${zone.slots} slots`);
    }
  }
  if (!zoneIds.has(def.deckZone)) errors.push(`deckZone "${def.deckZone}" does not exist`);
  if (!zoneIds.has(def.handZone)) errors.push(`handZone "${def.handZone}" does not exist`);

  // The deck MUST be invisible and ordered: an `all` one is playing face up, and
  // an unordered one makes "draw the top one" undefined.
  const deck = def.zones.find((z) => z.id === def.deckZone);
  if (deck && (deck.visibility !== "none" || !deck.ordered)) {
    errors.push(`The deck zone "${def.deckZone}" must be visibility:"none" and ordered:true`);
  }
  // And it cannot be shared: each player draws from their own.
  if (deck?.shared) errors.push(`The deck zone "${def.deckZone}" cannot be shared`);

  const hand = def.zones.find((z) => z.id === def.handZone);
  if (hand?.shared) errors.push(`The hand "${def.handZone}" cannot be shared`);

  if (def.deckRules.minSize > def.deckRules.maxSize) errors.push("deckRules: minSize > maxSize");
  if (def.openingHand < 0 || def.openingHand > def.deckRules.minSize) {
    errors.push(`openingHand (${def.openingHand}) exceeds the minimum deck`);
  }
  if (def.players.min < 1 || def.players.min > def.players.max) {
    errors.push("players: invalid range");
  }

  // Sections
  const sectionIds = new Set<string>();
  for (const section of def.sections ?? []) {
    if (sectionIds.has(section.id)) errors.push(`Duplicate section: "${section.id}"`);
    sectionIds.add(section.id);
    if (!zoneIds.has(section.zone)) {
      errors.push(`The section "${section.id}" starts in the zone "${section.zone}", which does not exist`);
    }
    if (section.minSize > section.maxSize)
      errors.push(`Section "${section.id}": minSize > maxSize`);
  }
  if (def.sections?.length && !def.sections.some((s) => s.zone === def.deckZone)) {
    errors.push(`No section starts in deckZone "${def.deckZone}": there would be nowhere to draw from`);
  }

  // Resources and globals
  const resourceIds = new Set<string>();
  for (const r of def.resources) {
    if (resourceIds.has(r.id)) errors.push(`Duplicate resource: "${r.id}"`);
    resourceIds.add(r.id);
  }
  for (const g of def.globals ?? []) {
    if (g.values?.length && !g.values.includes(g.initial)) {
      errors.push(`The global state "${g.id}" starts at a value that is not in \`values\``);
    }
  }

  // Defeat conditions: pointing at a zone or resource that does not exist is a
  // game that NEVER ends, and that is not noticed until the first long game.
  for (const loss of def.lossConditions ?? []) {
    const w = loss.when;
    if (
      (w.kind === "resourceAtOrBelow" || w.kind === "resourceAtOrAbove") &&
      !resourceIds.has(w.resource)
    ) {
      errors.push(`The loss condition "${loss.id}" looks at the resource "${w.resource}", which does not exist`);
    }
    if ((w.kind === "zoneAtLeast" || w.kind === "zoneEmpty") && !zoneIds.has(w.zone)) {
      errors.push(`The loss condition "${loss.id}" looks at the zone "${w.zone}", which does not exist`);
    }
  }

  if (def.mulligan && def.mulligan.maxTimes < 0) errors.push("mulligan: negative maxTimes");

  // Macros. They are validated here, when PUBLISHING, and not when used: a macro that
  // points to a nonexistent zone blows up in the middle of a real game, with
  // half of its steps already applied and no clean way to undo it.
  const macroIds = new Set<string>();
  for (const macro of def.macros ?? []) {
    if (macroIds.has(macro.id)) errors.push(`Duplicate macro: "${macro.id}"`);
    macroIds.add(macro.id);
    if (!macro.steps.length) errors.push(`The macro "${macro.id}" has no steps`);

    macro.steps.forEach((step, i) => {
      const where = `Macro "${macro.id}", step ${i + 1}`;
      const zones: string[] = [];
      if (step.kind === "shuffle") zones.push(step.zone);
      if (step.kind === "randomMove") zones.push(step.from, step.to);
      if (step.kind === "chooseCards") zones.push(step.from, step.to);
      if (step.kind === "moveSource") zones.push(step.to);
      for (const zone of zones) {
        if (!zoneIds.has(zone)) errors.push(`${where}: the zone "${zone}" does not exist`);
      }
      if (step.kind === "resource" && !resourceIds.has(step.resource)) {
        errors.push(`${where}: the resource "${step.resource}" does not exist`);
      }
      if (step.kind === "setGlobal" && !(def.globals ?? []).some((g) => g.id === step.id)) {
        errors.push(`${where}: the global state "${step.id}" does not exist`);
      }
      if (step.kind === "chooseOption" && step.options.length < 2) {
        errors.push(`${where}: a choice needs at least two options`);
      }
      if ((step.kind === "chooseCards" || step.kind === "draw") && step.count < 1) {
        errors.push(`${where}: the quantity must be at least 1`);
      }
    });
  }

  return errors;
}

// ── Decks ────────────────────────────────────────────────────────────────────

/**
 * Reads a catalog property flattening arrays (`colors: ["Red"]`).
 *
 * It is exported because the goldfish has to read cards EXACTLY the same way
 * as the deck validator: if one flattened arrays and the other did not, a legal
 * deck would give statistics for a different deck.
 */
export function propertyValues(catalog: CardCatalog, cardId: string, property: string): unknown[] {
  const raw = catalog[cardId]?.[property];
  if (raw === undefined || raw === null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function checkGroupLimit(limit: GroupLimit, cards: string[], catalog: CardCatalog): string | null {
  let count = 0;
  for (const cardId of cards) {
    const values = propertyValues(catalog, cardId, limit.property);
    const hit =
      limit.value === undefined ? values.some(Boolean) : values.some((v) => v === limit.value);
    if (hit) count++;
  }
  return count > limit.max ? `${limit.name}: ${count} cards (maximum ${limit.max})` : null;
}

function checkDistinctLimit(
  limit: DistinctLimit,
  cards: string[],
  catalog: CardCatalog
): string | null {
  const ignore = new Set(limit.ignore ?? []);
  const distinct = new Set<unknown>();
  for (const cardId of cards) {
    for (const v of propertyValues(catalog, cardId, limit.property)) {
      if (!ignore.has(v as string | number)) distinct.add(v);
    }
  }
  return distinct.size > limit.max
    ? `${limit.name}: ${distinct.size} distinct values (${[...distinct].join(", ")}); maximum ${limit.max}`
    : null;
}

/**
 * Validates a deck against the game's rules.
 *
 * The `catalog` is optional because size and copy rules do not need to
 * know anything about the cards. Limits per group and per distinct values DO —
 * and without a catalog they are SKIPPED instead of failing: a deck cannot be blocked
 * because the importer has not yet uploaded the cards.
 */
export function validateDeck(
  def: GameDefinition,
  deck: DeckInput,
  catalog: CardCatalog = {}
): string[] {
  const errors: string[] = [];
  const bySection = normalizeDeck(def, deck);
  const sections = sectionsOf(def);
  const rules = def.deckRules;

  for (const id of Object.keys(bySection)) {
    if (!sections.some((s) => s.id === id)) errors.push(`Unknown section: "${id}"`);
  }

  for (const section of sections) {
    const cards = bySection[section.id] ?? [];
    if (cards.length < section.minSize) {
      errors.push(
        `"${section.name}" has ${cards.length} cards; the minimum is ${section.minSize}`
      );
    }
    if (cards.length > section.maxSize) {
      errors.push(
        `"${section.name}" has ${cards.length} cards; the maximum is ${section.maxSize}`
      );
    }
  }

  /**
   * Copies are counted over the WHOLE deck, not per section: four copies
   * in the main plus four in the side are eight copies of the same card.
   *
   * UNLESS the section declares its own cap, and then it is counted separately.
   * It is not a whim: there are sections that are a fixed pile of the SAME card
   * —the ten DON!! of ONE PIECE, the twelve runes of Riftbound— and the general
   * cap declared them all illegal. Without this, no legal deck of those
   * games could pass validation, which is the worst possible failure in a
   * validator: rejecting what is correct.
   */
  const all = sections.flatMap((s) => bySection[s.id] ?? []);
  const ownLimit = sections.filter((s) => s.maxCopies !== undefined);
  const pooled = sections.filter((s) => s.maxCopies === undefined);

  const report = (cardId: string, count: number, limit: number, where: string) => {
    if (count <= limit) return;
    errors.push(
      limit === 0
        ? `"${cardId}" is banned in this format`
        : `"${cardId}": ${count} copies${where} (maximum ${limit})`
    );
  };

  const tally = (ids: string[]) => {
    const copies = new Map<string, number>();
    for (const id of ids) copies.set(id, (copies.get(id) ?? 0) + 1);
    return copies;
  };

  for (const [cardId, count] of tally(pooled.flatMap((s) => bySection[s.id] ?? []))) {
    report(cardId, count, rules.copyLimits?.[cardId] ?? rules.maxCopies, "");
  }

  for (const section of ownLimit) {
    for (const [cardId, count] of tally(bySection[section.id] ?? [])) {
      // A banned card is banned EVERYWHERE: the section's cap
      // lifts the general one, it is not a format limitation.
      const limit = Math.min(section.maxCopies as number, rules.copyLimits?.[cardId] ?? Infinity);
      report(cardId, count, limit, ` in "${section.name}"`);
    }
  }

  if (Object.keys(catalog).length > 0) {
    for (const limit of rules.groupLimits ?? []) {
      const error = checkGroupLimit(limit, all, catalog);
      if (error) errors.push(error);
    }
    for (const limit of rules.distinctLimits ?? []) {
      const error = checkDistinctLimit(limit, all, catalog);
      if (error) errors.push(error);
    }
  }

  return errors;
}
