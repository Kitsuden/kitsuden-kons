/**
 * Security (2026-10-15): sanitizing blog and page builder content
 * ============================================================================
 *
 * Stored XSS: an entry's body (`content` in HTML, `richtext` blocks
 * in markdown) was saved as is and the web paints it with
 * `set:html`. `marked` does not sanitize. Here we test the allowlist sanitizer that
 * is now applied on save and on serve, and that does NOT change real content
 * (the tags and attributes used by published entries).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  invalidCss,
  invalidStyle,
  sanitizeBlockContent,
  sanitizeEmbed,
  sanitizeHtml as sanitizeHtmlBlocks,
} from "../../.kitsuden/packages/core/blocks/blocks.sanitize";
import {
  postToServe,
  sanitizeBlocks,
  sanitizeHtml,
  sanitizeMarkdown,
} from "../../kons/kon-blog/src/sanitize";

const ROOT = join(__dirname, "..", "..");

const ATTACKS = [
  `<script>alert(1)</script>`,
  `<SCRIPT src=//x.y></SCRIPT>`,
  `<script>sin cerrar`,
  `<img src=x onerror=alert(1)>`,
  `<img src="x" ONERROR="alert(1)">`,
  `<a href="javascript:alert(1)">x</a>`,
  `<a href="&#106;avascript:alert(1)">x</a>`,
  `<a href=" java\tscript:alert(1)">x</a>`,
  `<a href="data:text/html,<script>alert(1)</script>">x</a>`,
  `<iframe src="https://evil.example"></iframe>`,
  `<svg><script>alert(1)</script></svg>`,
  `<svg onload=alert(1)>`,
  `<style>body{background:url(javascript:alert(1))}</style>`,
  `<div style="background:url(javascript:alert(1))">x</div>`,
  `<p/onmouseover=alert(1)>x</p>`,
  `<math><mtext><img src=x onerror=alert(1)></mtext></math>`,
  `<!--<img src=x onerror=alert(1)>-->`,
  `<object data="x"></object><embed src="x">`,
  `<form action="https://x"><button formaction="javascript:alert(1)">x</button></form>`,
  `<<script>alert(1)//<</script>`,
  `<img src=x onerror=alert(1)//`,
  `<details open ontoggle=alert(1)>`,
];

/** Is anything executable left? (tags or attributes the browser would run) */
function executable(html: string): boolean {
  return (
    /<\s*(script|iframe|svg|math|object|embed|style|form|button)\b/i.test(html) ||
    /<[^>]*\son[a-z]+\s*=/i.test(html) ||
    /<[^>]*\b(href|src|action|formaction)\s*=\s*["']?\s*(javascript|data|vbscript):/i.test(html) ||
    /<[^>]*\bstyle\s*=/i.test(html)
  );
}

describe("sanearHtml (allowlist)", () => {
  it.each(ATTACKS)("neutralizes %s", (attack) => {
    const clean = sanitizeHtml(attack);
    expect(executable(clean), clean).toBe(false);
    // Idempotent: sanitizing what is sanitized changes nothing.
    expect(sanitizeHtml(clean)).toBe(clean);
  });

  it("leaves intact the HTML used by published entries", () => {
    const real =
      `<p class="lead text-lg text-zinc-300 font-sans leading-relaxed">\nTexto <strong>100%</strong> y <em>más</em></p>` +
      `<figure class="my-6"><img src="/media/games/x.webp" alt="Alt" loading="lazy"><figcaption>Pie</figcaption></figure>` +
      `<h2>Título</h2><h3>Sub</h3><ul><li>uno</li></ul><ol><li>dos</li></ol>` +
      `<div class="callout"><span class="x">s</span></div><a href="https://ejemplo.com/a?b=1&amp;c=2">enlace</a>`;
    expect(sanitizeHtml(real)).toBe(real);
  });

  it("does not touch text that is not a tag", () => {
    expect(sanitizeHtml("a < b y 3 > 2, <3")).toBe("a < b y 3 > 2, <3");
    // Since the 2026-10-25 audit (XSS via autolinks, see
    // tests/unit/saneado-autoenlaces.test.ts in the core) an autolink is
    // rewritten as an <a> built by the sanitizer: the same link.
    expect(sanitizeMarkdown("# Título\n\n> cita\n\n**negrita** <https://ejemplo.com>")).toBe(
      '# Título\n\n> cita\n\n**negrita** <a href="https://ejemplo.com">https://ejemplo.com</a>'
    );
  });
});

describe("sanearMarkdown", () => {
  it("nullifies link and image destinations with a dangerous scheme", () => {
    const md =
      "[a](javascript:alert(1)) ![b](JaVaScRiPt:alert(1)) [c](&#106;avascript:alert(1)) " +
      "[d](https://ok.example) [e](/relativa) <javascript:alert(1)>\n\n[ref]: javascript:alert(1)";
    const clean = sanitizeMarkdown(md);
    expect(clean).not.toMatch(/javascript/i);
    expect(clean).not.toMatch(/&#106;/);
    expect(clean).toContain("[d](https://ok.example)");
    expect(clean).toContain("[e](/relativa)");
  });
});

describe("blog blocks", () => {
  it("richtext according to its format and URLs of any block", () => {
    const [md, html, hero] = sanitizeBlocks([
      {
        type: "richtext",
        data: { content: "hola <img src=x onerror=alert(1)> [x](javascript:1)" },
      },
      {
        type: "richtext",
        data: { format: "html", content: "<p onclick=x>ok</p><script>1</script>" },
      },
      {
        type: "hero",
        data: {
          ctaUrl: "javascript:alert(1)",
          ctaLabel: "<b>x</b>",
          backgroundImageUrl: "/a.webp",
        },
      },
    ]) as any[];
    expect(executable(md.data.content)).toBe(false);
    expect(md.data.content).not.toMatch(/javascript/i);
    expect(html.data.content).toBe("<p>ok</p>");
    expect(hero.data.ctaUrl).toBe("");
    expect(hero.data.backgroundImageUrl).toBe("/a.webp");
  });

  it("postParaServir removes the origin row snapshot for the public and not for the team", () => {
    const post = {
      id: "1",
      content: "<p>x</p><script>1</script>",
      source: { imageUrl: "/a.webp", type: "meta", snapshot: { rawData: { email: "a@b.c" } } },
    };
    const audience = postToServe(post, false) as any;
    expect(audience.source).toEqual({ imageUrl: "/a.webp", type: "meta" });
    expect(audience.content).toBe("<p>x</p>");
    expect((postToServe(post, true) as any).source.snapshot.rawData.email).toBe("a@b.c");
  });
});

describe("page builder blocks", () => {
  it("text in html/markdown, embed only with player iframes, URLs", () => {
    const t = sanitizeBlockContent("text", {
      format: "html",
      text: "<p>a</p><img src=x onerror=1>",
    }) as any;
    expect(t.text).toBe('<p>a</p><img src="x">');
    const plain = sanitizeBlockContent("text", {
      format: "plain",
      text: "<b>se escapa al pintar</b>",
    }) as any;
    expect(plain.text).toBe("<b>se escapa al pintar</b>");
    const cta = sanitizeBlockContent("cta", {
      buttonUrl: "javascript:alert(1)",
      title: "x",
    }) as any;
    expect(cta.buttonUrl).toBe("");

    const yt = sanitizeEmbed(
      '<iframe src="https://www.youtube.com/embed/abc123" width="560" onload="x" allowfullscreen></iframe><script>1</script>'
    );
    expect(yt).toBe(
      '<iframe src="https://www.youtube.com/embed/abc123" width="560" allowfullscreen></iframe>'
    );
    expect(sanitizeEmbed('<iframe src="https://evil.example/x"></iframe>')).toBe("");
    expect(sanitizeEmbed('<iframe src="javascript:alert(1)"></iframe>')).toBe("");
    expect(sanitizeEmbed("\u00010\u0001")).toBe("0");
  });

  it("customCss and styles", () => {
    expect(invalidCss(".a{color:red}")).toBeNull();
    expect(invalidCss("</style><script>alert(1)</script>")).not.toBeNull();
    expect(invalidCss("@import url(https://x)")).not.toBeNull();
    expect(
      invalidStyle({ cssClass: "md:p-4 bg-[#111] w-1/2", backgroundColor: "#fff" })
    ).toBeNull();
    expect(invalidStyle({ cssClass: 'x" onmouseover="alert(1)' })).not.toBeNull();
    expect(invalidStyle({ backgroundColor: "red;background:url(x)" })).not.toBeNull();
  });

  it("the sanitizer's copy in blocks is identical to the blog's", () => {
    const blog = readFileSync(join(ROOT, "kons/kon-blog/src/sanitize.ts"), "utf8").replace(
      /\r\n/g,
      "\n"
    );
    const blocks = readFileSync(
      join(ROOT, ".kitsuden/packages/core/blocks/blocks.sanitize.ts"),
      "utf8"
    ).replace(/\r\n/g, "\n");
    const from = blog.indexOf("/** Tags that are kept. */");
    const until = blog.indexOf("/**\n * An entry's blocks: `richtext` sanitized according to its format and all the");
    const blogPiece = blog.slice(from, until).trim();
    const blocksPiece = blocks
      .slice(
        blocks.indexOf("/** Tags that are kept. */"),
        blocks.indexOf("// ── END OF THE COPY")
      )
      .trim();
    expect(from).toBeGreaterThan(0);
    // Each repository formats with its own line width: compare the code, not the wrapping.
    const code = (s: string) => s.replace(/\s+/g, " ");
    expect(code(blocksPiece)).toBe(code(blogPiece));
    for (const attack of ATTACKS) expect(sanitizeHtmlBlocks(attack)).toBe(sanitizeHtml(attack));
  });
});
