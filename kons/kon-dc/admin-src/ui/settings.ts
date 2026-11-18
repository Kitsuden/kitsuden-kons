/**
 * Whether tallao's SchemaForm can draw a JSON Schema as a form: scalars, enums, nested objects,
 * lists of strings or numbers (a TagInput) and lists of objects (a group per item). Settings it
 * cannot draw (a union, a free-form record) are edited as JSON instead; the server validates both.
 */
import type { JsonSchema } from "$lib/components";

type Schema = JsonSchema & { anyOf?: unknown; oneOf?: unknown; additionalProperties?: unknown };

export function formable(schema: unknown): schema is JsonSchema {
  const s = schema as Schema;
  if (!s || typeof s !== "object" || s.type !== "object" || !s.properties) return false;
  const leaf = (p: Schema): boolean => {
    if (p.anyOf) return false;
    switch (p.type) {
      case "string":
      case "number":
      case "integer":
      case "boolean":
        return true;
      case "array": {
        const items = p.items as Schema | undefined;
        if (!items) return false;
        if (items.enum || items.oneOf) return true;
        if (items.type === "object") return formable(items);
        return items.type === "string" || items.type === "number" || items.type === "integer";
      }
      case "object":
        return formable(p);
      default:
        return false;
    }
  };
  return Object.values(s.properties).every((p) => leaf(p as Schema));
}

/** Pretty JSON for a textarea, and back. */
export const toJson = (v: unknown) => JSON.stringify(v ?? {}, null, 2);

export function fromJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid JSON" };
  }
}
