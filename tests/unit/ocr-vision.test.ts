/**
 * Reading the vision LLM's response
 * ============================================================================
 *
 * kon-ocr-training had no tests, and `parseResponse` is one of the functions that
 * needs them most: what it parses is NOT an API, it is free text from a model.
 * An LLM returns the requested JSON almost always, and the rest of the time it
 * wraps it in ```json, or puts a sentence in front, or makes up a confidence of
 * 1.5. Each of those variants is a production failure if not handled.
 *
 * The rule that governs all of this: NEVER throw. An OCR that blows up when reading the
 * response loses the document; one that returns the raw text with low confidence
 * lets a human review it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _normalizeImageMime,
  _parseResponse,
  defaultModel,
  runVisionLLM,
  visionApiKey,
} from "../../kons/kon-ocr-training/src/vision";

describe("parseResponse", () => {
  it("reads clean JSON", () => {
    expect(_parseResponse('{"text":"hola","confidence":0.9}')).toEqual({
      text: "hola",
      confidence: 0.9,
    });
  });

  it("unwraps the ```json block that the model adds on its own", () => {
    const r = _parseResponse('```json\n{"text":"hola","confidence":0.8}\n```');
    expect(r).toEqual({ text: "hola", confidence: 0.8 });
  });

  it("unwraps the ``` block without a label", () => {
    expect(_parseResponse('```\n{"text":"hola","confidence":0.8}\n```').text).toBe("hola");
  });

  it("finds the JSON even with chatter before and after", () => {
    const r = _parseResponse('Claro, aquí tienes: {"text":"hola","confidence":0.7} ¿algo más?');
    expect(r).toEqual({ text: "hola", confidence: 0.7 });
  });

  it("clamps the confidence to the range, does not propagate a made-up one", () => {
    expect(_parseResponse('{"text":"a","confidence":1.5}').confidence).toBe(1);
    expect(_parseResponse('{"text":"a","confidence":-3}').confidence).toBe(0);
  });

  it("with non-numeric confidence it falls back to the default value", () => {
    expect(_parseResponse('{"text":"a","confidence":"muy alta"}').confidence).toBe(0.6);
    expect(_parseResponse('{"text":"a"}').confidence).toBe(0.6);
  });

  it("if there is no JSON it returns the raw text, does NOT throw", () => {
    // Losing the transcribed text because the model skipped the format would be
    // throwing away the expensive work that is already done.
    const r = _parseResponse("No he podido leer la imagen.");
    expect(r.text).toBe("No he podido leer la imagen.");
    expect(r.confidence).toBe(0.6);
  });

  it("an empty response is worth zero, not 0.6", () => {
    expect(_parseResponse("")).toEqual({ text: "", confidence: 0 });
    expect(_parseResponse("   ")).toEqual({ text: "", confidence: 0 });
  });

  it("handles null and undefined without breaking", () => {
    expect(_parseResponse(null as never).confidence).toBe(0);
    expect(_parseResponse(undefined as never).confidence).toBe(0);
  });

  it("a malformed JSON does not blow up, it falls back to the raw text", () => {
    expect(() => _parseResponse('{"text":"a",,}')).not.toThrow();
  });
});

describe("normalizeImageMime", () => {
  it("recognizes the formats the LLM accepts", () => {
    expect(_normalizeImageMime("image/png")).toBe("image/png");
    expect(_normalizeImageMime("image/webp")).toBe("image/webp");
    expect(_normalizeImageMime("image/gif")).toBe("image/gif");
  });

  it("is case-insensitive and ignores suffixes", () => {
    expect(_normalizeImageMime("IMAGE/PNG")).toBe("image/png");
    expect(_normalizeImageMime("image/png; charset=binary")).toBe("image/png");
  });

  it("anything else goes as jpeg", () => {
    // Including an empty mime: sending something valid and letting the model decide is
    // better than sending a string the API rejects outright.
    expect(_normalizeImageMime("application/pdf")).toBe("image/jpeg");
    expect(_normalizeImageMime("")).toBe("image/jpeg");
    expect(_normalizeImageMime(null as never)).toBe("image/jpeg");
  });
});

describe("defaultModel", () => {
  it("each provider with its own", () => {
    expect(defaultModel("openai")).toBe("gpt-4o");
    expect(defaultModel("anthropic")).toBe("claude-sonnet-4-5");
  });

  it("the unknown falls back to anthropic", () => {
    expect(defaultModel("loquesea")).toBe("claude-sonnet-4-5");
  });
});

describe("visionApiKey", () => {
  const prior = { ...process.env };

  beforeEach(() => {
    delete process.env.VEKOCR_VISION_LLM_API_KEY;
    delete process.env.HARUOCR_VISION_LLM_API_KEY;
  });

  afterEach(() => {
    process.env = { ...prior };
  });

  it("reads the current variable", () => {
    process.env.VEKOCR_VISION_LLM_API_KEY = "  sk-abc  ";
    expect(visionApiKey()).toBe("sk-abc");
  });

  it("accepts the old name as a fallback", () => {
    process.env.HARUOCR_VISION_LLM_API_KEY = "sk-viejo";
    expect(visionApiKey()).toBe("sk-viejo");
  });

  it("the current name takes precedence over the old one", () => {
    process.env.VEKOCR_VISION_LLM_API_KEY = "sk-nuevo";
    process.env.HARUOCR_VISION_LLM_API_KEY = "sk-viejo";
    expect(visionApiKey()).toBe("sk-nuevo");
  });

  it("without a variable returns an empty string, not undefined", () => {
    expect(visionApiKey()).toBe("");
  });
});

describe("runVisionLLM", () => {
  const prior = { ...process.env };

  afterEach(() => {
    process.env = { ...prior };
  });

  it("without an API key returns the error instead of throwing", async () => {
    delete process.env.VEKOCR_VISION_LLM_API_KEY;
    delete process.env.HARUOCR_VISION_LLM_API_KEY;

    const r = await runVisionLLM(
      { provider: "anthropic" } as never,
      new ArrayBuffer(8),
      "image/png"
    );

    expect(r.ok).toBe(false);
    expect(r.error).toContain("VEKOCR_VISION_LLM_API_KEY");
  });
});
