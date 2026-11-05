/**
 * Builder engine — definition, validation and build computation
 * ============================================================================
 *
 * A character builder (Questlog, the PoE planners, the Diablo ones) is
 * always the same machine with a different skin:
 *
 *   1. A DEFINITION: which slots exist (weapon, helmet, skills…), which options
 *      fit in each one, which budgets limit them (skill points, level).
 *   2. A BUILD: what the user chose in each slot and how they spent points.
 *   3. A COMPUTATION: base + modifiers + formulas → final stats.
 *
 * This kon is the machine; the skin (which game, which slots, which formulas) is DATA
 * that each deployment loads. Adding a new game is uploading its definition, not
 * writing code — the same principle as Broadcast profiles.
 *
 * Everything is pure. Formulas are evaluated by `@kitsuden/kon-formulas`, which is an
 * allowlist with no escape surface: user text is never evaluated here
 * any other way.
 */

import {
  compileSystem,
  evaluateSystem,
  FormulaError,
  type CompiledSystem,
  type StatDefinition,
} from "@kitsuden/kon-formulas";

// ── Definition ───────────────────────────────────────────────────────────────

/** A modifier contributed by an equipped option. */
export interface Modifier {
  /** INPUT stat it touches: `atk_flat`, `crit_rate`. */
  stat: string;
  value: number;
}

/** A selectable option in a slot: a weapon, a skill, a talent. */
export interface SlotOption {
  id: string;
  name: string;
  modifiers: Modifier[];
  /** Cost against the slot's budget (talent points…). 0 = free. */
  cost?: number;
  /** Ids of options it requires to be equipped (in any slot). */
  requires?: string[];
  /** Ids it cannot coexist with. */
  excludes?: string[];
  /**
   * Image to draw the option. Presentation only: the engine does not read it, and
   * so it is not part of what is validated nor of the build code.
   */
  imageUrl?: string;
  /**
   * Group within the slot: at most ONE option from each group per slot.
   *
   * It is what separates "five armor pieces" from "five helmets". Splitting
   * armor into five slots would break already saved builds (they point at the
   * `armadura` slot); the group keeps the slot and forbids repeating a part.
   */
  group?: string;
}

export interface SlotDefinition {
  id: string;
  name: string;
  /** How many options fit. 1 = a weapon; 4 = four equipped skills. */
  capacity: number;
  options: SlotOption[];
  /** Can it be empty? A weapon cannot; an accessory is optional. */
  required?: boolean;
}

export interface BudgetDefinition {
  id: string;
  name: string;
  /** Total available: 60 skill points, level 90… */
  total: number;
  /** Slots whose costs consume this budget. */
  slots: string[];
}

export interface BuilderDefinition {
  id: string;
  name: string;
  /** Input stats with their base value: `{ atk_base: 100, crit_rate: 5 }`. */
  baseStats: Record<string, number>;
  slots: SlotDefinition[];
  budgets: BudgetDefinition[];
  /** Derived stats, in any order: the engine resolves the dependencies. */
  derived: StatDefinition[];
  /**
   * WHOSE build it is: the id of the slot that decides the subject.
   *
   * A build gallery is read by subject ("all of Infergon's builds"),
   * not by builder. Without this you would have to filter inside each build's JSON
   * on every query; with this the subject is stored on publish and the list is
   * an index. Optional: a squad builder has no single subject.
   */
  subjectSlot?: string;
}

export interface CompiledBuilder {
  definition: BuilderDefinition;
  system: CompiledSystem;
  optionIndex: Map<string, { slot: SlotDefinition; option: SlotOption }>;
}

/**
 * Compiles a definition: validates its consistency ONCE, when loading it.
 *
 * Everything caught here (duplicate options, broken formulas, budgets
 * pointing at nonexistent slots) is an error by the definition's AUTHOR, and
 * must blow up when they upload it, not when a user opens the builder.
 */
export function compileBuilder(definition: BuilderDefinition): CompiledBuilder {
  const optionIndex = new Map<string, { slot: SlotDefinition; option: SlotOption }>();

  for (const slot of definition.slots) {
    if (slot.capacity < 1) {
      throw new FormulaError(`The slot "${slot.id}" has capacity ${slot.capacity}`);
    }
    for (const option of slot.options) {
      if (optionIndex.has(option.id)) {
        throw new FormulaError(`The option "${option.id}" is in two slots`);
      }
      optionIndex.set(option.id, { slot, option });
    }
  }

  for (const budget of definition.budgets) {
    for (const slotId of budget.slots) {
      if (!definition.slots.some((s) => s.id === slotId)) {
        throw new FormulaError(
          `The budget "${budget.id}" points at the nonexistent slot "${slotId}"`
        );
      }
    }
  }

  if (definition.subjectSlot && !definition.slots.some((s) => s.id === definition.subjectSlot)) {
    throw new FormulaError(`The subject points at the nonexistent slot "${definition.subjectSlot}"`);
  }

  // Compiling the system validates the formulas and detects cycles.
  const system = compileSystem(definition.derived);

  return { definition, system, optionIndex };
}

// ── Build ────────────────────────────────────────────────────────────────────

/** What the user chose. Ids only: the build is small and serializable. */
export interface Build {
  /** slotId → ids of equipped options. */
  selections: Record<string, string[]>;
  /**
   * Free input adjustments: chosen level, attribute allocation…
   * They are ADDED to baseStats. Only stats that exist in the definition.
   */
  attributes?: Record<string, number>;
  /**
   * The address that opens it (`#gd=…`, `#b=…`). In a "link" build it IS the
   * build; in a pieces build it is only the shortcut to open it as it was saved.
   */
  link?: string;
  /** What summarizes it on a card ("Necromancer", "Barbarian"…) */
  label?: string;
}

// ── "Link" builds ────────────────────────────────────────────────────────────
/**
 * Tree planners (Grim Dawn, Diablo, Last Epoch…) do not assemble their
 * build from a definition's options: they store it whole in the address.
 * To publish them and save them with an account there is no need for a definition per
 * planner: the builder is `link:<herramienta>:<route>` and the build is its
 * link. The SHAPE and size are validated; what the link says is only
 * understood by the page that opens it, and nothing may be slipped into it that is not
 * an address fragment.
 */
export const LINK_PREFIX = "link:";
const LINK_ID = /^link:[a-z0-9-]{1,40}:\/[a-z0-9/_.-]{0,200}$/;
/** A printable ASCII fragment, without quotes or `<>`: it goes inside an `href` */
const LINK = /^#(?:(?!["'<>\\`])[\x21-\x7E]){2,4000}$/;

export const isLinkBuilder = (builderId: string) => builderId.startsWith(LINK_PREFIX);
export const isValidLink = (link: unknown): link is string =>
  typeof link === "string" && LINK.test(link);

/** What is wrong with a link build, or `null` if it can be saved */
export function linkBuildProblem(builderId: string, build: Build): string | null {
  if (!LINK_ID.test(builderId)) return "That planner does not exist";
  if (!isValidLink(build.link)) return "The build link is not valid";
  if (Object.values(build.selections ?? {}).some((ids) => ids.length > 0)) {
    return "A link build carries no pieces";
  }
  if (
    build.label !== undefined &&
    (typeof build.label !== "string" || build.label.length > 80)
  ) {
    return "The label is too long";
  }
  return null;
}

/**
 * Whose build this is: the option chosen in the subject's slot.
 *
 * `null` when the definition declares no subject (a squad) or when that
 * slot is empty. It is what is stored in the `subject` column on publish.
 */
export function subjectOfBuild(compiled: CompiledBuilder, build: Build): string | null {
  const slot = compiled.definition.subjectSlot;
  if (!slot) return null;
  return build.selections?.[slot]?.[0] ?? null;
}

export interface BuildIssue {
  level: "error" | "warning";
  message: string;
}

/**
 * Validates a build against its definition.
 *
 * Returns ALL the problems, not the first: someone putting a build together
 * wants to see the whole list ("you are 3 points over AND you lack a weapon"),
 * not play whack-a-mole with one error at a time.
 */
export function validateBuild(compiled: CompiledBuilder, build: Build): BuildIssue[] {
  const issues: BuildIssue[] = [];
  const { definition, optionIndex } = compiled;
  const equipped = new Set<string>();

  for (const [slotId, optionIds] of Object.entries(build.selections)) {
    const slot = definition.slots.find((s) => s.id === slotId);
    if (!slot) {
      issues.push({ level: "error", message: `The slot "${slotId}" does not exist` });
      continue;
    }
    if (optionIds.length > slot.capacity) {
      issues.push({
        level: "error",
        message: `"${slot.name}" allows ${slot.capacity} and carries ${optionIds.length}`,
      });
    }
    if (new Set(optionIds).size !== optionIds.length) {
      issues.push({ level: "error", message: `"${slot.name}" has repeated options` });
    }
    // One per group: two helmets in "Armor" is not a possible build
    const byGroup = new Map<string, string[]>();
    for (const id of optionIds) {
      const entry = optionIndex.get(id);
      const group = entry?.slot.id === slotId ? entry.option.group : undefined;
      if (group) byGroup.set(group, [...(byGroup.get(group) ?? []), entry!.option.name]);
    }
    for (const [group, names] of byGroup) {
      if (names.length > 1) {
        issues.push({
          level: "error",
          message: `"${slot.name}" allows only one of "${group}" and carries ${names.length}: ${names.join(", ")}`,
        });
      }
    }
    for (const id of optionIds) {
      const entry = optionIndex.get(id);
      if (!entry) {
        issues.push({ level: "error", message: `The option "${id}" does not exist` });
      } else if (entry.slot.id !== slotId) {
        // A weapon in the helmet slot: the classic error of a hand-
        // tampered build code.
        issues.push({
          level: "error",
          message: `"${entry.option.name}" belongs to "${entry.slot.name}", not to "${slot.name}"`,
        });
      } else {
        equipped.add(id);
      }
    }
  }

  for (const slot of definition.slots) {
    if (slot.required && !(build.selections[slot.id]?.length > 0)) {
      issues.push({ level: "error", message: `"${slot.name}" cannot be empty` });
    }
  }

  // Requirements and exclusions are checked over the COMPLETE set: a
  // skill can require a weapon that lives in another slot.
  for (const id of equipped) {
    const { option } = optionIndex.get(id)!;
    for (const req of option.requires ?? []) {
      if (!equipped.has(req)) {
        const reqName = optionIndex.get(req)?.option.name ?? req;
        issues.push({ level: "error", message: `"${option.name}" requires "${reqName}"` });
      }
    }
    for (const excl of option.excludes ?? []) {
      if (equipped.has(excl)) {
        const exclName = optionIndex.get(excl)?.option.name ?? excl;
        issues.push({ level: "error", message: `"${option.name}" does not coexist with "${exclName}"` });
      }
    }
  }

  for (const budget of definition.budgets) {
    let spent = 0;
    for (const slotId of budget.slots) {
      for (const id of build.selections[slotId] ?? []) {
        spent += optionIndex.get(id)?.option.cost ?? 0;
      }
    }
    if (spent > budget.total) {
      issues.push({
        level: "error",
        message: `"${budget.name}": ${spent} of ${budget.total} points`,
      });
    } else if (spent < budget.total) {
      // Unspent points do not invalidate the build, but they are almost always an
      // oversight, and whoever publishes a guide wants to know.
      issues.push({
        level: "warning",
        message: `"${budget.name}: ${budget.total - spent} point(s) left unspent`,
      });
    }
  }

  for (const stat of Object.keys(build.attributes ?? {})) {
    if (!(stat in definition.baseStats)) {
      issues.push({ level: "error", message: `The attribute "${stat}" does not exist in this game` });
    }
  }

  return issues;
}

/**
 * Calculates a build's final stats.
 *
 * Pipeline in a FIXED, documented order, because the order IS the game's
 * rule: base + user attributes + flat modifiers of what is equipped →
 * derived formulas. Percentages go INSIDE the formulas
 * (`atk_base * (1 + atk_pct / 100)`), not as a magic engine step: each
 * game applies them differently and hiding it here would be choosing for everyone.
 */
export function computeStats(compiled: CompiledBuilder, build: Build): Record<string, number> {
  const errors = validateBuild(compiled, build).filter((i) => i.level === "error");
  if (errors.length > 0) {
    throw new FormulaError(`Invalid build: ${errors.map((e) => e.message).join("; ")}`);
  }

  const inputs: Record<string, number> = { ...compiled.definition.baseStats };

  for (const [stat, value] of Object.entries(build.attributes ?? {})) {
    inputs[stat] = (inputs[stat] ?? 0) + value;
  }

  for (const optionIds of Object.values(build.selections)) {
    for (const id of optionIds) {
      const entry = compiled.optionIndex.get(id);
      if (!entry) continue;
      for (const mod of entry.option.modifiers) {
        inputs[mod.stat] = (inputs[mod.stat] ?? 0) + mod.value;
      }
    }
  }

  // Inputs the system expects and nobody supplies start at 0 — here that is fine:
  // they are stats DECLARED in the author's formulas, not user typos.
  for (const input of compiled.system.inputs) {
    if (!(input in inputs)) inputs[input] = 0;
  }

  return evaluateSystem(compiled.system, inputs);
}

// ── Build codes ──────────────────────────────────────────────────────────────

/**
 * Serializes a build into a shareable code.
 *
 * Builds ARE SHARED — on Discord, in a guide, in a tweet — and the code
 * is the unit of sharing. Versioned from day one: when the format
 *  changes, old codes will keep opening.
 */
export function encodeBuild(builderId: string, build: Build): string {
  const payload = JSON.stringify({ v: 1, b: builderId, s: build.selections, a: build.attributes });
  // base64url: no `+/=`, which break when pasted into URLs and chats.
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type DecodedBuild =
  | { ok: true; builderId: string; build: Build }
  | { ok: false; reason: string };

/**
 * Decodes a code. NEVER throws: a code arrives from a chat, cut off or
 * tampered with, and the builder must say "invalid code", not crash.
 * The real validation against the definition belongs to `validateBuild` — this only
 * guarantees the SHAPE.
 */
export function decodeBuild(code: string): DecodedBuild {
  try {
    const base64 = code.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      v?: number;
      b?: string;
      s?: Record<string, unknown>;
      a?: Record<string, unknown>;
    };

    if (payload.v !== 1) return { ok: false, reason: "Unsupported code version" };
    if (typeof payload.b !== "string" || !payload.b) {
      return { ok: false, reason: "The code does not name the game" };
    }

    const selections: Record<string, string[]> = {};
    for (const [slot, ids] of Object.entries(payload.s ?? {})) {
      if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string")) {
        return { ok: false, reason: "Selecciones malformadas" };
      }
      selections[slot] = ids;
    }

    const attributes: Record<string, number> = {};
    for (const [stat, value] of Object.entries(payload.a ?? {})) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: "Malformed attributes" };
      }
      attributes[stat] = value;
    }

    return { ok: true, builderId: payload.b, build: { selections, attributes } };
  } catch {
    return { ok: false, reason: "Unreadable code" };
  }
}
