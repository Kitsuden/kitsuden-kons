/**
 * Custom fields: each project defines its own (`agile_custom_fields`); an issue keeps the values in
 * `props.customFields[key]`. This checks a set of values against the definitions before it is
 * stored, so a value of the wrong type, an unknown key or an option that does not exist is a 422
 * and not a row nobody can read back.
 */

import { AppError } from "@kitsuden/engine";
import { asc, eq } from "drizzle-orm";

import type { AgileDb } from "./agile.db";
import { agileCustomFields, type AgileCustomField } from "./agile.schema";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

export async function fieldsOf(db: AgileDb, projectId: string): Promise<AgileCustomField[]> {
  return db
    .select()
    .from(agileCustomFields)
    .where(eq(agileCustomFields.projectId, projectId))
    .orderBy(asc(agileCustomFields.sortOrder), asc(agileCustomFields.name));
}

function checkValue(field: AgileCustomField, value: unknown): void {
  const bad = (why: string) =>
    AppError.validation(`customFields.${field.key}: ${why}`, { field: `customFields.${field.key}` });
  switch (field.type) {
    case "text":
      if (typeof value !== "string" || value.length > 5000) throw bad("a text up to 5000 chars");
      return;
    case "url":
      if (typeof value !== "string" || !/^https?:\/\/\S+$/.test(value) || value.length > 2000) {
        throw bad("an http(s) URL");
      }
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw bad("a number");
      return;
    case "date":
      if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
        throw bad("a date (YYYY-MM-DD or ISO 8601)");
      }
      return;
    case "checkbox":
      if (typeof value !== "boolean") throw bad("true or false");
      return;
    case "user":
      if (typeof value !== "string" || value.length === 0 || value.length > 128) {
        throw bad("a user id");
      }
      return;
    case "select":
      if (typeof value !== "string" || !field.options.includes(value)) {
        throw bad(`one of: ${field.options.join(", ")}`);
      }
      return;
    case "multi_select":
      if (
        !Array.isArray(value) ||
        value.some((v) => typeof v !== "string" || !field.options.includes(v))
      ) {
        throw bad(`a list of: ${field.options.join(", ")}`);
      }
      return;
  }
}

/**
 * Merges `incoming` into `current` and checks the result. A `null` value clears a field.
 * `creating`: required fields must have a value.
 */
export function mergeCustomFields(
  fields: AgileCustomField[],
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
  creating: boolean
): Record<string, unknown> | undefined {
  if (incoming === undefined && !creating) return current;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const result: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    const field = byKey.get(key);
    if (!field) {
      throw AppError.validation(`customFields.${key} is not a field of this project`, {
        field: `customFields.${key}`,
      });
    }
    if (value === null) {
      delete result[key];
      continue;
    }
    checkValue(field, value);
    result[key] = value;
  }
  for (const f of fields) {
    if (f.isRequired && (result[f.key] === undefined || result[f.key] === "")) {
      if (creating || (incoming && key(incoming, f.key))) {
        throw AppError.validation(`customFields.${f.key} is required`, {
          field: `customFields.${f.key}`,
        });
      }
    }
  }
  return result;
}

const key = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
