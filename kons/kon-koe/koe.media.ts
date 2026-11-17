/**
 * Media: downloads before the URL expires, uploads, voice notes, stickers
 * ============================================================================
 *
 * In. A channel tells koe a file exists (a WhatsApp media id, a Messenger URL); koe.inbound.ts stores a
 * `pending` row and queues `koe-media`/"download". `processMedia` fetches the bytes through the channel's
 * adapter (WhatsApp's URL lives minutes and needs the token; graph.ts only downloads from Meta hosts),
 * checks the channel's sha256, keeps the file in `ctx.storage` and marks the row `ready`. Problems that
 * will not change on a retry (too large, not a Meta host, gone, no handle) mark it `failed` and do not
 * throw; anything else throws so the queue retries with backoff, until the last attempt marks it failed.
 *
 * Out. `POST /media` takes a file for one kind and makes it fit WhatsApp, the strictest channel:
 *
 *   voice     WhatsApp only shows a voice note when the file is OGG/Opus mono. A browser records WebM/Opus
 *             (Chrome, Firefox) or MP4/AAC (Safari), so the sidecar converts it. Without a sidecar an OGG/Opus
 *             mono file passes as is and anything else is kept as a plain `audio`, and the answer says why.
 *   sticker   WebP 512×512, up to 100 KB static or 500 KB animated. One that already fits is kept; a PNG,
 *             JPEG, GIF or MP4 goes through the sidecar; without a sidecar it is refused with 422.
 *   others    checked by their bytes (not by the type the browser claims) and by WhatsApp's size limits.
 *
 * The sidecar (media-sidecar/, Go + ffmpeg) is optional: `KOE_MEDIA_URL` and `KOE_MEDIA_TOKEN`. It also
 * gives inbound voice notes a browser-playable copy (OGG/Opus does not play in every browser), their
 * duration and a waveform. It never sees credentials and never fetches anything: bytes in, bytes out.
 * A voice note keeps WhatsApp's OGG/Opus file as its main file and an MP4/AAC copy (`playable_key`):
 * Instagram and Messenger take no OGG, so channelFileOf() sends them that copy. Without a sidecar there is
 * no copy, and a voice note cannot go to Instagram or Messenger as audio they accept.
 *
 * Also here: the stickers the team keeps to send again, and the web chat visitor's upload (images and
 * PDFs only), which enters through applyMessage() like any inbound message, with its file already stored.
 */

import { createHash } from "node:crypto";

import { AppError, asSystem, PermanentError, type QueueJob } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, desc, eq } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { adapterOf } from "./channels";
import { GraphError, MAX_DOWNLOAD_BYTES } from "./channels/graph";
import { webchatMessage } from "./channels/webchat";
import { authOf, channelById } from "./koe.channels";
import { dbOf, isString, newId, type Db } from "./koe.common";
import { applyMessage } from "./koe.inbound";
import { requireMember, USE } from "./koe.policy";
import { channelOf, publish } from "./koe.realtime";
import { koeChannels, koeConversations, koeMedia, koeMessages, koeStickers, type Channel, type Media, type MediaKind } from "./koe.schema";
import { Output, ParamId, type OperationsModule } from "./operations";

const KB = 1024;
const MB = 1024 * KB;

// ════════════════════════════════════════════════════════════════════════════
// The sidecar client
// ════════════════════════════════════════════════════════════════════════════

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let sidecarFetcher: Fetch = (...args) => fetch(...args);

/** Tests replace the network (like setGraphFetch). */
export function setSidecarFetch(next: Fetch | null): void {
  sidecarFetcher = next ?? ((...args) => fetch(...args));
}

export interface SidecarConfig {
  url: string;
  token: string;
  /** The sidecar also answers POST /transcribe (this repository's sidecar does not). */
  transcribe?: boolean;
}

let configOverride: SidecarConfig | null | undefined;

/** Tests set the sidecar without touching the environment; `undefined` goes back to the environment. */
export function setSidecarConfig(next: SidecarConfig | null | undefined): void {
  configOverride = next;
}

/** `KOE_MEDIA_URL` (+ `KOE_MEDIA_TOKEN`, `KOE_MEDIA_TRANSCRIBE=true`), or null: koe works without it. */
export function sidecarConfig(): SidecarConfig | null {
  if (configOverride !== undefined) return configOverride;
  const url = process.env.KOE_MEDIA_URL?.trim();
  if (!url) return null;
  return { url: url.replace(/\/+$/, ""), token: process.env.KOE_MEDIA_TOKEN ?? "", transcribe: process.env.KOE_MEDIA_TRANSCRIBE === "true" };
}

export class SidecarError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The file itself cannot be converted (422): retrying will not help. */
    readonly unprocessable: boolean
  ) {
    super(message);
    this.name = "SidecarError";
  }
}

export interface Converted {
  bytes: Buffer;
  mime: string;
  durationMs: number | null;
  waveform: number[] | null;
  animated: boolean;
}

/** `X-Waveform`: a JSON array of 0..1; anything else is ignored. */
export function parseWaveform(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v) || !v.length || v.length > 512) return null;
    const out = v.map((x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000 : NaN));
    return out.some(Number.isNaN) ? null : out;
  } catch {
    return null;
  }
}

async function callSidecar(path: string, bytes: Buffer, mime: string, timeoutMs = 120_000): Promise<Converted> {
  const cfg = sidecarConfig();
  if (!cfg) throw new SidecarError("No media converter is configured", 0, false);
  let res: Response;
  try {
    res = await sidecarFetcher(`${cfg.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": mime || "application/octet-stream" },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SidecarError(`The media converter is unreachable (${err instanceof Error ? err.name : "error"})`, 0, false);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    let message = text;
    try {
      message = String((JSON.parse(text) as { error?: string }).error ?? text);
    } catch {
      /* plain text */
    }
    throw new SidecarError(message || `The media converter answered ${res.status}`, res.status, res.status === 422 || res.status === 415 || res.status === 413);
  }
  const out = Buffer.from(await res.arrayBuffer());
  const duration = Number(res.headers.get("x-duration-ms"));
  return {
    bytes: out,
    mime: baseMime(res.headers.get("content-type") ?? "application/octet-stream"),
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    waveform: parseWaveform(res.headers.get("x-waveform")),
    animated: res.headers.get("x-animated") === "true",
  };
}

/** Any audio → OGG/Opus mono 48 kHz (a WhatsApp voice note), with its duration and waveform. */
export const toVoiceNote = (bytes: Buffer, mime: string) => callSidecar("/voice", bytes, mime);
/** OGG/Opus → MP4/AAC, which every browser plays, with its duration and waveform. */
export const toPlayable = (bytes: Buffer, mime: string) => callSidecar("/playable", bytes, mime);
/** PNG, JPEG, GIF, WebP or MP4 → WebP 512×512 within WhatsApp's sticker limits (422 when impossible). */
export const toSticker = (bytes: Buffer, mime: string) => callSidecar("/sticker", bytes, mime);

/** Text of a voice note, only when the sidecar says it can (`transcribe`). Never throws. */
async function transcribe(ctx: KonContext, bytes: Buffer, mime: string): Promise<string | null> {
  const cfg = sidecarConfig();
  if (!cfg?.transcribe) return null;
  try {
    const res = await sidecarFetcher(`${cfg.url}/transcribe`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": mime },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { text?: unknown };
    return typeof body.text === "string" && body.text.trim() ? body.text.trim().slice(0, 10_000) : null;
  } catch (err) {
    ctx.logger.warn("koe: transcription failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Bytes: what a file really is
// ════════════════════════════════════════════════════════════════════════════

const ascii = (b: Buffer, at: number, n: number) => (b.length >= at + n ? b.toString("latin1", at, at + n) : "");

/** `audio/ogg; codecs=opus` → `audio/ogg`. */
export function baseMime(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The type a file's first bytes say it is, or null. MP4 and WebM are containers: `video/*` here, and the
 * caller decides whether it holds audio.
 */
export function sniffMime(b: Buffer): string | null {
  if (b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (ascii(b, 0, 4) === "GIF8") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  if (ascii(b, 0, 4) === "OggS") return "audio/ogg";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (brand.startsWith("3gp")) return "video/3gpp";
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
    return "video/mp4";
  }
  if (ascii(b, 0, 5) === "#!AMR") return "audio/amr";
  if (b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return "audio/aac"; // ADTS
  if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(b, 0, 4) === "PK\x03\x04") return "application/zip";
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "application/x-ole";
  return null;
}

export interface WebpInfo {
  width: number;
  height: number;
  animated: boolean;
}

/** Width, height and animation of a WebP, from its first chunk; null if it is not one. */
export function webpInfo(b: Buffer): WebpInfo | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") return { animated: (b[20]! & 0x02) !== 0, width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { animated: false, width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { animated: false, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

export const STICKER_MAX = { static: 100 * KB, animated: 500 * KB };

/** WhatsApp's sticker rule: WebP, exactly 512×512, ≤100 KB static or ≤500 KB animated. */
export function stickerFits(b: Buffer): WebpInfo | null {
  const info = webpInfo(b);
  if (!info || info.width !== 512 || info.height !== 512) return null;
  return b.length <= (info.animated ? STICKER_MAX.animated : STICKER_MAX.static) ? info : null;
}

/** Channels and duration of an OGG/Opus file (from OpusHead and the last page's granule position). */
export function oggOpusInfo(b: Buffer): { channels: number; durationMs: number | null } | null {
  if (ascii(b, 0, 4) !== "OggS") return null;
  const head = b.indexOf("OpusHead");
  if (head < 0 || head > 1024 || b.length < head + 12) return null;
  const channels = b[head + 9]!;
  const preSkip = b.readUInt16LE(head + 10);
  const last = b.lastIndexOf("OggS");
  let durationMs: number | null = null;
  if (last >= 0 && b.length >= last + 14) {
    const granule = Number(b.readBigInt64LE(last + 6));
    if (granule > preSkip) durationMs = Math.round((granule - preSkip) / 48);
  }
  return { channels, durationMs };
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "video/webm": "webm",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

export function extOf(mime: string): string {
  return EXT[baseMime(mime)] ?? "bin";
}

/** The storage key carries nothing from the client: `koe/media/<conversation or library>/<id>.<ext>`. */
export function storageKeyOf(conversationId: string | null, mediaId: string, mime: string, suffix = ""): string {
  return `koe/media/${conversationId ?? "library"}/${mediaId}${suffix}.${extOf(mime)}`;
}

/** A client's file name, only for display: no path, no control characters, at most 200 characters. */
export function safeFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const clean = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return clean || null;
}

const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Meta gives sha256 as hex (GET /{media-id}) or base64 (webhooks): either matches. */
export function sha256Matches(bytes: Buffer, given: string): boolean {
  const digest = createHash("sha256").update(bytes).digest();
  const g = given.trim();
  return g.toLowerCase() === digest.toString("hex") || g === digest.toString("base64") || g.replace(/=+$/, "") === digest.toString("base64url");
}

// ════════════════════════════════════════════════════════════════════════════
// Download (the "download" job)
// ════════════════════════════════════════════════════════════════════════════

async function one<T>(q: Promise<T[]>): Promise<T | undefined> {
  return (await q)[0];
}

function mediaChanged(ctx: KonContext, m: Pick<Media, "id" | "conversationId" | "status">, messageId?: string | null): void {
  if (!m.conversationId) return;
  publish(ctx, channelOf.conversation(m.conversationId), { type: "media", conversationId: m.conversationId, mediaId: m.id, messageId: messageId ?? null, status: m.status });
}

async function markFailed(ctx: KonContext, db: Db, media: Media, error: string, messageId?: string | null): Promise<void> {
  await db.update(koeMedia).set({ status: "failed", error: error.slice(0, 500) }).where(and(eq(koeMedia.id, media.id), eq(koeMedia.status, "pending")));
  ctx.logger.warn("koe: media failed", { mediaId: media.id, error: error.slice(0, 200) });
  mediaChanged(ctx, { ...media, status: "failed" }, messageId);
}

/**
 * Playable copy, duration, waveform and (optionally) the transcript of a voice note. Never fails the media:
 * the OGG file is what matters, the rest is comfort for the browser.
 */
async function enrichVoice(ctx: KonContext, media: Pick<Media, "id" | "conversationId">, bytes: Buffer, mime: string): Promise<Partial<Media>> {
  const patch: Partial<Media> = {};
  const ogg = oggOpusInfo(bytes);
  if (ogg?.durationMs) patch.durationMs = ogg.durationMs;
  if (!sidecarConfig()) return patch;
  try {
    const playable = await toPlayable(bytes, mime);
    const key = storageKeyOf(media.conversationId, media.id, playable.mime, ".playable");
    await ctx.storage.put(key, playable.bytes, playable.mime);
    patch.playableKey = key;
    if (playable.durationMs) patch.durationMs = playable.durationMs;
    if (playable.waveform) patch.waveform = playable.waveform;
  } catch (err) {
    ctx.logger.warn("koe: no playable copy of a voice note", { mediaId: media.id, error: err instanceof Error ? err.message : String(err) });
  }
  const text = await transcribe(ctx, bytes, mime);
  if (text) patch.transcript = text;
  return patch;
}

/** Where to fetch a file: WhatsApp's media id, or a URL the job or the message carries (Messenger, Instagram). */
function refOf(media: Media, job: Record<string, unknown>, message: { payload: Record<string, unknown> } | undefined): string | null {
  if (media.metaMediaId) return media.metaMediaId;
  if (isString(job.ref)) return job.ref;
  const p = message?.payload ?? {};
  if (isString(p.mediaUrl)) return p.mediaUrl;
  if (isString(p.mediaRef)) return p.mediaRef;
  return null;
}

export async function processMedia(ctx: KonContext, job: QueueJob<{ mediaId?: string; messageId?: string; ref?: string }>): Promise<void> {
  const id = job.payload?.mediaId;
  if (!id) throw new PermanentError("job without mediaId");
  const db = dbOf(ctx);
  await asSystem(async () => {
    const media = await one<Media>(db.select().from(koeMedia).where(eq(koeMedia.id, id)).limit(1));
    if (!media || media.status !== "pending") return; // gone, already stored, or already given up on
    const messageId = job.payload?.messageId ?? null;
    const message = messageId
      ? await one<{ channelId: string; payload: Record<string, unknown> }>(
          db.select({ channelId: koeMessages.channelId, payload: koeMessages.payload }).from(koeMessages).where(eq(koeMessages.id, messageId)).limit(1)
        )
      : undefined;
    const channelId = message?.channelId ?? media.metaMediaChannelId;
    const channel: Channel | undefined = channelId ? await channelById(db, channelId) : undefined;
    if (!channel) return markFailed(ctx, db, media, "The channel of this media no longer exists", messageId);
    const adapter = adapterOf(channel.kind);
    const ref = refOf(media, (job.payload ?? {}) as Record<string, unknown>, message);
    if (!ref) return markFailed(ctx, db, media, "The channel gave no handle to download this media", messageId);
    if (!adapter.fetchMedia) return markFailed(ctx, db, media, `${channel.kind} cannot download media`, messageId);

    const lastAttempt = job.attempt >= job.maxAttempts;
    let fetched: { bytes: Buffer; mime: string; sha256?: string };
    try {
      const auth = await authOf(ctx, channel, "download-media");
      fetched = await adapter.fetchMedia(auth, { ref, kind: media.kind, mime: media.mime, sha256: media.sha256 ?? undefined });
    } catch (err) {
      if (err instanceof GraphError) {
        // Not a Meta host, too large, gone (404), refused credentials: a retry gets the same answer.
        if (!err.retryable || err.authBroken || lastAttempt) return markFailed(ctx, db, media, `${err.message} (${err.code})`, messageId);
        throw err;
      }
      if (lastAttempt) return markFailed(ctx, db, media, err instanceof Error ? err.message : String(err), messageId);
      throw err;
    }

    const bytes = fetched.bytes;
    if (bytes.length > MAX_DOWNLOAD_BYTES) return markFailed(ctx, db, media, "Media too large", messageId);
    if (!bytes.length) return markFailed(ctx, db, media, "The channel sent an empty file", messageId);
    for (const given of [fetched.sha256, media.sha256]) {
      if (given && !sha256Matches(bytes, given)) {
        // A torn download: worth another try, but not forever.
        if (lastAttempt) return markFailed(ctx, db, media, "The file does not match the channel's checksum", messageId);
        throw new Error("koe: media checksum mismatch, retrying");
      }
    }

    const mime = baseMime(fetched.mime || media.mime) || "application/octet-stream";
    const key = storageKeyOf(media.conversationId, media.id, mime);
    await ctx.storage.put(key, bytes, mime);
    const patch: Partial<Media> = { storageKey: key, mime, sizeBytes: bytes.length, sha256: sha256Hex(bytes), status: "ready", error: null };
    if (media.kind === "sticker") patch.animated = webpInfo(bytes)?.animated ?? media.animated;
    if (media.kind === "voice") Object.assign(patch, await enrichVoice(ctx, media, bytes, mime));
    await db.update(koeMedia).set(patch).where(and(eq(koeMedia.id, media.id), eq(koeMedia.status, "pending")));
    mediaChanged(ctx, { ...media, status: "ready" }, messageId);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Uploads
// ════════════════════════════════════════════════════════════════════════════

const WHATSAPP_MAX = adapterOf("whatsapp").capabilities.maxBytes;
const LIMIT = {
  image: WHATSAPP_MAX.image ?? 5 * MB,
  audio: WHATSAPP_MAX.audio ?? 16 * MB,
  voice: WHATSAPP_MAX.voice ?? 16 * MB,
  video: WHATSAPP_MAX.video ?? 16 * MB,
  document: WHATSAPP_MAX.document ?? 100 * MB,
};

const DOCUMENT_MIMES: Record<string, string | null> = {
  // declared type → what its bytes must sniff as (null: plain text, nothing to sniff)
  "application/pdf": "application/pdf",
  "text/plain": null,
  "application/msword": "application/x-ole",
  "application/vnd.ms-excel": "application/x-ole",
  "application/vnd.ms-powerpoint": "application/x-ole",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "application/zip",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "application/zip",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "application/zip",
};

/** Audio containers koe can hand to the sidecar (sniffed type → what it is as audio). */
const AUDIO_SNIFFED: Record<string, string> = {
  "audio/ogg": "audio/ogg",
  "audio/mpeg": "audio/mpeg",
  "audio/aac": "audio/aac",
  "audio/amr": "audio/amr",
  "audio/mp4": "audio/mp4",
  "audio/wav": "audio/wav",
  "video/mp4": "audio/mp4",
  "video/webm": "audio/webm",
};
/** What WhatsApp takes as a plain audio file. */
const WHATSAPP_AUDIO = new Set(["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"]);

export interface Prepared {
  kind: MediaKind;
  bytes: Buffer;
  mime: string;
  durationMs?: number | null;
  waveform?: number[] | null;
  animated?: boolean;
  /** A browser-playable copy to keep next to it (voice notes). */
  playable?: { bytes: Buffer; mime: string } | null;
  /** Why the result is not quite what was asked (kept as audio, not a voice note). */
  notice?: string;
}

const sizeText = (max: number) => (max >= MB ? `${Math.round(max / MB)} MB` : `${Math.round(max / KB)} KB`);
const tooLarge = (kind: string, max: number) => AppError.validation(`A ${kind} can be up to ${sizeText(max)}`, { koe: "TOO_LARGE", maxBytes: max });

/** A sidecar failure as an answer: the file cannot be converted (422), or the converter is down (503). */
function sidecarProblem(err: unknown): AppError {
  if (err instanceof SidecarError && err.unprocessable) return AppError.validation(`This file cannot be converted: ${err.message}`, { koe: "UNCONVERTIBLE" });
  return new AppError("INTERNAL", "The media converter is not available right now. Try again in a minute.", { status: 503, expose: true, details: { koe: "CONVERTER_DOWN" } });
}

/**
 * Checks a file for a kind and makes it fit WhatsApp. Throws 422 with the reason when it cannot.
 * Exported for tests; the operation below is the way in.
 */
export async function prepareUpload(kind: MediaKind, bytes: Buffer, declared: string): Promise<Prepared> {
  if (!bytes.length) throw AppError.validation("The file is empty");
  const sniffed = sniffMime(bytes);
  const claimed = baseMime(declared);
  const hasSidecar = !!sidecarConfig();

  switch (kind) {
    case "image": {
      if (sniffed !== "image/jpeg" && sniffed !== "image/png") throw AppError.validation("An image must be JPEG or PNG", { koe: "UNSUPPORTED_TYPE" });
      if (bytes.length > LIMIT.image) throw tooLarge("image", LIMIT.image);
      return { kind, bytes, mime: sniffed };
    }
    case "video": {
      if (sniffed !== "video/mp4" && sniffed !== "video/3gpp") throw AppError.validation("A video must be MP4 (H.264/AAC) or 3GPP", { koe: "UNSUPPORTED_TYPE" });
      if (bytes.length > LIMIT.video) throw tooLarge("video", LIMIT.video);
      return { kind, bytes, mime: sniffed };
    }
    case "document": {
      if (!(claimed in DOCUMENT_MIMES)) throw AppError.validation("Documents can be PDF, plain text, Word, Excel or PowerPoint", { koe: "UNSUPPORTED_TYPE" });
      const expected = DOCUMENT_MIMES[claimed];
      const textLike = expected === null && sniffed === null && !bytes.subarray(0, 8192).includes(0);
      if (expected !== null ? sniffed !== expected : !textLike) throw AppError.validation("The file's content does not match its type", { koe: "UNSUPPORTED_TYPE" });
      if (bytes.length > LIMIT.document) throw tooLarge("document", LIMIT.document);
      return { kind, bytes, mime: claimed };
    }
    case "audio": {
      const mime = sniffed ? AUDIO_SNIFFED[sniffed] : undefined;
      if (!mime || !WHATSAPP_AUDIO.has(mime)) throw AppError.validation("Audio must be AAC, AMR, MP3, M4A or OGG/Opus (WhatsApp takes no other)", { koe: "UNSUPPORTED_TYPE" });
      const ogg = mime === "audio/ogg" ? oggOpusInfo(bytes) : null;
      if (mime === "audio/ogg" && !ogg) throw AppError.validation("OGG audio must use the Opus codec", { koe: "UNSUPPORTED_TYPE" });
      if (bytes.length > LIMIT.audio) throw tooLarge("audio", LIMIT.audio);
      return { kind, bytes, mime, durationMs: ogg?.durationMs ?? null };
    }
    case "voice": {
      const mime = sniffed ? AUDIO_SNIFFED[sniffed] : undefined;
      if (!mime) throw AppError.validation("A voice note must be an audio recording (OGG, WebM, MP4, MP3, AAC, AMR or WAV)", { koe: "UNSUPPORTED_TYPE" });
      if (bytes.length > LIMIT.voice) throw tooLarge("voice note", LIMIT.voice);
      const ogg = mime === "audio/ogg" ? oggOpusInfo(bytes) : null;
      if (hasSidecar) {
        let voice: Converted;
        try {
          voice = await toVoiceNote(bytes, mime);
        } catch (err) {
          throw sidecarProblem(err);
        }
        if (voice.bytes.length > LIMIT.voice) throw tooLarge("voice note", LIMIT.voice);
        // OGG/Opus does not play in every browser: keep an MP4 copy for the inbox. Not having one is not fatal.
        let playable: Prepared["playable"] = null;
        try {
          const p = await toPlayable(voice.bytes, "audio/ogg");
          playable = { bytes: p.bytes, mime: p.mime };
        } catch {
          playable = null;
        }
        return { kind: "voice", bytes: voice.bytes, mime: "audio/ogg", durationMs: voice.durationMs ?? oggOpusInfo(voice.bytes)?.durationMs ?? null, waveform: voice.waveform, playable };
      }
      if (ogg && ogg.channels === 1) return { kind: "voice", bytes, mime: "audio/ogg", durationMs: ogg.durationMs };
      const why = ogg
        ? "it is OGG/Opus but not mono, and WhatsApp only shows mono files as voice notes"
        : `it is ${mime}, and WhatsApp only shows OGG/Opus mono files as voice notes`;
      const notice =
        `No media converter is configured (KOE_MEDIA_URL), so this recording was kept as a plain audio file: ${why}.` +
        (WHATSAPP_AUDIO.has(mime) ? "" : " WhatsApp does not accept this format at all; web chat plays it.");
      return { kind: "audio", bytes, mime, durationMs: ogg?.durationMs ?? null, notice };
    }
    case "sticker": {
      const fits = stickerFits(bytes);
      if (fits) return { kind, bytes, mime: "image/webp", animated: fits.animated };
      if (!sniffed || !["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4"].includes(sniffed)) {
        throw AppError.validation("A sticker is made from a PNG, JPEG, GIF, WebP or MP4", { koe: "UNSUPPORTED_TYPE" });
      }
      if (!hasSidecar) {
        throw AppError.validation(
          "A sticker must be WebP, exactly 512×512, up to 100 KB (static) or 500 KB (animated). No media converter is configured (KOE_MEDIA_URL) to convert this file.",
          { koe: "STICKER_INVALID" }
        );
      }
      let out: Converted;
      try {
        out = await toSticker(bytes, sniffed);
      } catch (err) {
        throw sidecarProblem(err);
      }
      const info = stickerFits(out.bytes);
      if (!info) throw AppError.validation("The converter could not make this file fit WhatsApp's sticker limits", { koe: "STICKER_INVALID" });
      return { kind, bytes: out.bytes, mime: "image/webp", animated: info.animated };
    }
  }
}

/** Stores prepared bytes and returns the ready row. */
async function storePrepared(ctx: KonContext, db: Db, p: Prepared, opts: { conversationId: string | null; filename: string | null }): Promise<Media> {
  const id = newId();
  const key = storageKeyOf(opts.conversationId, id, p.mime);
  await ctx.storage.put(key, p.bytes, p.mime);
  let playableKey: string | null = null;
  if (p.playable) {
    playableKey = storageKeyOf(opts.conversationId, id, p.playable.mime, ".playable");
    await ctx.storage.put(playableKey, p.playable.bytes, p.playable.mime);
  }
  const [row] = (await db
    .insert(koeMedia)
    .values({
      id,
      conversationId: opts.conversationId,
      kind: p.kind,
      mime: p.mime,
      sizeBytes: p.bytes.length,
      durationMs: p.durationMs ?? null,
      filename: opts.filename,
      sha256: sha256Hex(p.bytes),
      storageKey: key,
      playableKey,
      waveform: p.waveform ?? null,
      animated: p.animated ?? false,
      status: "ready",
    })
    .returning()) as Media[];
  return row!;
}

/**
 * Gives an inbound media row its file, already in hand (web chat uploads): stored, `ready`, announced.
 * The download job applyMessage() queued for it then finds it ready and does nothing.
 */
export async function attachStoredMedia(
  ctx: KonContext,
  db: Db,
  mediaId: string,
  file: { bytes: Buffer; mime: string; filename?: string | null },
  messageId?: string
): Promise<Media | null> {
  const media = await one<Media>(db.select().from(koeMedia).where(eq(koeMedia.id, mediaId)).limit(1));
  if (!media) return null;
  if (media.status === "ready") return media;
  const mime = baseMime(file.mime);
  const key = storageKeyOf(media.conversationId, media.id, mime);
  await ctx.storage.put(key, file.bytes, mime);
  const [row] = (await db
    .update(koeMedia)
    .set({ storageKey: key, mime, sizeBytes: file.bytes.length, sha256: sha256Hex(file.bytes), filename: file.filename ?? media.filename, status: "ready", error: null })
    .where(eq(koeMedia.id, media.id))
    .returning()) as Media[];
  mediaChanged(ctx, row!, messageId);
  return row!;
}

/** A media row as the API shows it: signed, short-lived URLs, never the storage key. */
export async function mediaView(ctx: KonContext, m: Media) {
  const url = m.storageKey ? await ctx.storage.getSignedDownloadUrl(m.storageKey, 3600).catch(() => null) : null;
  const playableUrl = m.playableKey ? await ctx.storage.getSignedDownloadUrl(m.playableKey, 3600).catch(() => null) : null;
  return {
    id: m.id,
    conversationId: m.conversationId,
    kind: m.kind,
    mime: m.mime,
    filename: m.filename,
    sizeBytes: m.sizeBytes,
    durationMs: m.durationMs,
    sha256: m.sha256,
    animated: m.animated,
    waveform: m.waveform,
    transcript: m.transcript,
    status: m.status,
    error: m.error,
    createdAt: m.createdAt,
    url,
    playableUrl,
  };
}

/** The type of a stored file from its key's extension (`.playable.m4a` → audio/mp4). */
function mimeOfKey(key: string): string {
  const ext = key.split(".").pop() ?? "";
  return Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
}

/**
 * Which stored file goes to a channel. WhatsApp wants the OGG/Opus voice note (the main file); Instagram
 * and Messenger take audio as AAC/M4A/WAV/MP4 and no OGG, so a voice note goes to them as its playable
 * MP4/AAC copy when there is one. Every other media sends its main file. Null when nothing is stored.
 */
export function channelFileOf(media: Pick<Media, "kind" | "mime" | "storageKey" | "playableKey">, channelKind: string): { key: string; mime: string } | null {
  if ((channelKind === "instagram" || channelKind === "messenger") && (media.kind === "voice" || baseMime(media.mime) === "audio/ogg") && media.playableKey) {
    return { key: media.playableKey, mime: mimeOfKey(media.playableKey) };
  }
  return media.storageKey ? { key: media.storageKey, mime: baseMime(media.mime) } : null;
}

/** The first file of a multipart field (`parseBody({ all: true })` gives an array when repeated). */
function fileOf(v: unknown): File | null {
  const f = Array.isArray(v) ? v[0] : v;
  return f && typeof f === "object" && typeof (f as File).arrayBuffer === "function" ? (f as File) : null;
}

const KINDS = ["image", "audio", "voice", "video", "document", "sticker"] as const;

/** Upper bound for the whole multipart body: the largest WhatsApp document plus the form's overhead. */
const UPLOAD_BODY_MAX = LIMIT.document + MB;
const WEBCHAT_MAX = 10 * MB;

const Upload = z.object({
  file: z.unknown().describe("The file, in the multipart field `file`"),
  kind: z.enum(KINDS).describe("What it will be sent as: voice notes and stickers are converted when a media converter is configured"),
  conversationId: z.string().min(1).max(100).optional().describe("The conversation it is for; without it, the file goes to the team's library"),
});

const VisitorUpload = z.object({
  visitorId: z.string().min(24).max(200).describe("A random key the visitor's browser keeps; only its hash is stored"),
  clientMessageId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  file: z.unknown().describe("The file, in the multipart field `file`: an image (JPEG, PNG, WebP, GIF) or a PDF, up to 10 MB"),
  text: z.string().trim().max(1000).optional().describe("A caption"),
  name: z.string().trim().max(200).optional(),
  email: z.string().email().max(300).optional(),
});

const VISITOR_TYPES: Record<string, "image" | "document"> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
  "application/pdf": "document",
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const mediaOperations: OperationsModule = (app, ctx) => {
  const db = (): Db => dbOf(ctx);

  app.post(
    "/media",
    {
      id: "upload-media",
      summary: "Upload a file to send",
      description:
        "Multipart: `file`, `kind` (image, audio, voice, video, document, sticker) and optionally `conversationId`. The file is checked by its bytes and against WhatsApp's limits (image JPEG/PNG ≤5 MB, audio/voice/video ≤16 MB, document ≤100 MB, sticker WebP 512×512 ≤100 KB static or ≤500 KB animated). A voice note is converted to OGG/Opus mono and a sticker to WebP when a media converter is configured; without one a recording that is not OGG/Opus mono is kept as `audio` and `notice` says why, and a sticker that does not already fit is refused (422). Returns the media row, ready to send with send-message `mediaId`.",
      access: "session",
      permission: USE,
      before: [bodyLimit({ maxSize: UPLOAD_BODY_MAX, onError: (c) => c.json({ error: "Payload Too Large", maxBytes: UPLOAD_BODY_MAX }, 413) })],
      input: { body: Upload, format: "multipart" },
      output: { schema: Output, status: 201 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: { exclude: "multipart file upload: MCP tool arguments are JSON, not file streams" },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const b = input.body as z.infer<typeof Upload>;
      const file = fileOf(b.file);
      if (!file) throw AppError.validation("No file provided (multipart field `file`)");
      if (file.size > LIMIT.document) throw tooLarge("file", LIMIT.document);
      let conversationId: string | null = null;
      if (b.conversationId) {
        // Row security: a conversation the caller may not see is not found.
        const conv = await one<{ id: string }>(db().select({ id: koeConversations.id }).from(koeConversations).where(eq(koeConversations.id, b.conversationId)).limit(1));
        if (!conv) throw AppError.notFound("Conversation not found");
        conversationId = conv.id;
      }
      const prepared = await prepareUpload(b.kind, Buffer.from(await file.arrayBuffer()), file.type);
      const row = await storePrepared(ctx, db(), prepared, { conversationId, filename: safeFilename(file.name) });
      return c.json({ data: await mediaView(ctx, row), ...(prepared.notice ? { notice: prepared.notice } : {}) }, 201);
    }
  );

  app.get(
    "/media/:id",
    {
      id: "get-media",
      summary: "A media file",
      description:
        "The media row with short-lived signed URLs (`url`, and `playableUrl` for voice notes), its duration, waveform and transcript. Only for media of a conversation you may see, or the team's library.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      // Row security: leads see all; others the library and the conversations they see.
      const m = await one<Media>(db().select().from(koeMedia).where(eq(koeMedia.id, input.params.id)).limit(1));
      if (!m) throw AppError.notFound("Media not found");
      return c.json({ data: await mediaView(ctx, m) });
    }
  );

  // ── Sticker library ─────────────────────────────────────────────────────

  app.get(
    "/stickers",
    {
      id: "list-stickers",
      summary: "The team's stickers",
      description: "Stickers kept to send again, newest first, with signed URLs. Send one with send-message `kind: sticker` and its `mediaId`.",
      access: "session",
      permission: USE,
      input: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const rows = (await db()
        .select({ sticker: koeStickers, media: koeMedia })
        .from(koeStickers)
        .innerJoin(koeMedia, eq(koeMedia.id, koeStickers.mediaId))
        .orderBy(desc(koeStickers.createdAt))
        .limit(input.query.limit)) as Array<{ sticker: typeof koeStickers.$inferSelect; media: Media }>;
      const data = [];
      for (const r of rows) data.push({ ...r.sticker, media: await mediaView(ctx, r.media) });
      return c.json({ data });
    }
  );

  app.post(
    "/stickers",
    {
      id: "save-sticker",
      summary: "Keep a sticker",
      description:
        "Adds a received or uploaded sticker (`mediaId`, ready, kind sticker) to the team's library, as its own copy so it outlives the conversation and every member can send it. The same file twice returns the one already kept (200).",
      access: "session",
      permission: USE,
      input: { body: z.object({ mediaId: z.string().min(1).max(100), name: z.string().trim().min(1).max(60).optional() }) },
      output: { schema: Output, status: 201, otherStatuses: [200] },
      // 404 when `mediaId` names no media.
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const src = await one<Media>(db().select().from(koeMedia).where(eq(koeMedia.id, input.body.mediaId)).limit(1));
      if (!src) throw AppError.notFound("Media not found");
      if (src.kind !== "sticker") throw AppError.validation("That media is not a sticker");
      if (src.status !== "ready" || !src.storageKey) throw AppError.validation("That sticker is not downloaded yet");
      const bytes = await ctx.storage.get(src.storageKey);
      if (!bytes) throw AppError.validation("That sticker's file is gone");
      const hash = sha256Hex(bytes);
      const kept = (await db()
        .select({ sticker: koeStickers, media: koeMedia })
        .from(koeStickers)
        .innerJoin(koeMedia, eq(koeMedia.id, koeStickers.mediaId))
        .where(eq(koeMedia.sha256, hash))
        .limit(1)) as Array<{ sticker: typeof koeStickers.$inferSelect; media: Media }>;
      if (kept[0]) return c.json({ data: { ...kept[0].sticker, created: false, media: await mediaView(ctx, kept[0].media) } });
      const copy = await storePrepared(ctx, db(), { kind: "sticker", bytes, mime: "image/webp", animated: webpInfo(bytes)?.animated ?? src.animated }, { conversationId: null, filename: src.filename });
      const [row] = (await db()
        .insert(koeStickers)
        .values({ id: newId(), mediaId: copy.id, name: input.body.name ?? null, createdBy: me.userId })
        .returning()) as Array<typeof koeStickers.$inferSelect>;
      return c.json({ data: { ...row!, created: true, media: await mediaView(ctx, copy) } }, 201);
    }
  );

  app.delete(
    "/stickers/:id",
    {
      id: "delete-sticker",
      summary: "Remove a sticker from the library",
      description: "Whoever kept it, or a supervisor or admin. Messages that already used it keep showing it.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      const me = await requireMember(db(), h.user);
      const s = await one<typeof koeStickers.$inferSelect>(db().select().from(koeStickers).where(eq(koeStickers.id, input.params.id)).limit(1));
      if (!s) throw AppError.notFound("Sticker not found");
      if (!me.lead && s.createdBy !== me.userId) throw AppError.forbidden("Only whoever kept it, or a supervisor, can remove this sticker");
      await db().delete(koeStickers).where(eq(koeStickers.id, s.id));
      return c.json({ data: { removed: s.id } });
    }
  );

  // ── Web chat visitor upload (public) ────────────────────────────────────

  app.post(
    "/public/webchat/:key/media",
    {
      id: "webchat-upload",
      summary: "A visitor sends a file",
      description:
        "Multipart: `visitorId`, `clientMessageId`, `file` (JPEG, PNG, WebP, GIF or PDF, up to 10 MB, checked by its bytes) and an optional `text` caption. It arrives in the inbox like any message, with the file already stored. `clientMessageId` makes a retried request the same message.",
      access: "public",
      before: [bodyLimit({ maxSize: WEBCHAT_MAX + 256 * KB, onError: (c) => c.json({ error: "Payload Too Large", maxBytes: WEBCHAT_MAX }, 413) })],
      input: { params: z.object({ key: z.string().min(3).max(100) }), body: VisitorUpload, format: "multipart" },
      output: { schema: Output, status: 201 },
      mcp: { exclude: "for the embedded widget; multipart file upload" },
    },
    async (c, input) => {
      const b = input.body as z.infer<typeof VisitorUpload>;
      const file = fileOf(b.file);
      if (!file) throw AppError.validation("No file provided (multipart field `file`)");
      if (file.size > WEBCHAT_MAX) throw tooLarge("file", WEBCHAT_MAX);
      const bytes = Buffer.from(await file.arrayBuffer());
      const mime = sniffMime(bytes);
      const kind = mime ? VISITOR_TYPES[mime] : undefined;
      if (!kind || !mime) throw AppError.validation("You can send images (JPEG, PNG, WebP, GIF) and PDF files", { koe: "UNSUPPORTED_TYPE" });

      const origin = c.req.header("origin") ?? undefined;
      const [ch] = (await asSystem(() => db().select().from(koeChannels).where(and(eq(koeChannels.kind, "webchat"), eq(koeChannels.externalId, input.params.key))).limit(1))) as Channel[];
      if (!ch || ch.status !== "active") throw AppError.notFound("Chat not found");
      const allowed = ch.settings?.allowedOrigins ?? [];
      if (allowed.length && (!origin || !allowed.some((o) => new URL(o).origin === origin))) throw AppError.forbidden("This chat is not available on this site");

      // The same hash koe.ops.setup.ts gives the visitor: one identity across messages and files.
      const hash = sha256(`koe-visitor:${b.visitorId}`);
      const filename = safeFilename(file.name) ?? `file.${extOf(mime)}`;
      const event = {
        ...webchatMessage(ch.externalId, hash, { text: b.text || undefined, kind, name: b.name, email: b.email, clientMessageId: b.clientMessageId }),
        media: { ref: "upload", kind, mime, filename },
      };
      const out = await asSystem(async () => {
        const applied = await applyMessage(ctx, db(), event);
        if (!applied) return null;
        const media = applied.message.mediaId ? await attachStoredMedia(ctx, db(), applied.message.mediaId, { bytes, mime, filename }, applied.message.id) : null;
        return { applied, media };
      });
      if (!out) throw AppError.notFound("Chat not found");
      const url = out.media?.storageKey ? await ctx.storage.getSignedDownloadUrl(out.media.storageKey, 3600).catch(() => null) : null;
      return c.json(
        {
          data: {
            id: out.applied.message.id,
            at: out.applied.message.createdAt,
            media: out.media ? { url, mime: out.media.mime, filename: out.media.filename } : null,
            channel: channelOf.visitor(hash),
          },
        },
        201
      );
    }
  );
};
