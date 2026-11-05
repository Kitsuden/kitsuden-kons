/**
 * GEO (Generative Engine Optimization) Utilities
 *
 * Functions to optimize content for AI engines and generate
 * structured rich snippets (Schema.org).
 *
 * Includes:
 * - JSON-LD generation (FAQPage, Article, BlogPosting)
 * - BLUF (Bottom Line Up Front) validation
 * - HTML sanitization for FAQs
 * - Table of contents (TOC) extraction
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REFERENCES:
 * ═══════════════════════════════════════════════════════════════════════════
 * - Schema.org FAQPage: https://schema.org/FAQPage
 * - Google FAQ Rich Snippets: https://developers.google.com/search/docs/appearance/structured-data/faqpage
 * - BLUF Writing Style: https://www.plainlanguage.gov/guidelines/organize/whenever-possible-use-the-bluf-botton-line-up-front/
 */

import type { FAQItem } from "./schema.local";
import { getOGImageUrl } from "./seo-utils";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * JSON-LD Schema.org FAQPage structure
 */
export interface FAQPageSchema {
  "@context": "https://schema.org";
  "@type": "FAQPage";
  mainEntity: Array<{
    "@type": "Question";
    name: string;
    acceptedAnswer: {
      "@type": "Answer";
      text: string;
    };
  }>;
}

/**
 * Article/BlogPosting schema with BLUF
 */
export interface ArticleSchema {
  "@context": "https://schema.org";
  "@type": "BlogPosting" | "Article" | "NewsArticle";
  headline: string;
  description: string;
  url?: string;
  image?:
    | string
    | {
        "@type": "ImageObject";
        url: string;
        width?: number;
        height?: number;
      };
  datePublished: string;
  dateModified?: string;
  author?: {
    "@type": "Person";
    name: string;
    url?: string;
  };
  publisher?: {
    "@type": "Organization";
    name: string;
    logo?: {
      "@type": "ImageObject";
      url: string;
    };
  };
  articleBody?: string;
  wordCount?: number;
  /** AI-optimized abstract (BLUF) */
  abstract?: string;
  /** FAQ Schema (separate from Article) */
  faqSchema?: FAQPageSchema | null;
}

/**
 * TOC Item extracted from headings
 */
export interface TOCItem {
  level: number;
  text: string;
  id: string;
}

/**
 * Validation result for content
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  metrics: {
    wordCount: number;
    charCount: number;
    readingTime: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON-LD GENERATORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate FAQPage Schema.org JSON-LD from FAQ items
 *
 * This function transforms the FAQ array from the database
 * into the structured format required by Schema.org for
 * rich snippets in Google.
 *
 * @param faqs - Array of FAQs from the database
 * @param baseUrl - Site base URL (for internal links)
 * @returns JSON-LD object ready to inject into <head>
 *
 * @example
 * const faqs = [
 *   { q: "What is SEO?", a: "It is the optimization..." },
 *   { q: "Why does it matter?", a: "Because..." }
 * ];
 *
 * const schema = generateFAQPageSchema(faqs);
 * // Inject into HTML: <script type="application/ld+json">
 */
export function generateFAQPageSchema(
  faqs: FAQItem[],
  options?: {
    stripHtml?: boolean;
    maxAnswerLength?: number;
  }
): FAQPageSchema | null {
  if (!faqs || faqs.length === 0) return null;

  const { stripHtml = true, maxAnswerLength = 500 } = options || {};

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => {
      // Clean HTML if necessary
      let answer = faq.a;
      if (stripHtml) {
        answer = stripHtmlTags(answer);
      }

      // Truncate the answer if it is too long (Google recommends concise answers)
      if (answer.length > maxAnswerLength) {
        answer = answer.substring(0, maxAnswerLength).trim() + "...";
      }

      return {
        "@type": "Question",
        name: faq.q,
        acceptedAnswer: {
          "@type": "Answer",
          text: answer,
        },
      };
    }),
  };
}

/**
 * Generate Article/BlogPosting Schema.org JSON-LD
 *
 * @param data - Article data
 * @returns Complete JSON-LD schema
 *
 * @example
 * const schema = generateArticleSchema({
 *   title: "SEO Guide 2024",
 *   description: "Learn SEO...",
 *   bluf: "A 50-word summary...",
 *   publishedAt: "2024-01-15",
 *   author: { name: "Jane" },
 *   faqs: [...]
 * });
 */
export function generateArticleSchema(data: {
  title: string;
  description: string;
  bluf?: string;
  url: string;
  publishedAt: string | Date;
  modifiedAt?: string | Date;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  author?: { name: string; url?: string };
  publisher?: { name: string; logo?: string };
  wordCount?: number;
  faqs?: FAQItem[];
  type?: "BlogPosting" | "Article" | "NewsArticle";
}): ArticleSchema {
  const schema: ArticleSchema = {
    "@context": "https://schema.org",
    "@type": data.type || "BlogPosting",
    headline: data.title,
    description: data.description,
    datePublished: new Date(data.publishedAt).toISOString(),
    abstract: data.bluf, // BLUF as abstract for AI
  };

  // Optional URL
  if (data.url) {
    schema.url = data.url;
  }

  // Modification date (optional but recommended)
  if (data.modifiedAt) {
    schema.dateModified = new Date(data.modifiedAt).toISOString();
  }

  // Image (can be a string or ImageObject)
  if (data.image) {
    if (data.imageWidth && data.imageHeight) {
      schema.image = {
        "@type": "ImageObject",
        url: data.image,
        width: data.imageWidth,
        height: data.imageHeight,
      };
    } else {
      schema.image = data.image;
    }
  }

  // Author
  if (data.author) {
    schema.author = {
      "@type": "Person",
      name: data.author.name,
      url: data.author.url,
    };
  }

  // Publisher
  if (data.publisher) {
    schema.publisher = {
      "@type": "Organization",
      name: data.publisher.name,
    };
    if (data.publisher.logo) {
      schema.publisher.logo = {
        "@type": "ImageObject",
        url: data.publisher.logo,
      };
    }
  }

  // Word count (useful for AI)
  if (data.wordCount) {
    schema.wordCount = data.wordCount;
  }

  // Separate FAQ Schema (Google recommends not nesting FAQPage inside Article)
  if (data.faqs && data.faqs.length > 0) {
    schema.faqSchema = generateFAQPageSchema(data.faqs);
  }

  return schema;
}

// ═══════════════════════════════════════════════════════════════════════════
// BLUF (BOTTOM LINE UP FRONT) UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate BLUF (Bottom Line Up Front)
 *
 * The BLUF is a concise summary designed to:
 * 1. Be extracted by AI as a direct answer
 * 2. Meet snippet length limits
 *
 * Validation rules:
 * - Maximum 50 words (ideal: 30-40)
 * - Must contain the main answer
 * - Must not repeat the title
 * - Must be self-contained
 *
 * @param bluf - BLUF text to validate
 * @returns Validation result with metrics
 *
 * @example
 * const result = validateBLUF(
 *   "SEO in 2024 calls for quality content, " +
 *   "an excellent user experience and optimization for voice search."
 * );
 * // result.isValid = true
 * // result.metrics.wordCount = 17
 */
export function validateBLUF(bluf: string | null | undefined): ValidationResult {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
    metrics: {
      wordCount: 0,
      charCount: 0,
      readingTime: 0,
    },
  };

  if (!bluf || bluf.trim().length === 0) {
    result.errors.push("BLUF cannot be empty");
    result.isValid = false;
    return result;
  }

  // Compute metrics
  const cleanText = bluf.trim();
  const words = cleanText.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  const charCount = cleanText.length;
  const readingTime = Math.ceil(wordCount / 200); // 200 WPM average

  result.metrics = { wordCount, charCount, readingTime };

  // Validate word limit (strict: max 50)
  if (wordCount > 50) {
    result.errors.push(
      `BLUF exceeds the 50-word limit (current: ${wordCount}). ` +
        "AIs truncate long answers."
    );
    result.isValid = false;
  } else if (wordCount > 40) {
    result.warnings.push(
      `BLUF has ${wordCount} words. ` +
        "Consider reducing it to 30-40 words for better AI extraction."
    );
  }

  // Validate minimum length
  if (wordCount < 10) {
    result.warnings.push(
      `BLUF has only ${wordCount} words. ` + "It may be insufficient for context."
    );
  }

  // Validate that it is not all caps (spam indicator)
  const upperCaseRatio =
    cleanText.replace(/[^a-zA-Z]/g, "").length > 0
      ? cleanText.replace(/[^A-Z]/g, "").length / cleanText.replace(/[^a-zA-Z]/g, "").length
      : 0;

  if (upperCaseRatio > 0.7) {
    result.warnings.push("Avoid excessive UPPERCASE in the BLUF");
  }

  // Validate first letter capitalized
  if (!/^[A-ZÁÉÍÓÚÜÑ]/.test(cleanText)) {
    result.warnings.push("The BLUF must start with a capital letter");
  }

  // Validate final punctuation
  if (!/[.!?]$/.test(cleanText)) {
    result.warnings.push("The BLUF must end with punctuation");
  }

  return result;
}

/**
 * Suggest a BLUF improvement based on the content
 *
 * @param content - Full article content
 * @param maxWords - Maximum words (default: 50)
 * @returns Suggested BLUF extracted from the first paragraph
 */
export function suggestBLUF(content: string, maxWords: number = 50): string {
  // Extract first meaningful paragraph
  const paragraphs = content
    .replace(/<[^>]+>/g, " ") // Clean HTML
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 50); // Ignore very short paragraphs

  if (paragraphs.length === 0) return "";

  const firstParagraph = paragraphs[0];
  const words = firstParagraph.split(/\s+/);

  if (words.length <= maxWords) {
    return firstParagraph;
  }

  // Truncate to word limit, ending on a complete sentence
  const truncated = words.slice(0, maxWords).join(" ");
  const lastPeriod = truncated.lastIndexOf(".");

  if (lastPeriod > truncated.length * 0.7) {
    return truncated.substring(0, lastPeriod + 1);
  }

  return truncated + "...";
}

// ═══════════════════════════════════════════════════════════════════════════
// HTML SANITIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * HTML tags allowed for FAQs and content
 *
 * Allowlist of safe tags that allow structure
 * without XSS risk.
 */
export const ALLOWED_HTML_TAGS = [
  // Text structure
  "p",
  "br",
  "hr",
  // Inline formatting
  "strong",
  "b",
  "em",
  "i",
  "u",
  "mark",
  "small",
  "del",
  "ins",
  // Links (validated separately)
  "a",
  // Lists
  "ul",
  "ol",
  "li",
  // Tables (for comparisons)
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "caption",
  // Headings (limited)
  "h3",
  "h4",
  // Others
  "blockquote",
  "code",
  "pre",
  "sup",
  "sub",
] as const;

/**
 * HTML attributes allowed per tag
 */
export const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "title", "rel"],
  img: ["src", "alt", "width", "height"],
  th: ["scope", "colspan", "rowspan"],
  td: ["colspan", "rowspan"],
  "*": ["class"], // Classes allowed on all tags
};

/**
 * URLs allowed in href (prevent javascript:)
 */
const ALLOWED_URL_SCHEMES = ["http:", "https:", "mailto:", "tel:"];

/**
 * Sanitize HTML allowing only safe tags
 *
 * @param html - HTML to sanitize
 * @param allowedTags - List of allowed tags (default: ALLOWED_HTML_TAGS)
 * @returns Sanitized HTML
 *
 * @example
 * const dirty = '<p>Texto</p><script>alert("xss")</script>';
 * const clean = sanitizeHTML(dirty);
 * // Result: '<p>Texto</p>'
 */
export function sanitizeHTML(
  html: string,
  options?: {
    allowedTags?: readonly string[];
    stripAll?: boolean;
  }
): string {
  const { allowedTags = ALLOWED_HTML_TAGS, stripAll = false } = options || {};

  if (stripAll) {
    return stripHtmlTags(html);
  }

  // Create a DOM parser (works in browser, for Node use jsdom or similar)
  if (typeof DOMParser === "undefined") {
    // Simple fallback for Node.js
    return stripHtmlTags(html);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  function sanitizeNode(node: Node): Node | null {
    // Text nodes are kept
    if (node.nodeType === Node.TEXT_NODE) {
      return node.cloneNode();
    }

    // Element nodes
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const tagName = element.tagName.toLowerCase();

      // If the tag is not allowed, keep only the text content
      if (!allowedTags.includes(tagName)) {
        const text = document.createTextNode(element.textContent || "");
        return text;
      }

      // Create a new clean tag
      const cleanElement = document.createElement(tagName);

      // Copy allowed attributes
      const allowedAttrs = ALLOWED_ATTRIBUTES[tagName] || ALLOWED_ATTRIBUTES["*"] || [];

      Array.from(element.attributes).forEach((attr) => {
        const attrName = attr.name.toLowerCase();

        if (allowedAttrs.includes(attrName)) {
          const attrValue = attr.value;

          // Validate URLs in href/src
          if (attrName === "href" || attrName === "src") {
            try {
              const url = new URL(attrValue, "http://example.com");
              if (!ALLOWED_URL_SCHEMES.includes(url.protocol)) {
                return; // Skip attribute with invalid URL
              }
              // Add rel="nofollow" to external links
              if (attrName === "href" && tagName === "a") {
                cleanElement.setAttribute("rel", "nofollow noopener");
              }
            } catch {
              return; // Skip attribute with malformed URL
            }
          }

          cleanElement.setAttribute(attrName, attrValue);
        }
      });

      // Recursively sanitize children
      Array.from(element.childNodes).forEach((child) => {
        const cleanChild = sanitizeNode(child);
        if (cleanChild) {
          cleanElement.appendChild(cleanChild);
        }
      });

      return cleanElement;
    }

    return null;
  }

  // Sanitizar body
  const cleanBody = document.createElement("div");
  Array.from(doc.body.childNodes).forEach((child) => {
    const cleanChild = sanitizeNode(child);
    if (cleanChild) {
      cleanBody.appendChild(cleanChild);
    }
  });

  return cleanBody.innerHTML;
}

/**
 * Simple sanitization version for Node.js (no DOM)
 * Removes all HTML tags
 *
 * @param html - HTML to clean
 * @returns Plain text
 */
export function stripHtmlTags(html: string): string {
  if (!html) return "";

  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sanitize specifically for FAQs (more restrictive)
 *
 * @param text - Text to sanitize
 * @returns Clean HTML for FAQ
 */
export function sanitizeFAQText(text: string): string {
  // Allow only basic formatting in FAQs
  const allowedFAQTags = ["p", "br", "strong", "b", "em", "i", "a", "code"];
  return sanitizeHTML(text, { allowedTags: allowedFAQTags });
}

// ═══════════════════════════════════════════════════════════════════════════
// TABLE OF CONTENTS (TOC) EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract table of contents from Lexical or HTML content
 *
 * @param content - Content (Lexical JSON or HTML)
 * @returns Array of TOC items
 */
export function extractTOC(content: any): TOCItem[] {
  const toc: TOCItem[] = [];

  if (!content) return toc;

  // Si es Lexical format
  if (typeof content === "object" && content.root) {
    extractLexicalHeadings(content.root, toc);
  } else if (typeof content === "string") {
    // Si es HTML
    extractHTMLHeadings(content, toc);
  }

  return toc;
}

function extractLexicalHeadings(node: any, toc: TOCItem[]): void {
  if (!node) return;

  // Heading nodes en Lexical
  if (node.type === "heading" && node.tag) {
    const level = parseInt(node.tag.replace("h", ""));
    const text = extractTextFromLexicalNode(node);
    if (text && level >= 2 && level <= 4) {
      toc.push({
        level,
        text: text.substring(0, 100),
        id: slugify(text),
      });
    }
  }

  // Recursively process children
  if (node.children && Array.isArray(node.children)) {
    node.children.forEach((child: any) => extractLexicalHeadings(child, toc));
  }
}

function extractHTMLHeadings(html: string, toc: TOCItem[]): void {
  const headingRegex = /<h([2-4])[^>]*>(.*?)<\/h\1>/gi;
  let match;

  while ((match = headingRegex.exec(html)) !== null) {
    const level = parseInt(match[1]);
    const text = stripHtmlTags(match[2]);
    if (text) {
      toc.push({
        level,
        text: text.substring(0, 100),
        id: slugify(text),
      });
    }
  }
}

function extractTextFromLexicalNode(node: any): string {
  if (!node) return "";

  if (node.text) return node.text;

  if (node.children && Array.isArray(node.children)) {
    return node.children.map(extractTextFromLexicalNode).join("");
  }

  return "";
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

// ═══════════════════════════════════════════════════════════════════════════
// API PAYLOAD BUILDER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build an API payload optimized for the frontend
 *
 * This function organizes all the post's data into the
 * optimal structure for consumption by Astro, React, Vue, etc.
 *
 * @param post - Post from the database
 * @param options - Configuration options
 * @returns Structured payload
 *
 * @example
 * const payload = buildAPIPayload(post, {
 *   baseUrl: "https://misitio.com",
 *   siteName: "Mi Blog"
 * });
 *
 * // In frontend:
 * <title>{payload.seo.title}</title>
 * <meta name="description" content={payload.seo.description} />
 * <script type="application/ld+json">
 *   {JSON.stringify(payload.geo_ai.schema_faq)}
 * </script>
 * <article>
 *   <p>{payload.geo_ai.bluf}</p>
 *   {@html payload.content.body}
 * </article>
 */
export function buildAPIPayload(
  post: {
    id: string;
    slug: string;
    title: string;
    content?: any;
    excerpt?: string | null;
    blufText?: string | null;
    faqData?: FAQItem[];
    datasetUrl?: string | null;
    metaTitle?: string | null;
    metaDescription?: string | null;
    ogImageId?: string | null;
    featuredImageId?: string | null;
    featuredImageFocalPoint?: { x: number; y: number } | null;
    status: string;
    publishedAt?: Date | string | null;
    updatedAt?: Date | string;
    author?: { name: string; image?: string };
    featuredImage?: { url: string; width?: number; height?: number };
    readingTime?: number | null;
  },
  options: {
    baseUrl: string;
    siteName: string;
    stripHtmlFromBluf?: boolean;
  }
): {
  id: string;
  slug: string;
  status: string;
  publishedAt?: string;
  updatedAt: string;
  author?: { name: string; image?: string };
  seo: {
    title: string;
    description: string;
    canonicalUrl: string;
    ogImage?: string;
    ogImageWidth?: number;
    ogImageHeight?: number;
    featuredImageId?: string;
    featuredImageFocalPoint?: { x: number; y: number };
  };
  geo_ai: {
    bluf: string;
    schema_faq?: any;
    dataset_url?: string;
    reading_time?: number;
    word_count?: number;
  };
  content: {
    body: any;
    excerpt?: string;
    toc: any[];
  };
} {
  const { baseUrl, siteName, stripHtmlFromBluf = true } = options;

  // Build canonical URL
  const canonicalUrl = `${baseUrl.replace(/\/$/, "")}/blog/${post.slug}`;

  // Prepare BLUF
  let bluf: string = post.blufText || post.excerpt || "";
  if (stripHtmlFromBluf) {
    bluf = stripHtmlTags(bluf);
  }
  // Ensure it is never null
  bluf = bluf || "";

  // Count content words
  const contentText =
    typeof post.content === "string" ? post.content : JSON.stringify(post.content);
  const wordCount = contentText.split(/\s+/).filter((w) => w.length > 0).length;

  // Generate FAQ schema
  const faqSchema =
    post.faqData && post.faqData.length > 0 ? generateFAQPageSchema(post.faqData) : undefined;

  return {
    id: post.id,
    slug: post.slug,
    status: post.status,
    publishedAt: post.publishedAt ? new Date(post.publishedAt).toISOString() : undefined,
    updatedAt: new Date(post.updatedAt || Date.now()).toISOString(),
    author: post.author,

    seo: {
      title: post.metaTitle || `${post.title} | ${siteName}`,
      description: post.metaDescription || post.excerpt || "",
      canonicalUrl,
      ogImage: post.ogImageId
        ? getOGImageUrl(post.ogImageId, post.featuredImageFocalPoint || undefined, baseUrl)
        : post.featuredImageId
          ? getOGImageUrl(post.featuredImageId, post.featuredImageFocalPoint || undefined, baseUrl)
          : undefined,
      ogImageWidth: 1200,
      ogImageHeight: 630,
      featuredImageId: post.featuredImageId ?? undefined,
      featuredImageFocalPoint: post.featuredImageFocalPoint ?? undefined,
    },

    geo_ai: {
      bluf,
      schema_faq: faqSchema,
      dataset_url: post.datasetUrl ?? undefined,
      reading_time: post.readingTime || Math.ceil(wordCount / 200),
      word_count: wordCount,
    },

    content: {
      body: post.content,
      excerpt: post.excerpt ?? undefined,
      toc: extractTOC(post.content),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export default {
  // JSON-LD Generators
  generateFAQPageSchema,
  generateArticleSchema,

  // BLUF Utilities
  validateBLUF,
  suggestBLUF,

  // HTML Sanitization
  sanitizeHTML,
  stripHtmlTags,
  sanitizeFAQText,
  ALLOWED_HTML_TAGS,
  ALLOWED_ATTRIBUTES,

  // TOC
  extractTOC,

  // API Builder
  buildAPIPayload,
};
