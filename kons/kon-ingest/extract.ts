/**
 * kon-ingest — extract the text and chunk it (pure, no database or network except OCR)
 *
 * By type:
 *   text/plain, text/markdown, application/json, text/csv  → as is
 *   text/html                                             → without tags, scripts or styles
 *   application/pdf   → `unpdf` (OPTIONAL dependency: `pnpm add unpdf`), imported
 *                        on use. Without it, the document fails with a clear message.
 *   image/*           → an OCR SIDECAR (`OCR_SIDECAR_URL`): `POST` of the bytes,
 *                        response `{ "text": "…" }`. Never inside the API: OCR
 *                        engines are heavy and their parsers, attack surface.
 */

export class CannotExtract extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CannotExtract";
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function textFromHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*(\n\s*)+/g, "\n\n")
    .trim();
}

export async function extractText(mime: string, content: string): Promise<string> {
  const type = mime.toLowerCase().split(";")[0]!.trim();
  if (["text/plain", "text/markdown", "application/json", "text/csv"].includes(type)) return content;
  if (type === "text/html") return textFromHtml(content);
  if (type === "application/pdf") {
    let unpdf: { extractText(d: Uint8Array, o: { mergePages: true }): Promise<{ text: string }> };
    try {
      unpdf = (await import(/* optional */ "unpdf" as string)) as typeof unpdf;
    } catch {
      throw new CannotExtract("PDF needs the optional dependency 'unpdf' (pnpm add unpdf)");
    }
    const { text } = await unpdf.extractText(Buffer.from(content, "base64"), { mergePages: true });
    return text;
  }
  if (type.startsWith("image/")) {
    const url = process.env.OCR_SIDECAR_URL;
    if (!url) throw new CannotExtract("Images need an OCR sidecar (set OCR_SIDECAR_URL)");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": type },
      body: Buffer.from(content, "base64"),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`OCR sidecar answered ${res.status}`);
    const { text } = (await res.json()) as { text?: unknown };
    if (typeof text !== "string") throw new CannotExtract("OCR sidecar did not return { text }");
    return text;
  }
  throw new CannotExtract(`Unsupported type: ${type}`);
}

/**
 * Chunks by paragraphs up to `max` characters, with `overlap` characters from the end of
 * the previous chunk (so that a split idea appears whole in at least one). A
 * markdown heading (`#`) starts a new chunk. A paragraph longer than `max` is
 * cut by sentences and, if needed, bluntly.
 */
export function chunk(textValue: string, max = 1200, overlap = 150): string[] {
  const paragraphs = textValue
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length <= max ? [p] : split(p, max)));
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    const title = /^#{1,6}\s/.test(p);
    if (current && (title || current.length + p.length + 2 > max)) {
      chunks.push(current);
      const tail = overlap > 0 && !title ? current.slice(-overlap) : "";
      current = tail ? `${tail.slice(tail.indexOf(" ") + 1)}\n\n${p}` : p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function split(p: string, max: number): string[] {
  const sentences = p.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let a = "";
  for (const f of sentences) {
    if (f.length > max) {
      if (a) out.push(a);
      a = "";
      for (let i = 0; i < f.length; i += max) out.push(f.slice(i, i + max));
      continue;
    }
    if (a && a.length + f.length + 1 > max) {
      out.push(a);
      a = f;
    } else a = a ? `${a} ${f}` : f;
  }
  if (a) out.push(a);
  return out;
}
