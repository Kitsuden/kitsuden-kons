/**
 * Listings — verticals: what a listing of each kind carries
 * ============================================================================
 *
 * A vertical is a JSON file in `verticals/`: `real-estate.json`, `vehicles.json`, `jobs.json`. Each one
 * lists the listing's attributes (`fields`, in the field vocabulary of the core's field compiler) and
 * what a listing needs before it can be published (`publish.requires`, among the listing's own
 * columns). A new kind of listing is a new file, with no code.
 *
 * Two levels of checking, on purpose:
 *   · every write checks TYPES: a number is a number, a select value is one of its options;
 *   · `required` is checked only when the listing is PUBLISHED. A draft is work in progress, and
 *     refusing to save it until the last field is filled only makes people type placeholders.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateAgainstFields } from "@kitsuden/engine";
import { z } from "@kitsuden/engine/zod";

const Field = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
  label: z.string().min(1),
  type: z.enum(["text", "textarea", "number", "boolean", "date", "select", "multiselect", "url", "email"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  maxLength: z.number().int().positive().optional(),
});

/** The listing columns a vertical may require before publishing. */
export const PUBLISHABLE_COLUMNS = ["price", "currency", "city", "region", "address", "images", "description"] as const;
export type PublishableColumn = (typeof PUBLISHABLE_COLUMNS)[number];

export const Vertical = z.object({
  $comment: z.string().optional(),
  id: z.string().regex(/^[a-z0-9-]{2,30}$/),
  name: z.string().min(1),
  fields: z.array(Field),
  publish: z.object({ requires: z.array(z.enum(PUBLISHABLE_COLUMNS)).default([]) }).default({ requires: [] }),
});
export type Vertical = z.infer<typeof Vertical>;
export type VerticalField = z.infer<typeof Field>;

const DIR = fileURLToPath(new URL("./verticals/", import.meta.url));

/** Every vertical, validated: a broken file is reported by name instead of half-used. */
export function loadVerticals(dir = DIR): Map<string, Vertical> {
  const out = new Map<string, Vertical>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = Vertical.safeParse(JSON.parse(readFileSync(`${dir}/${file}`, "utf8")));
    if (!parsed.success) {
      throw new Error(`Vertical ${file} is not valid: ${parsed.error.issues[0]?.message ?? ""}`);
    }
    const keys = new Set<string>();
    for (const field of parsed.data.fields) {
      if (keys.has(field.key)) throw new Error(`Vertical ${file}: field "${field.key}" is declared twice`);
      keys.add(field.key);
      if ((field.type === "select" || field.type === "multiselect") && !field.options?.length) {
        throw new Error(`Vertical ${file}: field "${field.key}" needs options`);
      }
    }
    out.set(parsed.data.id, parsed.data);
  }
  return out;
}

let cached: Map<string, Vertical> | null = null;

/** The shipped verticals, read once. */
export function verticals(): Map<string, Vertical> {
  cached ??= loadVerticals();
  return cached;
}

export interface AttributeIssue {
  field: string;
  message: string;
}

/**
 * Checks a listing's attributes against its vertical. With `publishing`, required fields must be
 * there; without it, only the types are checked. Keys the vertical does not declare are refused:
 * a typo (`bedroom` for `bedrooms`) would otherwise be stored and never reach a portal.
 */
export function attributeIssues(
  vertical: Vertical,
  attributes: Record<string, unknown>,
  publishing: boolean
): AttributeIssue[] {
  const declared = new Set(vertical.fields.map((f) => f.key));
  const unknown = Object.keys(attributes)
    .filter((key) => !declared.has(key))
    .map((key) => ({ field: key, message: `not a field of the "${vertical.id}" vertical` }));
  if (unknown.length > 0) return unknown;

  // `null` means "not set": the compiler would read it as a wrong type.
  const present = Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== null && v !== undefined));
  const fields = publishing ? vertical.fields : vertical.fields.map((f) => ({ ...f, required: false }));
  const result = validateAgainstFields(fields, present);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    field: issue.path.map(String).join(".") || "attributes",
    message: issue.message,
  }));
}

/** What a listing lacks before it can be published, among its own columns and its attributes. */
export function publishIssues(
  vertical: Vertical,
  listing: Partial<Record<PublishableColumn, unknown>> & { attributes: Record<string, unknown> }
): AttributeIssue[] {
  const issues: AttributeIssue[] = [];
  for (const column of vertical.publish.requires) {
    const value = listing[column];
    const empty =
      value === null ||
      value === undefined ||
      (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0);
    if (empty) issues.push({ field: column, message: "required to publish" });
  }
  return [...issues, ...attributeIssues(vertical, listing.attributes, true)];
}
