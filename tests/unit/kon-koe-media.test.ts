/**
 * kon-koe: media — downloads, uploads, voice notes, stickers, quick replies, web chat files
 * ============================================================================
 *
 * The byte-level checks are pure. The rest walks the real routes on PGlite with row-level security, with
 * the queue drained through koe's real handlers, Meta's Graph API replaced by a recorder (koe-bench) and
 * the media sidecar replaced by a fake that answers like media-sidecar/ does.
 *
 * Actors (safe-kons-bench): `a` (agent, support), `b` (agent, sales), `member` (supervisor), `admin`.
 */

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Until index.ts lists quickReplyOperations in MODULES, mount them next to the media operations here.
// Once it does, this shim changes nothing (no route is registered twice).
vi.mock("../../kons/kon-koe/koe.media", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../kons/kon-koe/koe.media")>();
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  if (readFileSync(resolve(__dirname, "../../kons/kon-koe/index.ts"), "utf8").includes("quickReplyOperations")) return orig;
  const { quickReplyOperations } = await import("../../kons/kon-koe/koe.quickreplies");
  return {
    ...orig,
    mediaOperations: ((app, ctx) => {
      orig.mediaOperations(app, ctx);
      quickReplyOperations(app, ctx);
    }) as typeof orig.mediaOperations,
  };
});

import {
  channelFileOf,
  oggOpusInfo,
  parseWaveform,
  processMedia,
  setSidecarConfig,
  setSidecarFetch,
  sha256Matches,
  sniffMime,
  stickerFits,
  webpInfo,
} from "../../kons/kon-koe/koe.media";

import { APP_SECRET, koeBench, waBody, type GraphCall } from "./helpers/koe-bench";
import { ACTORS } from "./helpers/safe-kons-bench";

// ── Files, as their first bytes say ─────────────────────────────────────────

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 3)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(300, 1)]);
const M4A = Buffer.concat([Buffer.from("\x00\x00\x00\x18ftypM4A ", "latin1"), Buffer.alloc(200, 2)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n", "latin1"), Buffer.alloc(200, 0x20)]);

/** A WebP with a VP8X header: width, height, animation flag, total size. */
function webp(w: number, h: number, animated = false, size = 2048): Buffer {
  const b = Buffer.alloc(Math.max(size, 30));
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WEBPVP8X", 8, "latin1");
  b.writeUInt32LE(10, 16);
  b[20] = animated ? 0x02 : 0;
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

/** An OGG/Opus file: OpusHead page, then a last page whose granule position gives the duration. */
function ogg(channels: number, ms: number): Buffer {
  const page = (type: number, granule: bigint, data: Buffer) => {
    const h = Buffer.alloc(27 + 1);
    h.write("OggS", 0, "latin1");
    h[5] = type;
    h.writeBigInt64LE(granule, 6);
    h[26] = 1;
    h[27] = data.length;
    return Buffer.concat([h, data]);
  };
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head[8] = 1;
  head[9] = channels;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48000, 12);
  return Buffer.concat([page(2, 0n, head), page(0, 0n, Buffer.alloc(40, 9)), page(4, BigInt(ms * 48 + 312), Buffer.alloc(60, 5))]);
}

const hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const b64 = (b: Buffer) => createHash("sha256").update(b).digest("base64");
const WAVE = Array.from({ length: 64 }, (_, i) => Math.round((i / 63) * 100) / 100);

// ════════════════════════════════════════════════════════════════════════════
// Pure parts
// ════════════════════════════════════════════════════════════════════════════

describe("what a file is", () => {
  it("sniffs types by their bytes, not by what the browser says", () => {
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(webp(512, 512))).toBe("image/webp");
    expect(sniffMime(WEBM)).toBe("video/webm");
    expect(sniffMime(M4A)).toBe("audio/mp4");
    expect(sniffMime(PDF)).toBe("application/pdf");
    expect(sniffMime(ogg(1, 1000))).toBe("audio/ogg");
    expect(sniffMime(Buffer.from("<html><script>"))).toBeNull();
  });

  it("reads WebP size and animation, and WhatsApp's sticker rule", () => {
    expect(webpInfo(webp(512, 512, true))).toEqual({ width: 512, height: 512, animated: true });
    expect(stickerFits(webp(512, 512, false, 50 * 1024))).toBeTruthy();
    expect(stickerFits(webp(512, 512, false, 150 * 1024))).toBeNull(); // static over 100 KB
    expect(stickerFits(webp(512, 512, true, 400 * 1024))).toBeTruthy();
    expect(stickerFits(webp(512, 512, true, 600 * 1024))).toBeNull();
    expect(stickerFits(webp(256, 512))).toBeNull();
    expect(stickerFits(PNG)).toBeNull();
  });

  it("reads OGG/Opus channels and duration", () => {
    expect(oggOpusInfo(ogg(1, 2500))).toEqual({ channels: 1, durationMs: 2500 });
    expect(oggOpusInfo(ogg(2, 1000))?.channels).toBe(2);
    expect(oggOpusInfo(WEBM)).toBeNull();
  });

  it("matches Meta's sha256 in hex or base64, and parses waveforms defensively", () => {
    expect(sha256Matches(JPEG, hex(JPEG))).toBe(true);
    expect(sha256Matches(JPEG, hex(JPEG).toUpperCase())).toBe(true);
    expect(sha256Matches(JPEG, b64(JPEG))).toBe(true);
    expect(sha256Matches(JPEG, hex(PNG))).toBe(false);
    expect(parseWaveform(JSON.stringify([0, 0.5, 2, -1]))).toEqual([0, 0.5, 1, 0]);
    expect(parseWaveform('["x"]')).toBeNull();
    expect(parseWaveform("not json")).toBeNull();
  });

  it("sends Instagram and Messenger the MP4 copy of a voice note, and WhatsApp the OGG", () => {
    const m = { kind: "voice" as const, mime: "audio/ogg", storageKey: "koe/media/c/v.ogg", playableKey: "koe/media/c/v.playable.m4a" };
    expect(channelFileOf(m, "whatsapp")).toEqual({ key: "koe/media/c/v.ogg", mime: "audio/ogg" });
    expect(channelFileOf(m, "instagram")).toEqual({ key: "koe/media/c/v.playable.m4a", mime: "audio/mp4" });
    expect(channelFileOf(m, "messenger")?.mime).toBe("audio/mp4");
    expect(channelFileOf({ ...m, playableKey: null }, "instagram")?.key).toBe("koe/media/c/v.ogg");
    expect(channelFileOf({ kind: "image", mime: "image/png", storageKey: "k.png", playableKey: null }, "instagram")).toEqual({ key: "k.png", mime: "image/png" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// End to end
// ════════════════════════════════════════════════════════════════════════════

describe("koe media end to end", () => {
  let k: Awaited<ReturnType<typeof koeBench>>;
  const json = async (res: Response): Promise<any> => res.json();
  let support: string;
  let sales: string;
  let conv: string;

  // Inbound files Meta serves: media id → bytes and type.
  const served: Record<string, { bytes: Buffer; mime: string; url?: string; status?: number }> = {
    IMG1: { bytes: JPEG, mime: "image/jpeg" },
    VOICE1: { bytes: ogg(1, 3000), mime: "audio/ogg; codecs=opus" },
    STK1: { bytes: webp(512, 512, false, 4096), mime: "image/webp" },
    EVIL1: { bytes: JPEG, mime: "image/jpeg", url: "https://evil.example.com/steal" },
    FLAKY1: { bytes: PNG, mime: "image/png", status: 500 },
  };

  function responder(call: GraphCall): { status?: number; body: unknown } {
    const lookaside = /^https:\/\/lookaside\.fbsbx\.com\/whatsapp_business\/attachments\/\?mid=(\w+)/.exec(call.url);
    if (lookaside) return { body: served[lookaside[1]!]!.bytes };
    const info = /\/v\d+\.\d\/(\w+)\?phone_number_id=/.exec(call.url);
    if (info && served[info[1]!]) {
      const f = served[info[1]!]!;
      if (f.status) return { status: f.status, body: { error: { message: "Service unavailable", code: 2 } } };
      return { body: { url: f.url ?? `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${info[1]}`, mime_type: f.mime, sha256: hex(f.bytes) } };
    }
    if (call.url.includes("/messages")) return { body: { messages: [{ id: `wamid.out${k.graphCalls.length}` }] } };
    if (call.url.endsWith("/media")) return { body: { id: `wa-media-${k.graphCalls.length}` } };
    return { body: {} };
  }

  // ── The fake sidecar ──────────────────────────────────────────────────
  const sidecarCalls: Array<{ path: string; auth: string | null; type: string | null }> = [];
  function useSidecar(on: boolean) {
    if (!on) return setSidecarConfig(null);
    setSidecarConfig({ url: "http://media.test", token: "sidecar-secret-0123456789" });
    setSidecarFetch(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      sidecarCalls.push({ path: url.pathname, auth: headers.get("authorization"), type: headers.get("content-type") });
      const audio = { "x-duration-ms": "2000", "x-waveform": JSON.stringify(WAVE) };
      if (url.pathname === "/voice") return new Response(new Uint8Array(ogg(1, 2000)), { headers: { "content-type": "audio/ogg", ...audio } });
      if (url.pathname === "/playable") return new Response(new Uint8Array(M4A), { headers: { "content-type": "audio/mp4", ...audio } });
      if (url.pathname === "/sticker") return new Response(new Uint8Array(webp(512, 512, false, 3000)), { headers: { "content-type": "image/webp", "x-animated": "false" } });
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
  }

  function form(fields: Record<string, string | { bytes: Buffer; name: string; type: string }>): FormData {
    const f = new FormData();
    for (const [key, v] of Object.entries(fields)) {
      if (typeof v === "string") f.set(key, v);
      else f.set(key, new File([new Uint8Array(v.bytes)], v.name, { type: v.type }));
    }
    return f;
  }

  const upload = (actor: "a" | "b" | "member", kind: string, bytes: Buffer, name: string, type: string, conversationId?: string) =>
    k.request(actor, "POST", "/media", form({ kind, file: { bytes, name, type }, ...(conversationId ? { conversationId } : {}) }));

  const mediaRow = async (id: string) => (await k.rows<any>("SELECT * FROM koe_media WHERE id = $1", [id]))[0];
  const inboundMedia = async (externalId: string) =>
    (await k.rows<any>("SELECT m.* FROM koe_media m JOIN koe_messages g ON g.media_id = m.id WHERE g.external_id = $1", [externalId]))[0];

  beforeAll(async () => {
    k = await koeBench();
    useSidecar(false);
    for (const [actor, role] of [["a", "agent"], ["b", "agent"], ["member", "supervisor"]] as const) {
      const res = await k.request("admin", "PUT", `/members/${ACTORS[actor].id}`, { role, displayName: ACTORS[actor].name });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    support = (await json(await k.request("member", "POST", "/teams", { slug: "support", name: "Support" }))).data.id;
    sales = (await json(await k.request("member", "POST", "/teams", { slug: "sales", name: "Sales", purpose: "sales" }))).data.id;
    await k.request("member", "PUT", `/teams/${support}/members`, { userIds: [ACTORS.a.id] });
    await k.request("member", "PUT", `/teams/${sales}/members`, { userIds: [ACTORS.b.id] });
    const res = await k.request("admin", "POST", "/channels", {
      kind: "whatsapp",
      name: "Ventas WA",
      externalId: "PN1",
      accountId: "waba-1",
      accessToken: "EAAG-test-token-123",
      appSecret: APP_SECRET,
      defaultTeamId: support,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    k.respondGraph(responder);
  });

  afterAll(async () => {
    setSidecarConfig(undefined);
    setSidecarFetch(null);
    await k?.close();
  });

  it("downloads an inbound image, voice note and sticker before the URL expires, checked and stored", async () => {
    useSidecar(true);
    const now = String(Math.floor(Date.now() / 1000));
    const body = waBody("PN1", {
      contacts: [{ wa_id: "51911", profile: { name: "Lucía" } }],
      messages: [
        { from: "51911", id: "wamid.img1", timestamp: now, type: "image", image: { id: "IMG1", mime_type: "image/jpeg", sha256: b64(JPEG), caption: "mi recibo" } },
        { from: "51911", id: "wamid.voice1", timestamp: now, type: "audio", audio: { id: "VOICE1", mime_type: "audio/ogg; codecs=opus", voice: true } },
        { from: "51911", id: "wamid.stk1", timestamp: now, type: "sticker", sticker: { id: "STK1", mime_type: "image/webp", animated: false } },
      ],
    });
    expect((await k.webhook(body)).status).toBe(200);
    await k.drain();
    conv = (await k.rows<any>("SELECT id FROM koe_conversations"))[0].id;

    const img = await inboundMedia("wamid.img1");
    expect(img).toMatchObject({ status: "ready", mime: "image/jpeg", size_bytes: JPEG.length, sha256: hex(JPEG) });
    expect(img.storage_key).toBe(`koe/media/${conv}/${img.id}.jpg`);
    expect(k.files.get(img.storage_key)?.equals(JPEG)).toBe(true);

    const voice = await inboundMedia("wamid.voice1");
    expect(voice).toMatchObject({ status: "ready", kind: "voice", mime: "audio/ogg", duration_ms: 2000 });
    expect(voice.waveform).toHaveLength(64);
    expect(k.files.get(voice.playable_key)?.equals(M4A)).toBe(true);
    expect(sidecarCalls.find((c) => c.path === "/playable")).toMatchObject({ auth: "Bearer sidecar-secret-0123456789", type: "audio/ogg" });

    // The token goes to Meta's download, never to the sidecar.
    const download = k.graphCalls.find((c) => c.url.includes("mid=IMG1"));
    expect(download).toBeDefined();
    expect(k.opened).toContain("download-media");
    expect(k.broadcasts.some((b) => b.channel === `kon:koe:conversation:${conv}` && b.message.type === "media" && b.message.status === "ready")).toBe(true);
  });

  it("refuses a media URL that is not a Meta host: failed at once, never fetched, never retried", async () => {
    const before = k.graphCalls.length;
    await k.webhook(waBody("PN1", { messages: [{ from: "51911", id: "wamid.evil1", timestamp: String(Math.floor(Date.now() / 1000)), type: "image", image: { id: "EVIL1", mime_type: "image/jpeg" } }] }));
    await expect(k.drain()).resolves.toBeDefined();
    const m = await inboundMedia("wamid.evil1");
    expect(m).toMatchObject({ status: "failed", storage_key: null });
    expect(m.error).toMatch(/Meta host/);
    expect(k.graphCalls.slice(before).some((c) => c.url.includes("evil.example.com"))).toBe(false);
    expect(k.jobs.filter((j) => j.queue === "koe-media")).toHaveLength(0);
  });

  it("a passing outage is retried by the queue; the last attempt gives up", async () => {
    await k.webhook(waBody("PN1", { messages: [{ from: "51911", id: "wamid.flaky1", timestamp: String(Math.floor(Date.now() / 1000)), type: "image", image: { id: "FLAKY1", mime_type: "image/png" } }] }));
    await k.drain(); // the bench runs one attempt of one: it is the last, so it fails
    const m = await inboundMedia("wamid.flaky1");
    expect(m.status).toBe("failed");
    await k.rows("UPDATE koe_media SET status = 'pending', error = NULL WHERE id = $1", [m.id]);
    const job = (attempt: number) => ({ id: "j", queue: "koe-media", name: "download", payload: { mediaId: m.id }, attempt, maxAttempts: 6, actor: null, requestId: null });
    await expect(processMedia(k.ctx, job(1))).rejects.toThrow(); // retryable: the queue tries again
    expect((await mediaRow(m.id)).status).toBe("pending");
    served.FLAKY1!.status = undefined;
    await processMedia(k.ctx, job(2));
    expect(await mediaRow(m.id)).toMatchObject({ status: "ready", sha256: hex(PNG) });
    await processMedia(k.ctx, job(3)); // idempotent: already ready
  });

  it("without a sidecar: a sticker must already fit, a browser recording becomes plain audio and says why", async () => {
    useSidecar(false);
    const calls = sidecarCalls.length;
    const png = await upload("a", "sticker", PNG, "cat.png", "image/png");
    expect(png.status).toBe(422);
    expect((await json(png)).error.details).toMatchObject({ koe: "STICKER_INVALID" });

    const ok = await upload("a", "sticker", webp(512, 512, false, 5000), "ok.webp", "image/webp");
    expect(ok.status, await ok.clone().text()).toBe(201);
    expect((await json(ok)).data).toMatchObject({ kind: "sticker", mime: "image/webp", status: "ready", conversationId: null });

    const rec = await upload("a", "voice", WEBM, "rec.webm", "audio/webm;codecs=opus");
    expect(rec.status).toBe(201);
    const r = await json(rec);
    expect(r.data).toMatchObject({ kind: "audio", mime: "audio/webm" });
    expect(r.notice).toMatch(/No media converter/);

    const mono = await upload("a", "voice", ogg(1, 1500), "note.ogg", "audio/ogg");
    expect((await json(mono)).data).toMatchObject({ kind: "voice", mime: "audio/ogg", durationMs: 1500 });

    // The bytes decide, not the declared type.
    expect((await upload("a", "image", PDF, "x.jpg", "image/jpeg")).status).toBe(422);
    expect((await upload("a", "document", PNG, "x.pdf", "application/pdf")).status).toBe(422);
    expect((await upload("a", "document", PDF, "../../etc/factura.pdf", "application/pdf")).status).toBe(201);
    expect(sidecarCalls.length).toBe(calls);
    expect((await k.request("staff", "POST", "/media", form({ kind: "image", file: { bytes: JPEG, name: "a.jpg", type: "image/jpeg" } }))).status).toBe(403);
  });

  it("with a sidecar: stickers and voice notes are converted, then go out to WhatsApp uploaded once", async () => {
    useSidecar(true);
    const st = await upload("a", "sticker", PNG, "cat.png", "image/png", conv);
    expect(st.status, await st.clone().text()).toBe(201);
    const sticker = (await json(st)).data;
    expect(sticker).toMatchObject({ kind: "sticker", mime: "image/webp", conversationId: conv, animated: false });

    const vn = await upload("a", "voice", WEBM, "rec.webm", "audio/webm;codecs=opus", conv);
    const voice = (await json(vn)).data;
    expect(voice).toMatchObject({ kind: "voice", mime: "audio/ogg", durationMs: 2000 });
    expect(voice.waveform).toHaveLength(64);
    expect(voice.playableUrl).toMatch(/\.playable\.m4a/);
    expect(sidecarCalls.filter((c) => c.path === "/voice").at(-1)).toMatchObject({ type: "audio/webm" });

    const before = k.graphCalls.length;
    for (const [kind, mediaId] of [["sticker", sticker.id], ["voice", voice.id]]) {
      const res = await k.request("a", "POST", `/conversations/${conv}/messages`, { kind, mediaId });
      expect(res.status, await res.clone().text()).toBe(201);
    }
    await k.drain();
    const calls = k.graphCalls.slice(before);
    const uploads = calls.filter((c) => c.url.endsWith("/PN1/media"));
    expect(uploads.map((c) => (c.body as FormData).get("type"))).toEqual(["image/webp", "audio/ogg"]);
    const sent = calls.filter((c) => c.url.endsWith("/PN1/messages")).map((c) => c.body as any);
    expect(sent[0]).toMatchObject({ to: "51911", type: "sticker", sticker: { id: expect.stringMatching(/^wa-media-/) } });
    expect(sent[1]).toMatchObject({ to: "51911", type: "audio", audio: { id: expect.stringMatching(/^wa-media-/) } });
    expect(await k.rows("SELECT 1 FROM koe_messages WHERE direction = 'out' AND status = 'sent'")).toHaveLength(2);
  });

  it("a media file is only visible with its conversation; library media to any member", async () => {
    const img = await inboundMedia("wamid.img1");
    const mine = await json(await k.request("a", "GET", `/media/${img.id}`));
    expect(mine.data).toMatchObject({ id: img.id, status: "ready", url: expect.stringContaining("signed=1") });
    expect(JSON.stringify(mine)).not.toMatch(/storage_key|storageKey/);
    expect((await k.request("b", "GET", `/media/${img.id}`)).status).toBe(404); // another team's conversation
    expect((await k.request("member", "GET", `/media/${img.id}`)).status).toBe(200);
    const lib = (await json(await upload("a", "image", JPEG, "logo.jpg", "image/jpeg"))).data;
    expect((await k.request("b", "GET", `/media/${lib.id}`)).status).toBe(200);
  });

  it("sticker library: keep a received sticker once, every member sees it, only its keeper or a lead removes it", async () => {
    const stk = await inboundMedia("wamid.stk1");
    expect((await k.request("b", "POST", "/stickers", { mediaId: stk.id })).status).toBe(404); // b cannot see that conversation
    const first = await k.request("a", "POST", "/stickers", { mediaId: stk.id, name: "gracias" });
    expect(first.status, await first.clone().text()).toBe(201);
    const kept = (await json(first)).data;
    expect(kept).toMatchObject({ created: true, name: "gracias", media: { conversationId: null, kind: "sticker" } });
    const again = await k.request("a", "POST", "/stickers", { mediaId: stk.id });
    expect(again.status).toBe(200);
    expect((await json(again)).data).toMatchObject({ id: kept.id, created: false });

    const listed = await json(await k.request("b", "GET", "/stickers"));
    expect(listed.data.map((s: any) => s.id)).toEqual([kept.id]);
    expect(listed.data[0].media.url).toMatch(/signed=1/);
    const img = await inboundMedia("wamid.img1");
    expect((await k.request("a", "POST", "/stickers", { mediaId: img.id })).status).toBe(422);

    expect((await k.request("b", "DELETE", `/stickers/${kept.id}`)).status).toBe(403);
    expect((await k.request("a", "DELETE", `/stickers/${kept.id}`)).status).toBe(200);
    expect((await json(await k.request("b", "GET", "/stickers"))).data).toEqual([]);
  });

  it("quick replies: scopes, the / menu, variables, and sending with attachments exactly once", async () => {
    const own = await k.request("a", "POST", "/quick-replies", { shortcut: "/Hola", title: "Saludo", body: "Hola {{contact.name}}, soy {{agent.name}}" });
    expect(own.status, await own.clone().text()).toBe(201);
    const hola = (await json(own)).data;
    expect(hola).toMatchObject({ shortcut: "hola", scope: "personal", ownerId: ACTORS.a.id });
    expect((await k.request("a", "POST", "/quick-replies", { shortcut: "hola", title: "Otra", body: "x" })).status).toBe(409);
    expect((await k.request("a", "POST", "/quick-replies", { shortcut: "pago", title: "Pago", body: "x", scope: "global" })).status).toBe(403);
    expect((await k.request("a", "POST", "/quick-replies", { shortcut: "nada", title: "Nada" })).status).toBe(422);
    expect((await k.request("a", "POST", "/quick-replies", { shortcut: "con espacio", title: "x", body: "x" })).status).toBe(422);

    const sticker = (await json(await upload("member", "sticker", webp(512, 512, false, 3000), "precio.webp", "image/webp"))).data;
    const doc = (await json(await upload("member", "document", PDF, "lista.pdf", "application/pdf"))).data;
    const precios = (
      await json(
        await k.request("member", "POST", "/quick-replies", {
          shortcut: "precios",
          title: "Lista de precios",
          body: "{{contact.name}}, te paso la lista. — {{agent.name}}",
          attachments: [{ mediaId: doc.id }, { mediaId: sticker.id }],
          scope: "global",
        })
      )
    ).data;
    expect((await k.request("member", "POST", "/quick-replies", { shortcut: "ventas", title: "Ventas", body: "Hola", scope: "team" })).status).toBe(422);
    const ventas = (await json(await k.request("member", "POST", "/quick-replies", { shortcut: "ventas", title: "Ventas", body: "Hola", scope: "team", teamId: sales }))).data;
    expect(ventas.scope).toBe("team");

    const shortcuts = async (actor: "a" | "b" | "member", query = "") => (await json(await k.request(actor, "GET", `/quick-replies${query}`))).data.map((r: any) => r.shortcut);
    expect(await shortcuts("a")).toEqual(["hola", "precios"]);
    expect(await shortcuts("b")).toEqual(["precios", "ventas"]);
    expect(await shortcuts("member")).toEqual(["precios", "ventas"]); // a lead does not get others' personal ones
    expect(await shortcuts("a", "?shortcut=pr")).toEqual(["precios"]);
    expect(await shortcuts("a", "?q=saludo")).toEqual(["hola"]);
    const menu = (await json(await k.request("a", "GET", `/quick-replies?shortcut=precios&conversationId=${conv}`))).data[0];
    expect(menu.preview).toBe("Lucía, te paso la lista. — Ana");
    expect(menu.attachments.map((x: any) => x.kind)).toEqual(["document", "sticker"]);

    expect((await k.request("b", "PATCH", `/quick-replies/${hola.id}`, { title: "mío" })).status).toBe(404);
    expect((await k.request("a", "PATCH", `/quick-replies/${precios.id}`, { title: "mío" })).status).toBe(403);
    expect((await k.request("a", "PATCH", `/quick-replies/${hola.id}`, { scope: "global" })).status).toBe(403);
    const patched = await k.request("a", "PATCH", `/quick-replies/${hola.id}`, { title: "Saludo corto" });
    expect((await json(patched)).data.title).toBe("Saludo corto");

    // Sending: the text, then the document, then the sticker, through send(); a retry sends nothing new.
    const before = k.graphCalls.length;
    const res = await k.request("a", "POST", `/conversations/${conv}/quick-replies/${precios.id}/send`, { clientKey: "press-000001" });
    expect(res.status, await res.clone().text()).toBe(201);
    const sent = (await json(res)).data.messages;
    expect(sent.map((m: any) => m.kind)).toEqual(["text", "document", "sticker"]);
    expect(sent[0].body).toBe("Lucía, te paso la lista. — Ana");
    const retry = (await json(await k.request("a", "POST", `/conversations/${conv}/quick-replies/${precios.id}/send`, { clientKey: "press-000001" }))).data.messages;
    expect(retry.map((m: any) => m.id)).toEqual(sent.map((m: any) => m.id));
    await k.drain();
    const out = k.graphCalls.slice(before).filter((c) => c.url.endsWith("/PN1/messages")).map((c) => c.body as any);
    expect(out.map((m) => m.type)).toEqual(["text", "document", "sticker"]);
    expect(out[0].text.body).toBe("Lucía, te paso la lista. — Ana");
    expect(out[1].document).toMatchObject({ filename: "lista.pdf" });

    expect((await k.request("b", "POST", `/conversations/${conv}/quick-replies/${precios.id}/send`, {})).status).toBe(404); // not b's conversation
    expect((await k.request("b", "DELETE", `/quick-replies/${hola.id}`)).status).toBe(404);
    expect((await k.request("a", "DELETE", `/quick-replies/${precios.id}`)).status).toBe(403);
    expect((await k.request("a", "DELETE", `/quick-replies/${hola.id}`)).status).toBe(200);
    expect((await k.request("member", "DELETE", `/quick-replies/${precios.id}`)).status).toBe(200);
  });

  it("web chat: a visitor sends a photo or a PDF, which arrives stored; anything else is refused", async () => {
    const ch = (await json(await k.request("admin", "POST", "/channels", { kind: "webchat", name: "Web" }))).data;
    const visitorId = "visitor-".padEnd(40, "q");
    const send = (file: { bytes: Buffer; name: string; type: string }, clientMessageId: string) =>
      k.request("anon", "POST", `/public/webchat/${ch.externalId}/media`, form({ visitorId, clientMessageId, text: "mira", file }));

    const res = await send({ bytes: PNG, name: "C:\\fotos\\recibo.png", type: "image/png" }, "upload-01");
    expect(res.status, await res.clone().text()).toBe(201);
    const first = (await json(res)).data;
    expect(first.media).toMatchObject({ mime: "image/png", filename: "recibo.png", url: expect.stringContaining("signed=1") });
    const again = (await json(await send({ bytes: PNG, name: "recibo.png", type: "image/png" }, "upload-01"))).data;
    expect(again.id).toBe(first.id);

    const [msg] = await k.rows<any>("SELECT * FROM koe_messages WHERE id = $1", [first.id]);
    expect(msg).toMatchObject({ kind: "image", body: "mira", direction: "in" });
    const media = await mediaRow(msg.media_id);
    expect(media).toMatchObject({ status: "ready", sha256: hex(PNG), conversation_id: msg.conversation_id });
    expect(k.files.get(media.storage_key)?.equals(PNG)).toBe(true);
    expect(await k.rows("SELECT 1 FROM koe_media WHERE conversation_id = $1", [msg.conversation_id])).toHaveLength(1);

    const before = k.graphCalls.length;
    await k.drain(); // the download job finds it ready
    expect(k.graphCalls.length).toBe(before);
    expect((await mediaRow(msg.media_id)).status).toBe("ready");

    expect((await send({ bytes: PDF, name: "factura.pdf", type: "application/pdf" }, "upload-02")).status).toBe(201);
    expect((await send({ bytes: Buffer.from("<html><script>alert(1)</script>"), name: "x.png", type: "image/png" }, "upload-03")).status).toBe(422);
    expect((await send({ bytes: WEBM, name: "v.webm", type: "video/webm" }, "upload-04")).status).toBe(422);
    expect((await send({ bytes: Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]), name: "big.png", type: "image/png" }, "upload-05")).status).toBeGreaterThanOrEqual(413);
    expect((await k.request("anon", "POST", `/public/webchat/nope-key/media`, form({ visitorId, clientMessageId: "upload-06", file: { bytes: PNG, name: "a.png", type: "image/png" } }))).status).toBe(404);

    const history = await json(await k.request("anon", "GET", `/public/webchat/${ch.externalId}/messages?visitorId=${visitorId}`));
    expect(history.data[0]).toMatchObject({ kind: "image", media: { mime: "image/png", url: expect.stringContaining("signed=1") } });
  });
});
