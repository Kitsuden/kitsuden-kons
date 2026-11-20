/**
 * `@kitsuden/kon-cardsim/images`: finding each card's image in what the player brought
 * ============================================================================
 *
 * Runs in Node with the browser's own primitives (Blob, File, DecompressionStream, object URLs).
 * IndexedDB and the canvas are the two things Node lacks; the resolver takes the cache and the
 * image processor as parameters, so the chain is tested with the in-memory cache and the
 * byte-checking processor, which are also what the board falls back to.
 */

import { describe, expect, test, vi } from "vitest";

import {
  cardKeys,
  cardUrlsSource,
  createImageResolver,
  createMemoryCache,
  createPrefsStore,
  folderFromFiles,
  loadPack,
  normalizeKey,
  PackError,
  packSource,
  passthroughProcessor,
  runtimesFromSources,
  sniffImageType,
  templateSource,
  zipSource,
  type CardRef,
  type Fetcher,
  type SourceRuntime,
} from "../../kons/kon-cardsim/cardsim.images.client";
import { placeholderSvg } from "../../kons/kon-cardsim/cardsim.placeholder";
import { readZip, ZipError } from "../../kons/kon-cardsim/cardsim.zip";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A real 1×1 PNG. */
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0)
);
const png = (tag = "") => new Blob([PNG, new TextEncoder().encode(tag)], { type: "image/png" });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const ZORO: CardRef = { key: "OP01-025", id: "OP01-025", name: "Roronoa Zoro" };
const NAMI: CardRef = { key: "Nami", name: "Nami" };

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Builds a zip: `[name, bytes, deflate?, declaredSize?]`. CRCs are 0 (the reader does not use them). */
async function buildZip(
  files: Array<[string, Uint8Array, boolean?, number?]>
): Promise<Blob> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, raw, deflate, declared] of files) {
    const nameBytes = enc.encode(name);
    const body = deflate ? await deflateRaw(raw) : raw;
    const size = declared ?? raw.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, deflate ? 8 : 0, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(10, deflate ? 8 : 0, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    const localBytes = new Uint8Array([...new Uint8Array(local.buffer), ...nameBytes, ...body]);
    locals.push(localBytes);
    centrals.push(new Uint8Array([...new Uint8Array(central.buffer), ...nameBytes]));
    offset += localBytes.length;
  }
  const dirSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, dirSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, new Uint8Array(eocd.buffer)] as BlobPart[]);
}

/** A fetcher over a map of URL → body (Blob or string) or status; anything else is a CORS refusal. */
function fakeFetch(routes: Record<string, Blob | string | number>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const hit = routes[url];
    if (hit === undefined) throw new TypeError("Failed to fetch");
    if (typeof hit === "number") return new Response(null, { status: hit });
    return new Response(hit, { status: 200 });
  };
  return { fetcher, calls };
}

function source(kind: SourceRuntime["kind"], label: string, find: SourceRuntime["find"]): SourceRuntime {
  return { kind, label, find };
}

function resolverWithCounters(game = "op") {
  let created = 0;
  const revoked: string[] = [];
  const cache = createMemoryCache();
  const resolver = createImageResolver({
    game,
    cache,
    processor: passthroughProcessor,
    createUrl: () => `blob:test/${++created}`,
    revokeUrl: (u) => revoked.push(u),
  });
  return { resolver, cache, revoked, created: () => created };
}

// ── Keys ─────────────────────────────────────────────────────────────────────

describe("keys", () => {
  test("names and ids normalize the way files are named", () => {
    expect(normalizeKey("Roronoa Zoro")).toBe("roronoa-zoro");
    expect(normalizeKey("Pokémon Trainer's Ball!")).toBe("pokemon-trainer-s-ball");
    expect(normalizeKey("OP01-025")).toBe("op01-025");
    expect(cardKeys(ZORO)).toEqual(["op01-025", "roronoa-zoro"]);
  });
});

// ── Zip ──────────────────────────────────────────────────────────────────────

describe("zip", () => {
  test("lists files (not folders) and reads stored and deflated entries", async () => {
    const zip = await buildZip([
      ["cards/", new Uint8Array()],
      ["cards/OP01-025.png", PNG],
      ["cards/Nami.png", PNG, true],
    ]);
    const entries = await readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["cards/OP01-025.png", "cards/Nami.png"]);
    const inflated = new Uint8Array(await (await entries[1].blob()).arrayBuffer());
    expect(inflated).toEqual(PNG);
  });

  test("an entry that inflates past its declared size is stopped (zip bomb)", async () => {
    const big = new Uint8Array(200_000); // zeros: compress to almost nothing
    const zip = await buildZip([["bomb.png", big, true, 100]]);
    const [entry] = await readZip(zip);
    await expect(entry.blob()).rejects.toThrow(ZipError);
  });

  test("entries over the cap are skipped, a non-zip is refused", async () => {
    const zip = await buildZip([["huge.png", PNG, false, 20 * 1024 * 1024]]);
    expect(await readZip(zip)).toEqual([]);
    await expect(readZip(new Blob(["not a zip at all"]))).rejects.toThrow(ZipError);
  });

  test("a zip source finds cards by id and by name", async () => {
    const zip = await buildZip([
      ["set1/OP01-025.png", PNG],
      ["set1/nami.PNG", PNG, true],
      ["readme.txt", new TextEncoder().encode("hi")],
    ]);
    const src = await zipSource("set1.zip", zip);
    expect(await src.find(ZORO)).toMatchObject({ blob: expect.any(Blob) });
    expect(await src.find(NAMI)).toMatchObject({ blob: expect.any(Blob) });
    expect(await src.find({ key: "x", name: "Luffy" })).toBeNull();
  });
});

// ── Bytes ────────────────────────────────────────────────────────────────────

describe("what counts as an image", () => {
  test("the real type comes from the bytes, not the label", async () => {
    expect(await sniffImageType(new Blob([PNG], { type: "text/plain" }))).toBe("image/png");
    expect(await sniffImageType(new Blob([JPEG]))).toBe("image/jpeg");
    expect(await sniffImageType(new Blob(["<svg xmlns='http://www.w3.org/2000/svg'/>"], { type: "image/svg+xml" }))).toBeNull();
  });

  test("the processor refuses SVG, text, empty and oversized files", async () => {
    await expect(passthroughProcessor.normalize(new Blob(["<svg/>"], { type: "image/svg+xml" }))).rejects.toThrow();
    await expect(passthroughProcessor.normalize(new Blob(["hello"]))).rejects.toThrow();
    await expect(passthroughProcessor.normalize(new Blob([]))).rejects.toThrow();
    const huge = new Blob([PNG, new Uint8Array(16 * 1024 * 1024)]);
    await expect(passthroughProcessor.normalize(huge)).rejects.toThrow(/15 MB/);
    expect((await passthroughProcessor.normalize(new Blob([PNG]))).type).toBe("image/png");
  });
});

// ── Sources ──────────────────────────────────────────────────────────────────

describe("sources", () => {
  test("a folder matches by id first, then by name, ignoring case and accents", async () => {
    const files = [
      new File([png("zoro")], "OP01-025.webp"),
      new File([png("nami")], "NAMI.png"),
      new File([png("x")], "notes.txt"),
    ];
    const src = folderFromFiles("My scans", files);
    expect(await src.find(ZORO)).not.toBeNull();
    expect(await src.find({ key: "Námi", name: "Námi" })).not.toBeNull();
    expect(await src.find({ key: "notes", name: "notes" })).toBeNull();
  });

  test("a template fetches one card, without cookies or referrer", async () => {
    const { fetcher, calls } = fakeFetch({ "https://img.example.org/OP01-025.webp": png() });
    const spy = vi.fn(fetcher);
    const src = templateSource("Mirror", "https://img.example.org/{id}.webp", spy);
    expect(await src.find(ZORO)).toMatchObject({ blob: expect.any(Blob) });
    expect(calls).toEqual(["https://img.example.org/OP01-025.webp"]);
    expect(spy.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", mode: "cors" });
  });

  test("a 404 is 'not here'; a CORS refusal hands back the link for an <img>", async () => {
    const { fetcher } = fakeFetch({ "https://img.example.org/Nami.webp": 404 });
    const src = templateSource("Mirror", "https://img.example.org/{name}.webp", fetcher);
    expect(await src.find(NAMI)).toBeNull();
    const cors = templateSource("Other", "https://nocors.example.org/{id}.png", fetcher);
    expect(await cors.find(ZORO)).toEqual({ directUrl: "https://nocors.example.org/OP01-025.png" });
  });

  test("a refused link is never fetched", async () => {
    const { fetcher, calls } = fakeFetch({});
    const src = templateSource("LAN", "https://192.168.1.4/{id}.png", fetcher);
    expect(await src.find(ZORO)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("per-card links match the card's keys, also normalized", async () => {
    const { fetcher } = fakeFetch({ "https://e.org/z.png": png(), "https://e.org/n.png": png() });
    const src = cardUrlsSource("Fixes", { "op01-025": "https://e.org/z.png", Nami: "https://e.org/n.png" }, fetcher);
    expect(await src.find(ZORO)).not.toBeNull();
    expect(await src.find(NAMI)).not.toBeNull();
  });

  const PACK = {
    format: "kitsuden-cardsim-pack",
    version: 1,
    game: "op",
    name: "Scans",
    template: "https://pack.example.org/{id}.webp",
    cards: { "OP01-025": "https://pack.example.org/alt/zoro.webp" },
  };

  test("a pack's own links win over its template, and the pack loads once", async () => {
    const { fetcher, calls } = fakeFetch({
      "https://friend.example.net/pack.json": JSON.stringify(PACK),
      "https://pack.example.org/alt/zoro.webp": png(),
      "https://pack.example.org/Nami.webp": png(),
    });
    const src = packSource("Friend", "https://friend.example.net/pack.json", fetcher, "op");
    expect(await src.find(ZORO)).not.toBeNull();
    expect(await src.find(NAMI)).not.toBeNull();
    expect(calls.filter((c) => c.endsWith("pack.json"))).toHaveLength(1);
    expect(calls).toContain("https://pack.example.org/alt/zoro.webp");
  });

  test("a pack is refused with a reason: other game, not JSON, not a pack, too big", async () => {
    const url = "https://friend.example.net/p.json";
    const load = (body: string | Blob) => loadPack(url, fakeFetch({ [url]: body }).fetcher, "op");
    await expect(load(JSON.stringify({ ...PACK, game: "lorcana" }))).rejects.toThrow(/lorcana/);
    await expect(load("{nope")).rejects.toThrow(PackError);
    await expect(load(JSON.stringify({ hello: 1 }))).rejects.toThrow(/Not a valid pack/);
    await expect(load(new Blob([new Uint8Array(5 * 1024 * 1024)]))).rejects.toThrow(/4 MB/);
    await expect(loadPack("http://friend.example.net/p.json", fakeFetch({}).fetcher)).rejects.toThrow(/https/);
  });

  test("settings become sources: disabled skipped, local ones only when open here", () => {
    const { fetcher } = fakeFetch({});
    const folder = source("folder", "My scans", async () => null);
    const { runtimes, missing } = runtimesFromSources(
      [
        { kind: "folder", label: "My scans", enabled: true },
        { kind: "zip", label: "old.zip", enabled: true },
        { kind: "template", label: "T", url: "https://e.org/{id}.png", enabled: false },
        { kind: "pack", label: "P", url: "https://e.org/p.json", enabled: true },
        { kind: "dropped", label: "Dropped", enabled: true },
      ],
      { fetcher, local: new Map([["folder:My scans", folder]]) }
    );
    expect(runtimes.map((r) => `${r.kind}:${r.label}`)).toEqual(["folder:My scans", "pack:P"]);
    expect(missing.map((m) => m.label)).toEqual(["old.zip"]);
  });
});

// ── The chain ────────────────────────────────────────────────────────────────

describe("the resolver", () => {
  test("tries sources in the player's order and caches the first image", async () => {
    const { resolver, cache } = resolverWithCounters();
    const second = vi.fn(async () => ({ blob: png("second") }));
    resolver.setSources([
      source("folder", "A", async () => ({ blob: png("first") })),
      source("template", "B", second),
    ]);
    const r = await resolver.resolve(ZORO);
    expect(r).toMatchObject({ origin: "folder", label: "A", cached: true });
    expect(second).not.toHaveBeenCalled();
    expect((await cache.usage("op")).count).toBe(1);
  });

  test("a broken source or a non-image does not stop the chain", async () => {
    const { resolver } = resolverWithCounters();
    resolver.setSources([
      source("pack", "Broken", async () => {
        throw new Error("boom");
      }),
      source("template", "Text", async () => ({ blob: new Blob(["<html>"]) })),
      source("zip", "Good", async () => ({ blob: png() })),
    ]);
    expect(await resolver.resolve(ZORO)).toMatchObject({ origin: "zip", label: "Good" });
  });

  test("the cache answers next time, even after the sources are gone (offline)", async () => {
    const cache = createMemoryCache();
    const make = () =>
      createImageResolver({ game: "op", cache, processor: passthroughProcessor, createUrl: () => "blob:x", revokeUrl: () => {} });
    const first = make();
    first.setSources([source("folder", "A", async () => ({ blob: png() }))]);
    await first.resolve(ZORO);
    const again = make(); // a reload: new resolver, no sources yet
    expect(await again.resolve(ZORO)).toMatchObject({ cached: true, origin: "folder" });
  });

  test("two boards asking at once search once", async () => {
    const { resolver } = resolverWithCounters();
    const find = vi.fn(async () => ({ blob: png() }));
    resolver.setSources([source("folder", "A", find)]);
    await Promise.all([resolver.resolve(ZORO), resolver.resolve(ZORO), resolver.resolve(ZORO)]);
    expect(find).toHaveBeenCalledTimes(1);
  });

  test("with nothing found the card is drawn; a direct link is used only if nothing can be cached", async () => {
    const { resolver } = resolverWithCounters();
    resolver.setSources([]);
    expect(await resolver.resolve(NAMI)).toMatchObject({ origin: "placeholder", cached: false });

    const { resolver: r2 } = resolverWithCounters();
    r2.setSources([
      source("template", "NoCors", async () => ({ directUrl: "https://nocors.example.org/z.png" })),
      source("folder", "Local", async () => ({ blob: png() })),
    ]);
    expect(await r2.resolve(ZORO)).toMatchObject({ origin: "folder", cached: true });

    const { resolver: r3 } = resolverWithCounters();
    r3.setSources([source("template", "NoCors", async () => ({ directUrl: "https://nocors.example.org/z.png" }))]);
    expect(await r3.resolve(ZORO)).toMatchObject({ direct: true, url: "https://nocors.example.org/z.png" });
    expect(r3.fallback(ZORO)).toMatchObject({ origin: "placeholder" });
  });

  test("a dropped image wins, is cached and tells the board", async () => {
    const { resolver } = resolverWithCounters();
    resolver.setSources([source("folder", "A", async () => ({ blob: png() }))]);
    await resolver.resolve(ZORO);
    const changed: string[] = [];
    resolver.onChange((k) => changed.push(k));
    const r = await resolver.putDropped(ZORO, png("mine"));
    expect(r).toMatchObject({ origin: "dropped", cached: true });
    expect(changed).toEqual(["OP01-025"]);
    expect(await resolver.resolve(ZORO)).toBe(r);
    await expect(resolver.putDropped(NAMI, new Blob(["<svg/>"]))).rejects.toThrow();
  });

  test("new sources re-search what was drawn, not what was cached", async () => {
    const { resolver } = resolverWithCounters();
    resolver.setSources([source("folder", "A", async (c) => (c.key === ZORO.key ? { blob: png() } : null))]);
    await resolver.resolve(ZORO);
    expect((await resolver.resolve(NAMI)).origin).toBe("placeholder");
    resolver.setSources([source("zip", "B", async () => ({ blob: png() }))]);
    expect((await resolver.resolve(NAMI)).origin).toBe("zip");
    expect((await resolver.resolve(ZORO)).origin).toBe("folder");
  });

  test("clearing and disposing revoke every object URL handed out", async () => {
    const { resolver, revoked, created } = resolverWithCounters();
    resolver.setSources([source("folder", "A", async () => ({ blob: png() }))]);
    await resolver.resolve(ZORO);
    await resolver.resolve(NAMI);
    await resolver.clearCache();
    expect(revoked).toHaveLength(2);
    expect((await resolver.usage()).count).toBe(0);
    await resolver.resolve(ZORO);
    resolver.dispose();
    expect(revoked).toHaveLength(created());
  });

  test("resolveBlob gives bytes for textures, and a drawn card when nothing exists", async () => {
    const { resolver } = resolverWithCounters();
    resolver.setSources([source("folder", "A", async (c) => (c.key === ZORO.key ? { blob: png() } : null))]);
    expect((await resolver.resolveBlob(ZORO))?.type).toBe("image/png");
    expect((await resolver.resolveBlob(NAMI))?.type).toBe("image/svg+xml");
  });
});

// ── The drawn card ───────────────────────────────────────────────────────────

describe("the card drawn by code", () => {
  test("same card, same drawing; different cards, different colors", () => {
    expect(placeholderSvg({ name: "Nami" })).toBe(placeholderSvg({ name: "Nami" }));
    expect(placeholderSvg({ name: "Nami", key: "a" })).not.toBe(placeholderSvg({ name: "Nami", key: "b" }));
  });

  test("works with only a name, and shows cost, type and color when known", () => {
    const only = placeholderSvg({ name: "Roronoa Zoro" });
    expect(only).toContain("Roronoa Zoro");
    const full = placeholderSvg({ name: "Zoro", cost: 3, type: "Character", color: "Black" });
    expect(full).toContain(">3<");
    expect(full).toContain("Character");
    expect(full).toContain("#1f1f24");
  });

  test("names are escaped: a pasted list cannot inject markup", () => {
    const svg = placeholderSvg({ name: `<script>alert(1)</script> & "quotes"` });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
  });

  test("long names wrap and end in an ellipsis", () => {
    const svg = placeholderSvg({ name: "A very long card name that keeps going and going far past four lines of text" });
    expect(svg.match(/<text /g)!.length).toBeLessThanOrEqual(4);
    expect(svg).toContain("…");
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe("settings through the kon", () => {
  const SOURCES = [{ kind: "folder" as const, label: "My scans", enabled: true }];

  function memoryStorage() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  }

  test("without a kon they live in this browser", async () => {
    const storage = memoryStorage();
    const store = createPrefsStore({ game: "op", storage });
    expect(await store.save(SOURCES)).toMatchObject({ synced: false });
    expect(await store.load()).toEqual({ sources: SOURCES, synced: false });
  });

  test("with a session they are saved to and read from the kon", async () => {
    const storage = memoryStorage();
    const sent: { url: string; init?: RequestInit }[] = [];
    const fetcher: Fetcher = async (url, init) => {
      sent.push({ url, init });
      if (init?.method === "PUT") return new Response(JSON.stringify({ data: {} }), { status: 200 });
      return new Response(JSON.stringify({ data: { sources: SOURCES } }), { status: 200 });
    };
    const store = createPrefsStore({ game: "op", apiBase: "https://api.example.org/api/cardsim/", fetcher, storage });
    expect(await store.save(SOURCES)).toMatchObject({ synced: true });
    expect(sent[0].url).toBe("https://api.example.org/api/cardsim/image-prefs/op");
    expect(sent[0].init).toMatchObject({ method: "PUT", credentials: "include" });
    expect(JSON.parse(String(sent[0].init!.body))).toEqual({ sources: SOURCES });
    expect(await store.load()).toEqual({ sources: SOURCES, synced: true });
  });

  test("no session (401) or offline falls back to this browser's copy", async () => {
    const storage = memoryStorage();
    await createPrefsStore({ game: "op", storage }).save(SOURCES);
    const unauthorized: Fetcher = async () => new Response("{}", { status: 401 });
    expect(await createPrefsStore({ game: "op", apiBase: "https://a.example.org", fetcher: unauthorized, storage }).load()).toEqual({
      sources: SOURCES,
      synced: false,
    });
    const offline: Fetcher = async () => {
      throw new TypeError("offline");
    };
    expect((await createPrefsStore({ game: "op", apiBase: "https://a.example.org", fetcher: offline, storage }).load()).synced).toBe(false);
  });

  test("invalid settings are not saved anywhere", async () => {
    const storage = memoryStorage();
    const fetcher = vi.fn<Fetcher>(async () => new Response("{}"));
    const store = createPrefsStore({ game: "op", apiBase: "https://a.example.org", fetcher, storage });
    const r = await store.save([{ kind: "pack", label: "P", url: "http://insecure.example.org/p.json", enabled: true }]);
    expect(r.error).toMatch(/Link refused/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(storage.m.size).toBe(0);
  });
});
