/**
 * Custom registration fields
 * ============================================================================
 *
 * Online the TO cannot ask in person. They need the Riot ID, the region,
 * the deck list or the PayPal email **beforehand**, or the tournament is spent
 * chasing people in private messages.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VISIBILITY IS PART OF THE DEFINITION, NOT A SEPARATE SETTING
 *
 * A tournament's list of registrants is public — it is what gets shared. But
 * the PayPal email, phone or address are NOT, and whoever defines the field is
 * the one who knows which is which.
 *
 * That is why `visibility` goes in the field definition and not in a list of
 * exceptions elsewhere: a new field is born declaring who sees it, and there
 * is no way to add one "by accident" to the public response.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { FieldTypeAlias, FieldTypeName } from "@kitsuden/shared";

export class CustomFieldError extends Error {}

/**
 * Subset of the shared type registry that this form supports.
 *
 * It is tied to the registry with `satisfies` so the two vocabularies cannot
 * drift apart: if a type is renamed or removed there, this stops compiling
 * instead of silently diverging, which is how the repo ended up with four
 * different type lists.
 *
 * `checkbox` is kept —and not changed to `boolean`— because it is the value
 * already stored in existing tournament definitions. The registry resolves it
 * via alias, so they point to the same place without breaking anything.
 *
 * What is NOT unified is `validateAnswers`, below: it coerces the input
 * ("true" → true, "42" → 42) and omits empty optionals instead of
 * storing them as null. That is HTML form semantics, not the
 * compiler's; passing it through Zod would change the behavior of a
 * production registration flow for no gain.
 */
export const ESPORTS_FIELD_TYPES = [
  "text",
  "email",
  "url",
  "number",
  "select",
  "checkbox",
] as const satisfies readonly (FieldTypeName | FieldTypeAlias)[];

export type CustomFieldType = (typeof ESPORTS_FIELD_TYPES)[number];

/** `public` appears in the registrant list; `organizer` never does. */
export type FieldVisibility = "public" | "organizer";

export interface CustomFieldDefinition {
  /** Stable key. It is the one that goes in `customData`; renaming the label does not touch it. */
  key: string;
  label: string;
  type: CustomFieldType;
  required?: boolean;
  visibility?: FieldVisibility;
  /** Help below the field. It is where you explain where to find a Riot ID. */
  help?: string;
  /** Only for `select`. */
  options?: string[];
  maxLength?: number;
  min?: number;
  max?: number;
}

/** Per-tournament cap: nobody fills in a form longer than this. */
const MAX_FIELDS = 20;
const DEFAULT_MAX_LENGTH = 500;

/**
 * Validates the DEFINITION, not the answers.
 *
 * It is checked when saving the tournament and not at registration: a broken form
 * discovered by the first registrant is a form that has already lost people.
 */
export function validateFieldDefinitions(fields: CustomFieldDefinition[]): string[] {
  const issues: string[] = [];

  if (fields.length > MAX_FIELDS) {
    issues.push(`At most ${MAX_FIELDS} fields; there are ${fields.length}.`);
  }

  const keys = new Set<string>();
  for (const field of fields) {
    if (!field.key || !/^[a-z][a-z0-9_]{0,39}$/i.test(field.key)) {
      issues.push(
        `"${field.key}" is not a valid key (letters, numbers and underscore; starts with a letter).`
      );
      continue;
    }
    if (keys.has(field.key)) {
      // Two fields with the same key: the second would overwrite the first in
      // `customData` and an answer would be lost without anyone noticing.
      issues.push(`Duplicate key: "${field.key}".`);
    }
    keys.add(field.key);

    if (!field.label?.trim()) issues.push(`The field "${field.key}" has no label.`);

    if (field.type === "select") {
      const options = field.options ?? [];
      if (options.length < 2) {
        issues.push(`"${field.key}" is a dropdown and needs at least two options.`);
      }
      if (new Set(options).size !== options.length) {
        issues.push(`"${field.key}" has repeated options.`);
      }
    }

    if (field.type === "number" && field.min !== undefined && field.max !== undefined) {
      if (field.min > field.max)
        issues.push(`"${field.key}" has the minimum above the maximum.`);
    }
  }

  return issues;
}

export interface FieldAnswers {
  [key: string]: string | number | boolean | null;
}

/**
 * Validates the answers against the definition.
 *
 * Returns ALL the problems, not the first: someone filling in a form
 * should not discover the errors one at a time.
 */
export function validateAnswers(
  fields: CustomFieldDefinition[],
  answers: FieldAnswers
): { ok: boolean; issues: string[]; clean: FieldAnswers } {
  const issues: string[] = [];
  const clean: FieldAnswers = {};

  for (const field of fields) {
    const raw = answers[field.key];
    const empty = raw === undefined || raw === null || raw === "";

    if (empty) {
      if (field.required) issues.push(`"${field.label}" is required.`);
      // An empty optional is OMITTED instead of being stored as null: that way
      // `customData` only contains what the person actually answered.
      continue;
    }

    switch (field.type) {
      case "checkbox":
        clean[field.key] = raw === true || raw === "true";
        break;

      case "number": {
        const value = typeof raw === "number" ? raw : Number(String(raw).trim());
        if (!Number.isFinite(value)) {
          issues.push(`"${field.label}" must be a number.`);
          break;
        }
        if (field.min !== undefined && value < field.min) {
          issues.push(`"${field.label}" cannot be less than ${field.min}.`);
          break;
        }
        if (field.max !== undefined && value > field.max) {
          issues.push(`"${field.label}" cannot be greater than ${field.max}.`);
          break;
        }
        clean[field.key] = value;
        break;
      }

      case "select": {
        const value = String(raw);
        if (!(field.options ?? []).includes(value)) {
          // Deny-by-default: only what is in the list gets in. Accepting
          // any text would turn a dropdown into a free field as
          // soon as someone made the request by hand.
          issues.push(`"${field.label}": "${value}" is not one of the options.`);
          break;
        }
        clean[field.key] = value;
        break;
      }

      case "email": {
        const value = String(raw).trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          issues.push(`"${field.label}" does not look like an email.`);
          break;
        }
        clean[field.key] = value;
        break;
      }

      case "url": {
        const value = String(raw).trim();
        try {
          const url = new URL(value);
          // Only http(s). Without this `javascript:` and `data:` get in, and this is
          // rendered as a link in the TO panel.
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            issues.push(`"${field.label}" must be an http or https link.`);
            break;
          }
          clean[field.key] = url.toString();
        } catch {
          issues.push(`"${field.label}" is not a valid link.`);
        }
        break;
      }

      default: {
        const value = String(raw).trim();
        const limit = field.maxLength ?? DEFAULT_MAX_LENGTH;
        if (value.length > limit) {
          issues.push(`"${field.label}" cannot exceed ${limit} characters.`);
          break;
        }
        clean[field.key] = value;
      }
    }
  }

  // What arrives and is not defined is silently DISCARDED. Storing it would let
  // anyone bloat the row with whatever they wanted by sending invented
  // fields, and nobody would ever see it on screen.
  return { ok: issues.length === 0, issues, clean };
}

/**
 * Leaves only what can appear in the public list of registrants.
 *
 * By default a field is `organizer`: if someone defines one and forgets to
 * declare visibility, the safe outcome is that it is NOT published. The other
 * way around, the omission would publish phone numbers.
 */
export function publicAnswers(
  fields: CustomFieldDefinition[],
  answers: FieldAnswers
): FieldAnswers {
  const visible = new Set(fields.filter((f) => f.visibility === "public").map((f) => f.key));

  const out: FieldAnswers = {};
  for (const [key, value] of Object.entries(answers)) {
    if (visible.has(key)) out[key] = value;
  }
  return out;
}
