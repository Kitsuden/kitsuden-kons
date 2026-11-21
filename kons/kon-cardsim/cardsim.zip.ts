/**
 * A small zip reader for card image archives
 * ============================================================================
 *
 * People keep their scans in a zip. Reading one needs the central directory and two compression
 * methods (stored and deflate); the browser already has deflate (`DecompressionStream`), so this is
 * ~120 lines instead of a dependency.
 *
 * What it refuses, on purpose:
 *   · zip64 and encrypted entries — a card archive never needs them, and a half-supported format
 *     is worse than a clear error;
 *   · entries bigger than `maxEntryBytes` (default 16 MB) and archives with more than
 *     `maxEntries` (default 30,000) — a zip bomb must not take the tab down;
 *   · names with `..` or absolute paths are listed but never used as paths (they are only keys).
 *
 * Runs in the browser and in Node ≥ 18 (both have `Blob`, `DecompressionStream`).
 */

export interface ZipEntry {
  /** Full name inside the archive, `/`-separated. */
  name: string;
  /** Uncompressed size, as the central directory declares it. */
  size: number;
  /** The entry's bytes. Checked against the declared size while inflating. */
  blob(type?: string): Promise<Blob>;
}

export interface ZipLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

async function bytes(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

/** Lists a zip's files (folders are skipped). */
export async function readZip(archive: Blob, limits: ZipLimits = {}): Promise<ZipEntry[]> {
  const maxEntries = limits.maxEntries ?? 30_000;
  const maxEntryBytes = limits.maxEntryBytes ?? 16 * 1024 * 1024;

  // The end-of-central-directory record is in the last 22 bytes + up to 64 KB of comment.
  const tailStart = Math.max(0, archive.size - 22 - 0xffff);
  const tail = await bytes(archive, tailStart, archive.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("Not a zip file");

  const count = tail.getUint16(eocd + 10, true);
  const dirSize = tail.getUint32(eocd + 12, true);
  const dirOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || dirOffset === 0xffffffff) {
    throw new ZipError("zip64 archives are not supported: re-zip without zip64");
  }
  if (count > maxEntries) throw new ZipError(`Too many files in the zip (max ${maxEntries})`);
  if (dirOffset + dirSize > archive.size) throw new ZipError("Damaged zip: directory out of range");

  const dir = await bytes(archive, dirOffset, dirOffset + dirSize);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > dir.byteLength || dir.getUint32(p, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError("Damaged zip: bad directory entry");
    }
    const flags = dir.getUint16(p + 8, true);
    const method = dir.getUint16(p + 10, true);
    const compressed = dir.getUint32(p + 20, true);
    const size = dir.getUint32(p + 24, true);
    const nameLength = dir.getUint16(p + 28, true);
    const extraLength = dir.getUint16(p + 30, true);
    const commentLength = dir.getUint16(p + 32, true);
    const localOffset = dir.getUint32(p + 42, true);
    const name = decoder.decode(
      new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength)
    );
    p += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue; // a folder
    if (flags & 0x1) continue; // encrypted: skipped, never guessed
    if (method !== 0 && method !== 8) continue; // unknown compression
    if (size > maxEntryBytes || compressed > maxEntryBytes) continue;

    entries.push({
      name,
      size,
      async blob(type = "") {
        const local = await bytes(archive, localOffset, localOffset + 30);
        if (local.getUint32(0, true) !== LOCAL_SIGNATURE) {
          throw new ZipError(`Damaged zip: bad local header for ${name}`);
        }
        const dataStart =
          localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
        const raw = archive.slice(dataStart, dataStart + compressed);
        if (method === 0) return new Blob([raw], { type });
        return inflate(raw, size, maxEntryBytes, type);
      },
    });
  }
  return entries;
}

/** Deflate → bytes, stopping as soon as the output passes what was declared (zip bombs). */
async function inflate(raw: Blob, declared: number, cap: number, type: string): Promise<Blob> {
  const stream = raw.stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const limit = Math.min(cap, declared);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ZipError("An entry inflates past its declared size");
    }
    chunks.push(value);
  }
  return new Blob(chunks as BlobPart[], { type });
}
