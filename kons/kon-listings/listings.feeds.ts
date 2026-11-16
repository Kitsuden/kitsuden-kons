/**
 * Listings — portal feeds: one XML document per portal and vertical
 * ============================================================================
 *
 * Aggregators such as Trovit and Mitula do not take listings through an API: they READ an XML
 * document from a URL, usually once a day. So publishing is building that document well:
 *
 *   portals/<portal>.json   how a listing becomes one item of that portal's feed (element names,
 *                           value maps, which elements are required). Data, not code: when a
 *                           portal sends its specification, the file is edited, not this module.
 *   buildFeed()             the published listings of one vertical → the XML, plus the listings it
 *                           left out and why (a missing required element), so the team can fix
 *                           them before the portal silently drops them.
 *
 * Everything here is pure: no database, no request. The routes load the rows and the feed.
 *
 * ── XML ────────────────────────────────────────────────────────────────────
 *
 * Text is escaped (`& < > " '`), never wrapped in CDATA: a description containing `]]>` would end
 * a CDATA section early and let the rest be read as markup. Characters XML 1.0 forbids (most
 * control characters) are dropped. Element and attribute names come only from the portal files,
 * and are checked when those are loaded.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "@kitsuden/engine/zod";

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const FORMATS = ["text", "number", "boolean-1-0", "date-dd/mm/yyyy", "date-iso"] as const;
type Format = (typeof FORMATS)[number];

const Value = z.object({
  from: z.string().regex(PATH).optional(),
  value: z.string().optional(),
  map: z.record(z.string(), z.string()).optional(),
});

const Mapping = z
  .object({
    element: z.string().regex(NAME),
    from: z.string().regex(PATH).optional(),
    value: z.string().optional(),
    map: z.record(z.string(), z.string()).optional(),
    format: z.enum(FORMATS).optional(),
    required: z.boolean().optional(),
    attributes: z.record(z.string().regex(NAME), Value).optional(),
    pictures: z
      .object({
        item: z.string().regex(NAME),
        url: z.string().regex(NAME),
        title: z.string().regex(NAME).optional(),
        max: z.number().int().min(1).max(100).optional(),
      })
      .optional(),
  })
  .refine((m) => [m.from, m.value, m.pictures].filter((x) => x !== undefined).length === 1, {
    message: "a mapping takes exactly one of from, value or pictures",
  });
export type Mapping = z.infer<typeof Mapping>;

export const Portal = z.object({
  $comment: z.string().optional(),
  id: z.string().regex(/^[a-z0-9-]{2,30}$/),
  name: z.string().min(1),
  /** `false` until someone checked the mapping against the portal's own specification. */
  verified: z.boolean(),
  root: z.string().regex(NAME),
  item: z.string().regex(NAME),
  verticals: z.record(z.string(), z.array(Mapping)),
});
export type Portal = z.infer<typeof Portal>;

const DIR = fileURLToPath(new URL("./portals/", import.meta.url));

/** Every portal, validated: a broken file is reported by name. */
export function loadPortals(dir = DIR): Map<string, Portal> {
  const out = new Map<string, Portal>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = Portal.safeParse(JSON.parse(readFileSync(`${dir}/${file}`, "utf8")));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Portal ${file} is not valid: ${issue?.path.join(".")} ${issue?.message ?? ""}`);
    }
    out.set(parsed.data.id, parsed.data);
  }
  return out;
}

let cached: Map<string, Portal> | null = null;

/** The shipped portals, read once. */
export function portals(): Map<string, Portal> {
  cached ??= loadPortals();
  return cached;
}

// ─────────────────────────────────────────────────────────────────────────────
// The listing as a feed sees it
// ─────────────────────────────────────────────────────────────────────────────

export interface FeedPicture {
  url: string;
  title?: string | null;
}

/** One listing, flattened for the mappings (`from: "attributes.bedrooms"`, `from: "feed.agencyName"`). */
export interface FeedListing {
  id: string;
  reference: string | null;
  url: string;
  title: string;
  description: string | null;
  price: string | number | null;
  currency: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  district: string | null;
  address: string | null;
  postcode: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  images: FeedPicture[];
  attributes: Record<string, unknown>;
  publishedAt: Date | string | null;
  updatedAt: Date | string;
}

/** What the feed itself adds to every item: the agency's name and contact, from the feed's settings. */
export interface FeedSettings {
  agencyName?: string;
  contactPhone?: string;
  contactEmail?: string;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function read(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (FORBIDDEN_KEYS.has(part) || current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatted(value: unknown, format: Format | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (format === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? String(n) : null;
  }
  if (format === "boolean-1-0") {
    if (value === true || value === "true" || value === 1 || value === "1") return "1";
    if (value === false || value === "false" || value === 0 || value === "0") return "0";
    return null;
  }
  if (format === "date-dd/mm/yyyy" || format === "date-iso") {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return null;
    return format === "date-iso"
      ? date.toISOString()
      : `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
  }
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return null;
  return String(value);
}

function resolve(
  spec: { from?: string; value?: string; map?: Record<string, string>; format?: Format },
  source: Record<string, unknown>
): string | null {
  const raw = spec.value !== undefined ? spec.value : read(source, spec.from as string);
  if (spec.map) {
    if (raw === null || raw === undefined) return null;
    const key = String(raw);
    return Object.prototype.hasOwnProperty.call(spec.map, key) ? spec.map[key] : null;
  }
  const text = formatted(raw, spec.format);
  return text === null || text.trim() === "" ? null : text;
}

// ─────────────────────────────────────────────────────────────────────────────
// XML
// ─────────────────────────────────────────────────────────────────────────────

// Tab, line feed, carriage return and everything from space up, minus the surrogates and the two
// non-characters at the end of the BMP: what XML 1.0 allows.
// eslint-disable-next-line no-control-regex
const NOT_XML = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu;

export function xmlText(value: string): string {
  return value
    .replace(NOT_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function attributesXml(
  spec: Mapping["attributes"],
  source: Record<string, unknown>
): string {
  if (!spec) return "";
  let out = "";
  for (const [name, attr] of Object.entries(spec)) {
    const value = resolve(attr, source);
    if (value !== null) out += ` ${name}="${xmlText(value)}"`;
  }
  return out;
}

export interface SkippedListing {
  id: string;
  title: string;
  /** The portal elements that were required and came out empty. */
  missing: string[];
}

export interface BuiltFeed {
  xml: string;
  included: number;
  skipped: SkippedListing[];
}

/**
 * The feed of one portal for one vertical. A listing whose required elements come out empty is
 * left out of the XML and reported in `skipped`: a portal that receives an incomplete item drops
 * it, or the whole file, without saying which.
 */
export function buildFeed(
  portal: Portal,
  vertical: string,
  listings: FeedListing[],
  settings: FeedSettings = {}
): BuiltFeed {
  const mappings = portal.verticals[vertical];
  if (!mappings) throw new Error(`${portal.name} has no mapping for the "${vertical}" vertical`);

  const items: string[] = [];
  const skipped: SkippedListing[] = [];
  for (const listing of listings) {
    const source = { ...listing, feed: settings } as unknown as Record<string, unknown>;
    const missing: string[] = [];
    let body = "";
    for (const mapping of mappings) {
      if (mapping.pictures) {
        const pictures = listing.images.slice(0, mapping.pictures.max ?? 30);
        if (pictures.length === 0) {
          if (mapping.required) missing.push(mapping.element);
          continue;
        }
        const inner = pictures
          .map((p) => {
            const title =
              mapping.pictures!.title && p.title
                ? `<${mapping.pictures!.title}>${xmlText(p.title)}</${mapping.pictures!.title}>`
                : "";
            return `<${mapping.pictures!.item}><${mapping.pictures!.url}>${xmlText(p.url)}</${mapping.pictures!.url}>${title}</${mapping.pictures!.item}>`;
          })
          .join("");
        body += `<${mapping.element}>${inner}</${mapping.element}>`;
        continue;
      }
      const value = resolve(mapping, source);
      if (value === null) {
        if (mapping.required) missing.push(mapping.element);
        continue;
      }
      body += `<${mapping.element}${attributesXml(mapping.attributes, source)}>${xmlText(value)}</${mapping.element}>`;
    }
    if (missing.length > 0) {
      skipped.push({ id: listing.id, title: listing.title, missing });
      continue;
    }
    items.push(`<${portal.item}>${body}</${portal.item}>`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<${portal.root}>\n${items.map((i) => `${i}\n`).join("")}</${portal.root}>\n`;
  return { xml, included: items.length, skipped };
}
