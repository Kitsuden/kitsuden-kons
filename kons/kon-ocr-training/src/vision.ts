/**
 * kon-ocr-training — Vision LLM call, governed by KITSUDEN.
 *
 * Why the kon makes the call (and not the engine) in the KITSUDEN topology:
 * the OCR pipeline enqueues in RabbitMQ, so a secret that traveled through there
 * would be persisted in the queue. The provider API key lives in KITSUDEN Secrets and
 * NEVER leaves KITSUDEN: the kon reads it from process.env (encrypted hot-inject),
 * downloads the document from the gateway and calls the provider directly.
 *
 * No rasterization in Node: Anthropic accepts native PDF (`document` block);
 * images pass straight through. The standalone engine (Python) covers the rest of
 * the providers with its own rasterization.
 *
 * Secret name in KITSUDEN: VEKOCR_VISION_LLM_API_KEY
 * (HARUOCR_VISION_LLM_API_KEY is accepted as a fallback during the migration).
 */

export interface VisionConfig {
  enabled: boolean;
  provider: string;
  model: string | null;
  /**
   * OBSOLETE: ignored. The provider URL comes from the server
   * configuration (`visionBaseUrl`). The field is kept so as not to break callers.
   */
  baseUrl?: string | null;
  maxPages: number;
}

export interface VisionResult {
  ok: boolean;
  text?: string;
  confidence?: number;
  error?: string;
  provider?: string;
  model?: string;
}

const PROMPT =
  "You are a high-fidelity OCR engine. Transcribe EXACTLY the text of the " +
  "document, respecting reading order and structure. Preserve tables as " +
  "Markdown. Do not invent or correct: transcribe what you see. If something is " +
  "illegible, write [illegible].\n\n" +
  "Respond ONLY with valid JSON, with no additional text:\n" +
  '{"text":"<markdown transcription>","confidence":<0.0-1.0 legibility>}';

/** The key lives in KITSUDEN Secrets; it is read per request (hot-inject). */
export function visionApiKey(): string {
  return (
    process.env.VEKOCR_VISION_LLM_API_KEY ??
    process.env.HARUOCR_VISION_LLM_API_KEY ??
    ""
  ).trim();
}

/**
 * Which host the provider key is sent to. ONLY from the server
 * configuration, never from the database or a request body.
 *
 * Before it came from `ocr_vision_config.base_url`, which was filled in with the
 * `base_url` of `PUT /vision-config`: whoever could save the config (and the
 * route only asked for a session, with open sign-up) pointed the URL at their server,
 * called `/vision-config/test` and received the LLM key in the
 * `x-api-key`/`Authorization` header. Secret leak and SSRF at once.
 *
 * An own gateway (OpenRouter, vLLM, Ollama) can still be used: it is
 * declared in `VEKOCR_VISION_LLM_BASE_URL`, which only whoever
 * administers the server can touch.
 */
export function visionBaseUrl(provider: string): string {
  const official = provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com";
  const ownValue = (process.env.VEKOCR_VISION_LLM_BASE_URL ?? "").trim();
  if (!ownValue) return official;
  try {
    const url = new URL(ownValue);
    if (url.protocol !== "https:" && url.protocol !== "http:") return official;
    if (url.username || url.password) return official;
    return ownValue.replace(/\/+$/, "");
  } catch {
    return official;
  }
}

export function defaultModel(provider: string): string {
  return provider === "openai" ? "gpt-4o" : "claude-sonnet-4-5";
}

function parseResponse(raw: string): { text: string; confidence: number } {
  let s = (raw ?? "").trim();
  if (s.startsWith("```")) {
    const parts = s.split("```");
    s = parts.length >= 2 ? parts[1] : s;
    if (s.startsWith("json")) s = s.slice(4);
    s = s.trim();
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(s.slice(start, end + 1));
      const conf = Number(obj.confidence);
      return {
        text: String(obj.text ?? "").trim(),
        confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.6,
      };
    } catch {
      /* falls back to raw */
    }
  }
  return { text: s, confidence: s ? 0.6 : 0 };
}

async function callAnthropic(
  cfg: VisionConfig,
  key: string,
  bytes: ArrayBuffer,
  mime: string,
  timeoutMs: number
): Promise<string> {
  const b64 = Buffer.from(bytes).toString("base64");
  const media =
    mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
      : {
          type: "image",
          source: { type: "base64", media_type: normalizeImageMime(mime), data: b64 },
        };

  const base = visionBaseUrl("anthropic");
  const resp = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model || defaultModel("anthropic"),
      max_tokens: 4096,
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, media] }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok)
    throw new Error(`anthropic HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data: any = await resp.json();
  return (data.content ?? [])
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("");
}

async function callOpenAI(
  cfg: VisionConfig,
  key: string,
  bytes: ArrayBuffer,
  mime: string,
  timeoutMs: number
): Promise<string> {
  if (mime === "application/pdf") {
    // OpenAI chat/completions expects images; a PDF would require rasterizing
    // (which we avoid in Node). For PDF use the anthropic provider or the engine.
    throw new Error(
      "PDF with provider=openai is not supported from the kon (use provider=anthropic or the standalone engine)"
    );
  }
  const b64 = Buffer.from(bytes).toString("base64");
  const base = visionBaseUrl("openai");
  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model || defaultModel("openai"),
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            {
              type: "image_url",
              image_url: { url: `data:${normalizeImageMime(mime)};base64,${b64}` },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`openai HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data: any = await resp.json();
  return data.choices?.[0]?.message?.content ?? "";
}

function normalizeImageMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return "image/png";
  if (m.includes("webp")) return "image/webp";
  if (m.includes("gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * Runs the transcription with the LLM. `bytes` is the raw document (PDF or
 * image) downloaded from the gateway. It never throws: it returns {ok:false, error}.
 */
export async function runVisionLLM(
  cfg: VisionConfig,
  bytes: ArrayBuffer,
  mime: string,
  timeoutMs = 120000
): Promise<VisionResult> {
  const key = visionApiKey();
  if (!key) {
    return { ok: false, error: "VEKOCR_VISION_LLM_API_KEY is missing from KITSUDEN Secrets" };
  }
  const model = cfg.model || defaultModel(cfg.provider);
  try {
    const raw =
      cfg.provider === "openai"
        ? await callOpenAI(cfg, key, bytes, mime, timeoutMs)
        : await callAnthropic(cfg, key, bytes, mime, timeoutMs);
    const { text, confidence } = parseResponse(raw);
    if (!text.trim())
      return {
        ok: false,
        error: "The LLM returned an empty transcription",
        provider: cfg.provider,
        model,
      };
    return { ok: true, text, confidence, provider: cfg.provider, model };
  } catch (e) {
    return { ok: false, error: String(e), provider: cfg.provider, model };
  }
}

export { parseResponse as _parseResponse, normalizeImageMime as _normalizeImageMime };
