/**
 * Card images: who brings them, and what the server may say about them
 * ============================================================================
 *
 * A game is in one of two image modes:
 *
 *   · `hosted` — the catalog carries `imageUrl`, and the API returns it. What the kon always did.
 *   · `byod`   — "bring your own data": the server never names an image. Every player brings
 *                their own (a folder, a zip, a URL template, a community pack…) and it stays in
 *                their browser (`./images`, `cardsim.images.client.ts`).
 *
 * ── WHAT THE SERVER KEEPS IN BYOD ──────────────────────────────────────────
 *
 * Settings, never pictures: the ORDER of a person's sources and the links they typed. A local
 * folder or a zip is stored as "there is one, called X", with no path and no file. The server
 * never downloads, proxies or caches an image: if it did, it would be distributing it again,
 * which is exactly what this mode exists to avoid.
 *
 * ── WHY STRIPPING HAPPENS ON THE WAY OUT ───────────────────────────────────
 *
 * The rows keep their `imageUrl`: switching a game back to `hosted` must not need a re-import.
 * Every route that returns cards passes them through `stripCardImages`, and
 * `tests/unit/cardsim-byod-no-image-urls.test.ts` walks EVERY operation of the kon to prove no
 * response names an image in a `byod` game.
 *
 * This file is pure (no DOM, no Node): the server and the browser module share it.
 */

import { z } from "@kitsuden/engine/zod";

// ── Image mode ───────────────────────────────────────────────────────────────

export const IMAGE_MODES = ["hosted", "byod"] as const;
export type ImageMode = (typeof IMAGE_MODES)[number];

export const ImageModeSchema = z.enum(IMAGE_MODES);

/** Anything that is not exactly `byod` is `hosted`: an unknown value never hides less. */
export const isByod = (mode: unknown): boolean => mode === "byod";

// ── What counts as "naming an image" ─────────────────────────────────────────

/** Words that name a picture in the catalogs we know (dataset fields, scraper dumps). */
const IMAGE_WORDS = new Set([
  "image",
  "images",
  "img",
  "imgs",
  "art",
  "arts",
  "artwork",
  "picture",
  "pictures",
  "pic",
  "pics",
  "photo",
  "thumb",
  "thumbnail",
  "icon",
  "sprite",
  "illustration",
  "scan",
  "imagen",
  "imagenes",
  "ilustracion",
]);

/**
 * Is this key a picture? `imageUrl`, `image_key`, `art-crop`, `thumbnail`: the key is split into
 * words (camelCase, `_`, `-`) and any picture word marks it. `artist` or `description` are not.
 */
export function isImageKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_\-.]+/)
    .filter(Boolean);
  return words.some((w) => IMAGE_WORDS.has(w));
}

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|avif|bmp|svg|jxl|tiff?)(\?|#|$)/i;

/**
 * Does this string point at an image?
 *
 * A URL with an image extension, any absolute `http(s)`/protocol-relative URL under a media path,
 * a `data:image/` URI, or a site path to an image. Plain text ("Draw 2 cards") is never one.
 */
export function looksLikeImageUrl(value: string): boolean {
  const v = value.trim();
  if (v.length < 4 || v.length > 4096) return false;
  if (/^data:image\//i.test(v)) return true;
  const isUrl = /^(https?:)?\/\//i.test(v);
  const isPath = v.startsWith("/");
  if (!isUrl && !isPath) return false;
  if (IMAGE_EXTENSION.test(v)) return true;
  return /\/(media|images?|img|cards?|cartas|art|assets|uploads|cdn)\//i.test(v);
}

const MAX_DEPTH = 6;

/** A copy of `value` with every image key and every image-looking string removed. */
function scrub(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof value === "string") return looksLikeImageUrl(value) ? undefined : value;
  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, depth + 1)).filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (isImageKey(key)) continue;
      const kept = scrub(inner, depth + 1);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  }
  return value;
}

/**
 * A card (or any card-shaped object) as it may leave the server in `byod`: no `imageUrl`, and
 * its `data` without image fields. In `hosted` it comes back untouched.
 *
 * `data` is scrubbed too because a dataset sync copies the WHOLE row (`cardsim.dataset.ts`), and
 * the dataset's image field travels inside it.
 */
export function stripCardImages<T extends object>(card: T, mode: unknown): T {
  if (!isByod(mode) || !card) return card;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(card)) {
    if (isImageKey(key)) continue;
    out[key] = key === "data" ? (scrub(value, 0) ?? {}) : value;
  }
  return out as T;
}

// ── Links people type ────────────────────────────────────────────────────────

export const MAX_URL_LENGTH = 600;

/** IPv4 literals that are not on the public internet. */
function privateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * Why a link a person typed (a template, a pack, a per-card URL) is refused, or `null` if it is
 * fine.
 *
 * The browser fetches these, not the server, so this is not SSRF protection for the server.
 * It protects the OTHER player: a link shared through a room must not make their browser
 * probe their router or their localhost. Only `https:`, a public host name, no credentials.
 */
export function urlProblem(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return "empty";
  if (raw.length > MAX_URL_LENGTH) return `longer than ${MAX_URL_LENGTH} characters`;
  // Placeholders are checked as if they were a plain value.
  const probe = raw.replaceAll("{id}", "x").replaceAll("{name}", "x");
  let url: URL;
  try {
    url = new URL(probe);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:") return "only https: links";
  if (url.username || url.password) return "no user or password in the link";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !host.includes(":")) return "not a public host";
  if (host === "localhost" || host.endsWith(".localhost")) return "not a public host";
  if (/\.(local|internal|lan|home|corp|intranet|test|invalid|example)$/.test(host)) {
    return "not a public host";
  }
  if (privateIpv4(host)) return "not a public host";
  if (host.includes(":")) {
    // IPv6 literal: loopback, unique-local and link-local are private.
    if (host === "::1" || host === "::" || /^(fc|fd|fe8|fe9|fea|feb)/.test(host)) {
      return "not a public host";
    }
    if (host.startsWith("::ffff:")) return "not a public host";
  }
  return null;
}

const SafeUrl = z
  .string()
  .max(MAX_URL_LENGTH)
  .superRefine((v, ctx) => {
    const problem = urlProblem(v);
    if (problem) ctx.addIssue({ code: "custom", message: `Link refused: ${problem}` });
  });

/** A URL template must say where the card goes. */
const TemplateUrl = SafeUrl.refine((v) => v.includes("{id}") || v.includes("{name}"), {
  message: "A template needs {id} or {name}",
});

/**
 * The URL for one card from a template. `{id}` and `{name}` are percent-encoded, so a card
 * called "../../admin" cannot leave the path the person wrote.
 */
export function expandTemplate(template: string, card: { id: string; name?: string }): string {
  return template
    .replaceAll("{id}", encodeURIComponent(card.id))
    .replaceAll("{name}", encodeURIComponent(card.name ?? card.id));
}

// ── A person's image sources (stored by the kon, per account and game) ───────

export const MAX_SOURCES = 20;
export const MAX_CARD_URLS = 2000;
export const MAX_LABEL = 80;

const Label = z.string().trim().min(1).max(MAX_LABEL);

/**
 * One source. The kinds a browser holds (folder, zip, dropped images) are stored as a name only:
 * the files never leave the browser, so on another device the source shows as "not on this
 * device" until the person picks the folder again.
 */
export const ImageSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), label: Label, enabled: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal("zip"), label: Label, enabled: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal("dropped"), label: Label, enabled: z.boolean().default(true) }).strict(),
  z
    .object({
      kind: z.literal("template"),
      label: Label,
      url: TemplateUrl,
      enabled: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cardUrls"),
      label: Label,
      /** Card key (id or name) → link. */
      urls: z
        .record(z.string().min(1).max(200), SafeUrl)
        .refine((r) => Object.keys(r).length <= MAX_CARD_URLS, {
          message: `At most ${MAX_CARD_URLS} card links`,
        }),
      enabled: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pack"),
      label: Label,
      url: SafeUrl,
      enabled: z.boolean().default(true),
    })
    .strict(),
]);
export type ImageSource = z.infer<typeof ImageSourceSchema>;

/** A game key: the cardsim slug, or the site's own game slug (the board also runs offline). */
export const GameKeySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes");

export const ImagePrefsSchema = z
  .object({
    /** In the order the browser tries them. */
    sources: z.array(ImageSourceSchema).max(MAX_SOURCES),
  })
  .strict();
export type ImagePrefs = z.infer<typeof ImagePrefsSchema>;

// ── Community packs ──────────────────────────────────────────────────────────

export const PACK_FORMAT = "kitsuden-cardsim-pack";
export const MAX_PACK_CARDS = 30_000;
/** A pack is read by a browser: 4 MB of JSON is already a lot of links. */
export const MAX_PACK_BYTES = 4 * 1024 * 1024;

/**
 * A community pack: a JSON file SOMEONE ELSE hosts, mapping cards to image links. The kon never
 * lists, recommends or fetches packs — a person pastes the link of one they chose.
 *
 *     {
 *       "format": "kitsuden-cardsim-pack",
 *       "version": 1,
 *       "game": "one-piece-card-game",
 *       "name": "My scans",
 *       "keyBy": "id",
 *       "template": "https://example.org/op/{id}.webp",
 *       "cards": { "OP01-001": "https://example.org/op/OP01-001-alt.webp" }
 *     }
 *
 * `cards` wins over `template` for the cards it lists.
 */
export const CommunityPackSchema = z
  .object({
    format: z.literal(PACK_FORMAT),
    version: z.literal(1),
    game: GameKeySchema,
    name: z.string().trim().min(1).max(120),
    keyBy: z.enum(["id", "name"]).default("id"),
    template: TemplateUrl.optional(),
    cards: z
      .record(z.string().min(1).max(200), SafeUrl)
      .refine((r) => Object.keys(r).length <= MAX_PACK_CARDS, {
        message: `At most ${MAX_PACK_CARDS} cards`,
      })
      .default({}),
  })
  .passthrough()
  .refine((p) => p.template !== undefined || Object.keys(p.cards).length > 0, {
    message: "A pack needs a template or at least one card",
  });
export type CommunityPack = z.infer<typeof CommunityPackSchema>;
