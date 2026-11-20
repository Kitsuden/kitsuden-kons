/**
 * `@kitsuden/kon-cardsim/images` — card images the player brings, in the browser
 * ============================================================================
 *
 * In a `byod` game the server never names an image (`cardsim.images.ts`). Each player brings
 * their own, and this module finds the right one for each card:
 *
 *     resolver.resolve({ key: "OP01-001", id: "OP01-001", name: "Roronoa Zoro" })
 *       → 1. the persistent cache (IndexedDB)            — found before? done, offline too
 *       → 2. the player's sources, in THEIR order:
 *            folder · zip · dropped/pasted images · URL template · per-card links · community pack
 *       → 3. a card drawn by code (`cardsim.placeholder.ts`) — the board is always playable
 *
 * What reaches the cache is validated (real image bytes, not the extension), bounded (size and
 * pixels) and re-encoded to a card-sized WebP, so a 40 MB scan does not live in the tab.
 *
 * ── WHAT NEVER LEAVES THE BROWSER ──────────────────────────────────────────
 *
 * Images. The server stores the player's SETTINGS (`/image-prefs`): the order of their sources
 * and the links they typed — a folder is "there is one, called X". Remote images are fetched by
 * the browser straight from where the player pointed, without cookies or referrer.
 *
 * ── HOW OTHER RENDERERS USE IT ─────────────────────────────────────────────
 *
 * `resolve` gives a URL (an object URL, or the remote link when the remote site does not allow
 * reading it — see `direct`). `resolveBlob` gives the bytes, which is what a WebGL/WebGPU engine
 * needs to build a texture. Nothing here depends on Svelte or on the DOM tree.
 */

import {
  CommunityPackSchema,
  expandTemplate,
  ImagePrefsSchema,
  MAX_PACK_BYTES,
  urlProblem,
  type CommunityPack,
  type ImageSource,
} from "./cardsim.images.js";
import { placeholderBlob } from "./cardsim.placeholder.js";
import { readZip } from "./cardsim.zip.js";

export { placeholderBlob, placeholderSvg } from "./cardsim.placeholder.js";
export type { ImageSource, CommunityPack } from "./cardsim.images.js";

// ── Cards and results ────────────────────────────────────────────────────────

/** A card as the board knows it. `key` is what the board indexes by (an id, or a name). */
export interface CardRef {
  key: string;
  id?: string;
  name: string;
  /** Catalog properties, for the drawn card (cost, type, color). */
  data?: Record<string, unknown>;
}

export type ImageOrigin =
  | "cache"
  | "folder"
  | "zip"
  | "dropped"
  | "template"
  | "cardUrls"
  | "pack"
  | "placeholder";

export interface ResolvedImage {
  url: string;
  /** Where the picture came from (for a cache hit: where it came from originally). */
  origin: ImageOrigin;
  /** The source's label, as the player named it. */
  label?: string;
  /** In the persistent cache: it will be there offline and after a reload. */
  cached: boolean;
  /**
   * The remote link itself: the site did not let the browser READ the image (no CORS), so it can
   * be shown in an `<img>` but not cached nor turned into a texture. If it fails to load, call
   * `resolver.fallback(card)`.
   */
  direct?: boolean;
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/** A name or id as a file would be called: `Roronoa Zoro` → `roronoa-zoro`, `OP01-001` → `op01-001`. */
export function normalizeKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The keys a card can be found by, most specific first. */
export function cardKeys(card: CardRef): string[] {
  const out: string[] = [];
  for (const k of [card.id, card.key, card.name]) {
    const n = k ? normalizeKey(k) : "";
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

const IMAGE_FILE = /\.(png|jpe?g|webp|gif|avif)$/i;

/** `cards/OP01/OP01-001.png` → `op01-001`. */
function fileKey(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return normalizeKey(base.replace(/\.[^.]+$/, ""));
}

// ── Validating and shrinking what comes in ───────────────────────────────────

export const MAX_INPUT_BYTES = 15 * 1024 * 1024;
export const MAX_SIDE = 8000;
/** Card-sized: enough for a zoomed card on a retina screen, a fraction of a scan. */
export const TARGET_WIDTH = 480;
export const TARGET_HEIGHT = 672;

export class ImageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRejected";
  }
}

/**
 * The real type from the first bytes. The extension and the server's `content-type` lie often
 * enough; and SVG is refused on purpose: it is a document that can carry scripts and links, not a
 * picture of a card.
 */
export async function sniffImageType(blob: Blob): Promise<string | null> {
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) {
    return "image/avif";
  }
  return null;
}

export interface ImageProcessor {
  /** Checks the image and returns the bytes to keep. Throws `ImageRejected`. */
  normalize(blob: Blob): Promise<Blob>;
}

async function checked(blob: Blob): Promise<string> {
  if (blob.size === 0) throw new ImageRejected("empty file");
  if (blob.size > MAX_INPUT_BYTES) throw new ImageRejected("image larger than 15 MB");
  const type = await sniffImageType(blob);
  if (!type) throw new ImageRejected("not a PNG, JPEG, WebP, GIF or AVIF image");
  return type;
}

/** Checks the bytes and keeps them as they are. For tests and for runtimes without a canvas. */
export const passthroughProcessor: ImageProcessor = {
  async normalize(blob) {
    const type = await checked(blob);
    return blob.type === type ? blob : new Blob([blob], { type });
  },
};

/** Decodes, checks the pixels and re-encodes to a card-sized WebP. Browser only. */
export const canvasProcessor: ImageProcessor = {
  async normalize(blob) {
    await checked(blob);
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      throw new ImageRejected("the image could not be decoded");
    }
    try {
      if (bitmap.width > MAX_SIDE || bitmap.height > MAX_SIDE) {
        throw new ImageRejected(`image larger than ${MAX_SIDE} pixels a side`);
      }
      const scale = Math.min(1, TARGET_WIDTH / bitmap.width, TARGET_HEIGHT / bitmap.height);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
        return await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
      return await new Promise<Blob>((ok, fail) =>
        canvas.toBlob((b) => (b ? ok(b) : fail(new ImageRejected("could not encode"))), "image/webp", 0.85)
      );
    } finally {
      bitmap.close();
    }
  },
};

export const defaultProcessor = (): ImageProcessor =>
  typeof createImageBitmap === "function" ? canvasProcessor : passthroughProcessor;

// ── The persistent cache ─────────────────────────────────────────────────────

export interface CachedImage {
  blob: Blob;
  origin: Exclude<ImageOrigin, "cache" | "placeholder">;
  label?: string;
  at: number;
}

export interface ImageCache {
  get(game: string, key: string): Promise<CachedImage | null>;
  put(game: string, key: string, entry: CachedImage): Promise<void>;
  delete(game: string, key: string): Promise<void>;
  /** One game's images, or all of them. */
  clear(game?: string): Promise<void>;
  usage(game?: string): Promise<{ count: number; bytes: number }>;
}

/** In memory: tests, and browsers where IndexedDB is off (private windows). */
export function createMemoryCache(): ImageCache {
  const rows = new Map<string, CachedImage & { game: string }>();
  const id = (game: string, key: string) => `${game}\u0000${key}`;
  return {
    async get(game, key) {
      const r = rows.get(id(game, key));
      return r ? { blob: r.blob, origin: r.origin, label: r.label, at: r.at } : null;
    },
    async put(game, key, entry) {
      rows.set(id(game, key), { ...entry, game });
    },
    async delete(game, key) {
      rows.delete(id(game, key));
    },
    async clear(game) {
      for (const [k, r] of rows) if (!game || r.game === game) rows.delete(k);
    },
    async usage(game) {
      let count = 0;
      let bytes = 0;
      for (const r of rows.values()) {
        if (game && r.game !== game) continue;
        count++;
        bytes += r.blob.size;
      }
      return { count, bytes };
    },
  };
}

const DB_NAME = "kitsuden-cardsim-images";
const DB_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((ok, fail) => {
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((ok, fail) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("images")) {
        db.createObjectStore("images", { keyPath: "id" }).createIndex("game", "game");
      }
      if (!db.objectStoreNames.contains("folders")) {
        db.createObjectStore("folders", { keyPath: "id" }).createIndex("game", "game");
      }
    };
    open.onsuccess = () => ok(open.result);
    open.onerror = () => fail(open.error);
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

async function store(name: "images" | "folders", mode: IDBTransactionMode) {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

/** IndexedDB, in this browser only. Survives reloads and works offline. */
export function createIndexedDbCache(): ImageCache {
  const id = (game: string, key: string) => `${game}\u0000${key}`;
  const rowsOf = async (game?: string) => {
    const s = await store("images", "readonly");
    return request<Array<CachedImage & { id: string; game: string }>>(
      game ? s.index("game").getAll(game) : s.getAll()
    );
  };
  return {
    async get(game, key) {
      const r = await request<(CachedImage & { id: string }) | undefined>(
        (await store("images", "readonly")).get(id(game, key))
      );
      return r ? { blob: r.blob, origin: r.origin, label: r.label, at: r.at } : null;
    },
    async put(game, key, entry) {
      await request((await store("images", "readwrite")).put({ id: id(game, key), game, key, ...entry }));
    },
    async delete(game, key) {
      await request((await store("images", "readwrite")).delete(id(game, key)));
    },
    async clear(game) {
      if (!game) {
        await request((await store("images", "readwrite")).clear());
        return;
      }
      const ids = (await rowsOf(game)).map((r) => r.id);
      const s = await store("images", "readwrite");
      await Promise.all(ids.map((i) => request(s.delete(i))));
    },
    async usage(game) {
      const rows = await rowsOf(game);
      return { count: rows.length, bytes: rows.reduce((n, r) => n + r.blob.size, 0) };
    },
  };
}

/** IndexedDB when it works, memory when it does not: the board never breaks over storage. */
export async function createBestCache(): Promise<ImageCache> {
  if (typeof indexedDB === "undefined") return createMemoryCache();
  try {
    await openDb();
    return createIndexedDbCache();
  } catch {
    return createMemoryCache();
  }
}

/**
 * Asks the browser not to evict the cache under storage pressure. The browser may say no (or ask
 * the player); the cache works either way, it just may be cleared someday.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

// ── Sources ──────────────────────────────────────────────────────────────────

export type Found = { blob: Blob } | { directUrl: string };

/** A source as the resolver uses it. */
export interface SourceRuntime {
  readonly kind: Exclude<ImageOrigin, "cache" | "placeholder">;
  readonly label: string;
  find(card: CardRef): Promise<Found | null>;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Reads a response body up to `cap` bytes; more is an error, not a truncation. */
async function readCapped(res: Response, cap: number): Promise<Blob> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > cap) throw new ImageRejected("file too large");
  if (!res.body) return res.blob();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new ImageRejected("file too large");
    }
    chunks.push(value);
  }
  return new Blob(chunks as BlobPart[], { type: res.headers.get("content-type") ?? "" });
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetches an image the player pointed at. No cookies, no referrer: the site learns nothing about
 * where it is shown. A 404 is "not here" (next source). A network/CORS refusal returns the link
 * itself for an `<img>` to try, because many image hosts do not send CORS headers.
 */
async function fetchImage(url: string, fetcher: Fetcher): Promise<Found | null> {
  if (urlProblem(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetcher(url, {
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return { blob: await readCapped(res, MAX_INPUT_BYTES) };
  } catch (e) {
    if (e instanceof ImageRejected || controller.signal.aborted) return null;
    return { directUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

interface FileLike {
  name: string;
  blob(): Promise<Blob>;
}

/** Files indexed by normalized base name; the first path (sorted) wins on duplicates. */
function filesSource(kind: "folder" | "zip", label: string, files: FileLike[]): SourceRuntime {
  const index = new Map<string, FileLike>();
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!IMAGE_FILE.test(f.name)) continue;
    const k = fileKey(f.name);
    if (k && !index.has(k)) index.set(k, f);
  }
  return {
    kind,
    label,
    async find(card) {
      for (const k of cardKeys(card)) {
        const f = index.get(k);
        if (f) return { blob: await f.blob() };
      }
      return null;
    },
  };
}

/** A folder chosen with `<input type="file" webkitdirectory>` (every browser). */
export function folderFromFiles(label: string, files: ArrayLike<File>): SourceRuntime {
  return filesSource(
    "folder",
    label,
    Array.from(files).map((f) => ({
      name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
      blob: async () => f,
    }))
  );
}

/** The parts of the File System Access API this module uses (not in every DOM lib yet). */
export interface DirectoryHandleLike {
  kind: "directory";
  name: string;
  values(): AsyncIterable<{ kind: "file" | "directory"; name: string } & Record<string, unknown>>;
  queryPermission?(opts: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(opts: { mode: "read" }): Promise<PermissionState>;
}

const MAX_FOLDER_FILES = 30_000;

/**
 * A folder chosen with `showDirectoryPicker()` (Chromium). Unlike a file list, its handle can be
 * kept (`saveFolderHandle`) and opened again next visit with one click.
 */
export async function folderFromHandle(label: string, handle: DirectoryHandleLike): Promise<SourceRuntime> {
  const files: FileLike[] = [];
  async function walk(dir: DirectoryHandleLike, prefix: string, depth: number) {
    if (depth > 8) return;
    for await (const entry of dir.values()) {
      if (files.length >= MAX_FOLDER_FILES) return;
      if (entry.kind === "directory") {
        await walk(entry as unknown as DirectoryHandleLike, `${prefix}${entry.name}/`, depth + 1);
      } else if (IMAGE_FILE.test(entry.name)) {
        const fileHandle = entry as unknown as { getFile(): Promise<File> };
        files.push({ name: `${prefix}${entry.name}`, blob: () => fileHandle.getFile() });
      }
    }
  }
  await walk(handle, "", 0);
  return filesSource("folder", label, files);
}

/** A zip of images. Read once; each card inflates only its own file. */
export async function zipSource(label: string, archive: Blob): Promise<SourceRuntime> {
  const entries = await readZip(archive);
  return filesSource(
    "zip",
    label,
    entries.map((e) => ({ name: e.name, blob: () => e.blob() }))
  );
}

/** `https://example.org/cards/{id}.webp` → one request per card, only when it is needed. */
export function templateSource(label: string, template: string, fetcher: Fetcher): SourceRuntime {
  return {
    kind: "template",
    label,
    async find(card) {
      return fetchImage(expandTemplate(template, { id: card.id ?? card.key, name: card.name }), fetcher);
    },
  };
}

/** Links lookup by the card's own keys, then by their normalized form. */
function linkIndex(urls: Record<string, string>) {
  const normalized = new Map<string, string>();
  for (const [k, v] of Object.entries(urls)) {
    const n = normalizeKey(k);
    if (n && !normalized.has(n)) normalized.set(n, v);
  }
  return (card: CardRef, keys: (string | undefined)[]): string | null => {
    for (const k of keys) if (k && Object.hasOwn(urls, k)) return urls[k];
    for (const k of cardKeys(card)) {
      const v = normalized.get(k);
      if (v) return v;
    }
    return null;
  };
}

/** One link per card, typed or pasted by the player. */
export function cardUrlsSource(label: string, urls: Record<string, string>, fetcher: Fetcher): SourceRuntime {
  const lookup = linkIndex(urls);
  return {
    kind: "cardUrls",
    label,
    async find(card) {
      const url = lookup(card, [card.id, card.key, card.name]);
      return url ? fetchImage(url, fetcher) : null;
    },
  };
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackError";
  }
}

/** Downloads and validates a community pack. Throws `PackError` with a readable reason. */
export async function loadPack(url: string, fetcher: Fetcher, game?: string): Promise<CommunityPack> {
  const problem = urlProblem(url);
  if (problem) throw new PackError(`Link refused: ${problem}`);
  let res: Response;
  try {
    res = await fetcher(url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    throw new PackError("The pack could not be downloaded (the site may not allow it)");
  }
  if (!res.ok) throw new PackError(`The pack answered ${res.status}`);
  let text: string;
  try {
    text = await (await readCapped(res, MAX_PACK_BYTES)).text();
  } catch {
    throw new PackError("The pack is larger than 4 MB");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PackError("The pack is not JSON");
  }
  const parsed = CommunityPackSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new PackError(`Not a valid pack: ${first?.path.join(".") || "file"} — ${first?.message}`);
  }
  if (game && parsed.data.game !== game) {
    throw new PackError(`This pack is for "${parsed.data.game}", not "${game}"`);
  }
  return parsed.data;
}

/** A community pack: loaded once, on the first card that needs it. */
export function packSource(label: string, url: string, fetcher: Fetcher, game?: string): SourceRuntime {
  let pack: Promise<CommunityPack | null> | null = null;
  let lookup: ReturnType<typeof linkIndex> | null = null;
  return {
    kind: "pack",
    label,
    async find(card) {
      pack ??= loadPack(url, fetcher, game).catch(() => null);
      const p = await pack;
      if (!p) return null;
      lookup ??= linkIndex(p.cards);
      const keys = p.keyBy === "name" ? [card.name] : [card.id ?? card.key];
      const link =
        lookup(card, keys) ??
        (p.template
          ? expandTemplate(p.template, { id: card.id ?? card.key, name: card.name })
          : null);
      return link ? fetchImage(link, fetcher) : null;
    },
  };
}

// ── From stored settings to sources ─────────────────────────────────────────

/**
 * The runtimes for a player's settings. Remote kinds are built from the links; local kinds
 * (folder, zip) only exist if this browser has them open right now (`local`, by label), and are
 * reported in `missing` otherwise ("not on this device"). `dropped` needs no runtime: dropped
 * images live in the cache.
 */
export function runtimesFromSources(
  sources: ImageSource[],
  opts: { fetcher: Fetcher; game?: string; local?: Map<string, SourceRuntime> }
): { runtimes: SourceRuntime[]; missing: ImageSource[] } {
  const runtimes: SourceRuntime[] = [];
  const missing: ImageSource[] = [];
  for (const s of sources) {
    if (s.enabled === false) continue;
    switch (s.kind) {
      case "template":
        runtimes.push(templateSource(s.label, s.url, opts.fetcher));
        break;
      case "cardUrls":
        runtimes.push(cardUrlsSource(s.label, s.urls, opts.fetcher));
        break;
      case "pack":
        runtimes.push(packSource(s.label, s.url, opts.fetcher, opts.game));
        break;
      case "folder":
      case "zip": {
        const local = opts.local?.get(`${s.kind}:${s.label}`);
        if (local) runtimes.push(local);
        else missing.push(s);
        break;
      }
      case "dropped":
        break;
    }
  }
  return { runtimes, missing };
}

// ── The resolver ─────────────────────────────────────────────────────────────

export interface ResolverOptions {
  game: string;
  cache?: ImageCache;
  processor?: ImageProcessor;
  /** At most this many sources searched at once (network politeness). */
  concurrency?: number;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

export interface ImageResolver {
  readonly game: string;
  setSources(sources: SourceRuntime[]): void;
  resolve(card: CardRef): Promise<ResolvedImage>;
  /** The bytes, for renderers that build textures. `null` when only a direct link is known. */
  resolveBlob(card: CardRef): Promise<Blob | null>;
  /** The player dropped or pasted an image on this card: it wins over every source. */
  putDropped(card: CardRef, blob: Blob, label?: string): Promise<ResolvedImage>;
  /** A direct link failed to load: draw the card instead. */
  fallback(card: CardRef): ResolvedImage;
  /** Forgets one card's cached image and looks for it again. */
  forget(card: CardRef): Promise<void>;
  clearCache(): Promise<void>;
  usage(): Promise<{ count: number; bytes: number }>;
  /** Called with the card key whenever its image changes. Returns the unsubscribe. */
  onChange(listener: (key: string) => void): () => void;
  /** Revokes every object URL. Call it when the board goes away. */
  dispose(): void;
}

function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((ok) => queue.push(ok));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export function createImageResolver(options: ResolverOptions): ImageResolver {
  const { game } = options;
  const cache = options.cache ?? createMemoryCache();
  const processor = options.processor ?? defaultProcessor();
  const createUrl = options.createUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = options.revokeUrl ?? ((u: string) => URL.revokeObjectURL(u));
  const limit = limiter(options.concurrency ?? 6);

  let sources: SourceRuntime[] = [];
  const handedOut = new Map<string, ResolvedImage>();
  const inflight = new Map<string, Promise<ResolvedImage>>();
  const listeners = new Set<(key: string) => void>();

  const notify = (key: string) => {
    for (const l of listeners) l(key);
  };

  function hand(key: string, result: ResolvedImage): ResolvedImage {
    const prior = handedOut.get(key);
    if (prior && prior.url !== result.url && !prior.direct) revokeUrl(prior.url);
    handedOut.set(key, result);
    return result;
  }

  function drawn(card: CardRef): ResolvedImage {
    const d = card.data ?? {};
    const blob = placeholderBlob({
      name: card.name,
      key: card.id ?? card.key,
      cost: d.cost,
      type: d.type ?? d.category,
      color: d.color ?? d.colors,
    });
    return { url: createUrl(blob), origin: "placeholder", cached: false };
  }

  async function search(card: CardRef): Promise<ResolvedImage> {
    const hit = await cache.get(game, card.key).catch(() => null);
    if (hit) return { url: createUrl(hit.blob), origin: hit.origin, label: hit.label, cached: true };

    let direct: ResolvedImage | null = null;
    for (const source of sources) {
      let found: Found | null = null;
      try {
        found = await limit(() => source.find(card));
      } catch {
        continue; // one broken source never stops the chain
      }
      if (!found) continue;
      if ("directUrl" in found) {
        // Remember the first, but keep looking: a source that can be cached is better.
        direct ??= { url: found.directUrl, origin: source.kind, label: source.label, cached: false, direct: true };
        continue;
      }
      let blob: Blob;
      try {
        blob = await processor.normalize(found.blob);
      } catch {
        continue; // not an image, too big: next source
      }
      const entry: CachedImage = { blob, origin: source.kind, label: source.label, at: Date.now() };
      await cache.put(game, card.key, entry).catch(() => undefined);
      return { url: createUrl(blob), origin: source.kind, label: source.label, cached: true };
    }
    return direct ?? drawn(card);
  }

  const api: ImageResolver = {
    game,
    setSources(next) {
      sources = [...next];
      // What was drawn or linked may now be found: look again. Cached images stay.
      for (const [key, r] of handedOut) {
        if (!r.cached) {
          if (!r.direct) revokeUrl(r.url);
          handedOut.delete(key);
          notify(key);
        }
      }
    },
    resolve(card) {
      const ready = handedOut.get(card.key);
      if (ready) return Promise.resolve(ready);
      let pending = inflight.get(card.key);
      if (!pending) {
        pending = search(card)
          .then((r) => hand(card.key, r))
          .finally(() => inflight.delete(card.key));
        inflight.set(card.key, pending);
      }
      return pending;
    },
    async resolveBlob(card) {
      const hit = await cache.get(game, card.key).catch(() => null);
      if (hit) return hit.blob;
      const r = await api.resolve(card);
      if (r.direct) return null;
      if (r.origin === "placeholder") {
        const d = card.data ?? {};
        return placeholderBlob({ name: card.name, key: card.id ?? card.key, cost: d.cost, type: d.type, color: d.color });
      }
      return (await cache.get(game, card.key))?.blob ?? null;
    },
    async putDropped(card, blob, label = "dropped") {
      const normalized = await processor.normalize(blob);
      await cache.put(game, card.key, { blob: normalized, origin: "dropped", label, at: Date.now() });
      const result = hand(card.key, {
        url: createUrl(normalized),
        origin: "dropped",
        label,
        cached: true,
      });
      notify(card.key);
      return result;
    },
    fallback(card) {
      const result = hand(card.key, drawn(card));
      notify(card.key);
      return result;
    },
    async forget(card) {
      await cache.delete(game, card.key).catch(() => undefined);
      const prior = handedOut.get(card.key);
      if (prior && !prior.direct) revokeUrl(prior.url);
      handedOut.delete(card.key);
      notify(card.key);
    },
    async clearCache() {
      await cache.clear(game);
      for (const [key, r] of handedOut) {
        if (!r.direct) revokeUrl(r.url);
        handedOut.delete(key);
        notify(key);
      }
    },
    usage() {
      return cache.usage(game);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      for (const r of handedOut.values()) if (!r.direct) revokeUrl(r.url);
      handedOut.clear();
      listeners.clear();
    },
  };
  return api;
}

// ── Settings, through the kon (or this browser alone) ───────────────────────

export interface PrefsResult {
  sources: ImageSource[];
  /** True when the kon has them (the player's account); false when only this browser does. */
  synced: boolean;
}

export interface PrefsStore {
  load(): Promise<PrefsResult>;
  /** Validates, keeps a local copy, and saves to the kon when there is a session. */
  save(sources: ImageSource[]): Promise<PrefsResult & { error?: string }>;
}

export interface PrefsStoreOptions {
  game: string;
  /** The kon's base URL (e.g. `https://api.example.org/api/cardsim`). Without it: browser only. */
  apiBase?: string;
  fetcher?: Fetcher;
  storage?: Pick<Storage, "getItem" | "setItem">;
}

const localKey = (game: string) => `kitsuden-cardsim:image-prefs:${game}`;

function safeStorage(storage?: PrefsStoreOptions["storage"]) {
  const s = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  return {
    read(key: string): string | null {
      try {
        return s?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    write(key: string, value: string) {
      try {
        s?.setItem(key, value);
      } catch {
        /* private window, quota: the settings live for this visit */
      }
    },
  };
}

function parseSources(value: unknown): ImageSource[] | null {
  const parsed = ImagePrefsSchema.safeParse({ sources: value });
  return parsed.success ? parsed.data.sources : null;
}

export function createPrefsStore(options: PrefsStoreOptions): PrefsStore {
  const fetcher = options.fetcher ?? ((u, i) => fetch(u, i));
  const storage = safeStorage(options.storage);
  const url = options.apiBase
    ? `${options.apiBase.replace(/\/+$/, "")}/image-prefs/${encodeURIComponent(options.game)}`
    : null;

  const local = (): ImageSource[] => {
    const raw = storage.read(localKey(options.game));
    if (!raw) return [];
    try {
      return parseSources(JSON.parse(raw)) ?? [];
    } catch {
      return [];
    }
  };

  return {
    async load() {
      if (url) {
        try {
          const res = await fetcher(url, { credentials: "include", headers: { accept: "application/json" } });
          if (res.ok) {
            const body = (await res.json()) as { data?: { sources?: unknown } };
            const sources = parseSources(body.data?.sources);
            if (sources) {
              storage.write(localKey(options.game), JSON.stringify(sources));
              return { sources, synced: true };
            }
          }
        } catch {
          /* offline or no session: this browser's copy */
        }
      }
      return { sources: local(), synced: false };
    },
    async save(sources) {
      const parsed = ImagePrefsSchema.safeParse({ sources });
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return { sources: local(), synced: false, error: first?.message ?? "Invalid sources" };
      }
      const clean = parsed.data.sources;
      storage.write(localKey(options.game), JSON.stringify(clean));
      if (!url) return { sources: clean, synced: false };
      try {
        const res = await fetcher(url, {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ sources: clean }),
        });
        return { sources: clean, synced: res.ok };
      } catch {
        return { sources: clean, synced: false };
      }
    },
  };
}

// ── Folder handles, kept for next visit (Chromium) ──────────────────────────

/** Keeps a chosen folder's handle so the next visit reopens it with one click. */
export async function saveFolderHandle(game: string, label: string, handle: DirectoryHandleLike) {
  try {
    await request((await store("folders", "readwrite")).put({ id: `${game}\u0000${label}`, game, label, handle }));
  } catch {
    /* no IndexedDB: the player picks the folder again next time */
  }
}

export async function loadFolderHandles(
  game: string
): Promise<Array<{ label: string; handle: DirectoryHandleLike }>> {
  try {
    const s = await store("folders", "readonly");
    return await request(s.index("game").getAll(game));
  } catch {
    return [];
  }
}

export async function forgetFolderHandle(game: string, label: string) {
  try {
    await request((await store("folders", "readwrite")).delete(`${game}\u0000${label}`));
  } catch {
    /* nothing to forget */
  }
}

/** Read permission for a kept folder. Must be called from a click (the browser may prompt). */
export async function reopenFolder(handle: DirectoryHandleLike): Promise<boolean> {
  try {
    if ((await handle.queryPermission?.({ mode: "read" })) === "granted") return true;
    return (await handle.requestPermission?.({ mode: "read" })) === "granted";
  } catch {
    return false;
  }
}

/** Whether this browser can keep folders between visits. */
export const canPickFolders = (): boolean =>
  typeof window !== "undefined" && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

/** Opens the folder picker (Chromium). `null` if the player cancels. */
export async function pickFolder(): Promise<DirectoryHandleLike | null> {
  try {
    const picker = (window as unknown as { showDirectoryPicker: (o?: object) => Promise<DirectoryHandleLike> })
      .showDirectoryPicker;
    return await picker({ mode: "read" });
  } catch {
    return null;
  }
}
