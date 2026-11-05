/**
 * Blog content sanitization
 * ============================================================================
 *
 * ── WHY IT IS NEEDED ───────────────────────────────────────────────────────
 *
 * An entry's body travels as HTML (`content` as a string) or as
 * markdown inside the `richtext` blocks, and the site renders it with
 * `set:html` (`pages/blog/[slug].astro`, `RichtextBlock.astro`). `marked` does not
 * sanitize since version 5: a `<script>`, an `<img onerror>` or a
 * `[x](javascript:…)` saved in an entry ran in the browser of
 * every reader — and in that of the admin who opened it.
 *
 * Whoever writes is the team, but "the team" includes any editor and an
 * agent token: a stolen editor account must not be able to plant code
 * on the site or steal an admin's session.
 *
 * ── ALLOWLIST, NOT BLOCKLIST ───────────────────────────────────────────────
 *
 * The tags and attributes of a closed list are kept (those the published
 * content actually uses: measured over the 148 production entries
 * on 2026-10-15, all pass without a single change). The rest is removed:
 *
 *   · `script`, `style`, `iframe`, `object`, `svg`… → out WITH their content.
 *   · any other unknown tag → the tag goes, the text stays.
 *   · `on*`, `style`, `srcset`, `formaction`… → out (they are not on the list).
 *   · `href`/`src` → only `http(s):`, `mailto:`, `tel:` or relative
 *     (the same list as the shared renderer's `safeUrl`). Being an
 *     allowlist, `&#106;avascript:` or `java\tscript:` do not pass.
 *
 * It is applied when SAVING (what comes in through the API) and when SERVING (what the
 * loaders write directly to the database without passing through here).
 *
 * Dependency-free on purpose: there is no sanitizer installed in the
 * monorepo and `DOMParser` does not exist in Bun. A tag tokenizer is enough
 * because the result is rebuilt ENTIRELY from the allowlist: nothing
 * that comes in goes out without passing through `escapeAttribute`.
 */

import { findSpanishBlockKeys, readBlockData, spanishKeysError } from "@kitsuden/shared";

/** Tags that are kept. */
const TAGS = new Set([
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
]);

/** Tags that are removed together with EVERYTHING inside them. */
const WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "template",
  "noscript",
  "noembed",
  "noframes",
  "textarea",
  "title",
  "xmp",
  "plaintext",
  "svg",
  "math",
  "select",
  "option",
  "head",
]);

/** Attributes that are kept on any allowed tag. */
const ATTRIBUTES = new Set([
  "class",
  "id",
  "title",
  "lang",
  "dir",
  "role",
  "alt",
  "loading",
  "decoding",
  "width",
  "height",
  "colspan",
  "rowspan",
  "scope",
  "start",
  "reversed",
  "datetime",
  "open",
  "target",
  "rel",
]);

/** Attributes that carry a URL: only allowlisted schemes or relative URLs (`dangerousTarget`). */
const URL_ATTRIBUTES = new Set(["href", "src", "cite"]);

/** Text of a node: what the browser would read as markup, escaped. */
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]{0,31};|#[0-9]{1,7};|#x[0-9a-fA-F]{1,6};)/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const RE_ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function cleanAttributes(rawItems: string): string {
  let output = "";
  const seen = new Set<string>();
  for (const m of rawItems.matchAll(RE_ATTRIBUTE)) {
    const name = m[1]!.toLowerCase();
    if (seen.has(name)) continue;
    const value = m[2] ?? m[3] ?? m[4];

    let clean: string | null = null;
    if (URL_ATTRIBUTES.has(name)) {
      // Allowlist of schemes (http, https, mailto, tel) or relative; with
      // entities and whitespace decoded before checking (`&#106;avascript:`).
      const url = (value ?? "").trim();
      if (url && !dangerousTarget(url)) clean = url;
    } else if (
      ATTRIBUTES.has(name) ||
      /^aria-[a-z-]+$/.test(name) ||
      /^data-[a-z0-9-]+$/.test(name)
    ) {
      clean = value ?? "";
    }

    if (clean === null) continue;
    seen.add(name);
    output += value === undefined ? ` ${name}` : ` ${name}="${escapeAttribute(clean)}"`;
  }
  return output;
}

// ── Internal markers ────────────────────────────────────────────────────────
//
// Sanitizing sets aside already-clean pieces with a control marker (NUL) that is
// REMOVED from the input first, so nobody can forge it. The
// expressions that look for it are built from the constant
// instead of writing `\u0000` inside a /…/ literal: `no-control-regex` forbids it
// (rightly so in general: it is almost always a mistake) and here the control
// character is exactly what is being looked for. To remove it, `replaceAll` is enough.
const NULL_VALUE = String.fromCharCode(0);
const RE_SECTION = new RegExp(`${NULL_VALUE}(\\d+)${NULL_VALUE}`, "g");

/**
 * Removes the C0 control characters (U+0000–U+001F), the space and the
 * backslash: browsers ignore them inside a scheme (`java\tscript:`),
 * so the comparison is made without them. Equivalent to the regex class
 * "U+0000 to U+0020 plus the backslash" that used to be here.
 */
function withoutControlsOrBlanks(text: string): string {
  let output = "";
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x20 && ch !== "\\") output += ch;
  }
  return output;
}

/**
 * HTML (or markdown with HTML inside) → the same with only what is allowed.
 *
 * Idempotent: sanitizing twice gives the same as once. What is not
 * a tag (`a < b`, `<3`) is left as it is.
 */
export function sanitizeHtml(input: unknown): string {
  if (typeof input !== "string" || input === "") return typeof input === "string" ? input : "";

  let html = input
    // The null character is used below as a marker; in a text it renders nothing.
    .replaceAll(NULL_VALUE, "")
    // Comments, CDATA and declarations: nothing to show and an easy hiding place.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/gi, "")
    .replace(/<![^>]*>?/g, "")
    .replace(/<\?[^>]*>?/g, "");

  // Removed, along with whatever they contain. Without a closing tag, up to the end: an unclosed `<script>`
  // is just the same to the browser.
  for (const tag of WITH_CONTENT) {
    const re = new RegExp(`<${tag}\\b[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, "gi");
    html = html.replace(re, "");
    html = html.replace(new RegExp(`<\\/${tag}\\s*>`, "gi"), "");
  }

  // Markdown autolinks (`<https://…>`, `<a@b.c>`). They are NOT kept
  // raw: to the browser `<x@x/onfocus=…>` and `<https://x/onfocus=…>` ARE
  // tags (the `/` ends the name) with an event handler, and setting them aside
  // as they were let them out of the allowlist (XSS, earlier audit). They are
  // rewritten as an `<a>` built here, with the destination escaped: the same
  // link and nothing more. Those with another scheme (`<javascript:…>`) fall through below.
  const sections: string[] = [];
  const setAside = (chunk: string) => {
    sections.push(chunk);
    return `\u0000${sections.length - 1}\u0000`;
  };
  html = html.replace(
    /<((?:https?|mailto):[^\s<>"'`]+|[^\s<>@"'`/=]+@[^\s<>@"'`/=]+)>/gi,
    (_t, inside: string) => {
      const target = /^(?:https?|mailto):/i.test(inside) ? inside : `mailto:${inside}`;
      return setAside(`<a href="${escapeAttribute(target)}">${escapeText(inside)}</a>`);
    }
  );

  // Each tag, rebuilt from the allowlist.
  html = html.replace(
    /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (_all, closing: string, rawName: string, rest: string) => {
      const name = rawName.toLowerCase();
      if (!TAGS.has(name)) return "";
      if (closing) return setAside(`</${name}>`);
      const autocierre = /\/\s*$/.test(rest);
      return setAside(
        `<${name}${cleanAttributes(rest.replace(/\/\s*$/, ""))}${autocierre ? " /" : ""}>`
      );
    }
  );

  // A `<` that still opens something (a tag without `>`) is neutralized.
  html = html.replace(/<(?=[a-zA-Z/!?])/g, "&lt;");

  return html.replace(RE_SECTION, (_t, i: string) => sections[Number(i)] ?? "");
}

/**
 * Markdown: the HTML inside it, sanitized, and also the link
 * and image destinations with a scheme that is not on the allowlist, voided.
 *
 * `marked` does not sanitize destinations: `[x](javascript:alert(1))` comes out as `<a>`.
 */
export function sanitizeMarkdown(input: unknown): string {
  if (typeof input !== "string") return "";
  return (
    sanitizeHtml(input)
      // [text](destination …) and ![alt](destination …)
      .replace(/(\]\(\s*<?)([^)\s>]*)/g, (everything, pre: string, target: string) =>
        dangerousTarget(target) ? `${pre}#` : everything
      )
      // Reference definitions: [id]: destination
      .replace(/^(\s{0,3}\[[^\]]+\]:\s*<?)(\S*)/gm, (everything, pre: string, target: string) =>
        dangerousTarget(target) ? `${pre}#` : everything
      )
  );
}

/** Code → character; out of range (which would make `fromCodePoint` throw), a blank. */
function character(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

/** Does it carry a scheme that is not one of the allowed ones? (entities and blanks included) */
function dangerousTarget(target: string): boolean {
  const normal = withoutControlsOrBlanks(
    target
      .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => character(parseInt(h, 16)))
      .replace(/&#([0-9]+);?/g, (_, d: string) => character(Number(d)))
      .replace(/&colon;/gi, ":")
      .replace(/&tab;|&newline;/gi, "")
  ).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:/.test(normal)) return false; // relative: does not execute
  return !/^(https?|mailto|tel):/.test(normal);
}

/**
 * Walks a block value and voids dangerous URLs in keys that are URLs
 * (`url`, `ctaUrl`, `href`, `linkUrl`, `src`, `image`…). The web renders those
 * fields as `href`/`src` without going through the shared renderer.
 */
const URL_KEY = /(url|href|src|link)$/i;

function sanitizeUrlsOf(value: unknown, depth = 0): unknown {
  if (depth > 20) return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeUrlsOf(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && URL_KEY.test(key) && dangerousTarget(v.trim())) {
      output[key] = "";
    } else {
      output[key] = sanitizeUrlsOf(v, depth + 1);
    }
  }
  return output;
}

/**
 * An entry's blocks: `richtext` sanitized according to its format and all the
 * URLs of any block checked. What is not an array is returned as is.
 */
export function sanitizeBlocks(blocks: unknown): unknown {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return block;
    const b = sanitizeUrlsOf(block) as { type?: unknown; data?: Record<string, unknown> };
    if (b.type === "richtext" && b.data && typeof b.data.content === "string") {
      const html = b.data.format === "html";
      b.data = {
        ...b.data,
        content: html ? sanitizeHtml(b.data.content) : sanitizeMarkdown(b.data.content),
      };
    }
    return b;
  });
}

/**
 * An entry's blocks with the English data keys, accepting the 0.8 (Spanish) ones a block could
 * still carry (`titulo` → `title`…, see `@kitsuden/shared` block-keys.ts and migration
 * `0010_english_block_keys.sql`).
 */
// Remove in 0.10: serve `blocks` as stored.
export function englishBlocks(blocks: unknown): unknown {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (!block || typeof block !== "object" || !("data" in block)) return block;
    const b = block as { type?: unknown; data?: unknown };
    const data = readBlockData(b.type, b.data);
    return data === b.data ? block : { ...block, data };
  });
}

/**
 * The 422 body for blocks that still use 0.8 key names (`titulo`, `campos`…), or `null`. A post
 * is written in the 0.9 contract only: a Spanish key would be saved and never read.
 */
export function oldBlockKeysError(blocks: unknown) {
  if (!Array.isArray(blocks)) return null;
  const found = blocks.flatMap((block, i) => {
    if (!block || typeof block !== "object") return [];
    const b = block as { type?: unknown; data?: unknown };
    return findSpanishBlockKeys(b.type, b.data).map((k) => ({
      path: `blocks[${i}].data.${k.path}`,
      use: `blocks[${i}].data.${k.use}`,
    }));
  });
  return found.length ? spanishKeysError(found, "post's blocks") : null;
}

/** `content`: if it is HTML as a string it is sanitized; a JSON document is left alone. */
export function sanitizeBody(content: unknown): unknown {
  return typeof content === "string" ? sanitizeHtml(content) : content;
}

/**
 * What a post shows when SERVED: body and blocks sanitized and, for whoever
 * is not on the team, the `source` without the snapshot of the source row.
 *
 * `source.snapshot.rawData` is the WHOLE row of the table the entry was promoted
 * from (`promote-from-source`): internal columns, emails, whatever
 * there was. It traveled in `GET /api/blog` to anyone. The rest of `source`
 * (`imageUrl`, `imageAlt`, `type`, `coverInBody`) is used by the site and
 * stays.
 */
export function postToServe<T extends Record<string, unknown>>(post: T, isTeam: boolean): T {
  const output: Record<string, unknown> = { ...post };
  if ("content" in output) output.content = sanitizeBody(output.content);
  if ("blocks" in output) output.blocks = sanitizeBlocks(englishBlocks(output.blocks));
  if (!isTeam && output.source && typeof output.source === "object") {
    const {
      snapshot: _snapshot,
      rawData: _rawData,
      ...rest
    } = output.source as Record<string, unknown>;
    output.source = rest;
  }
  return output as T;
}
