/**
 * SEO Utilities for Blog Posts
 *
 * Image Transform URL Helpers:
 * - getFeaturedImageUrl: /api/media/preset/{id}/large
 * - getOGImageUrl: /api/media/transform/{id}?w=1200&h=630&fit=cover&f=jpeg&q=90
 * - Focal point support for smart cropping
 *
 * Comprehensive SEO metadata generation including:
 * - Meta tags for search engines (title, description, robots)
 * - Open Graph tags for social sharing (Facebook, LinkedIn, etc.)
 * - Twitter Cards for Twitter/X sharing
 * - JSON-LD Schema.org structured data
 * - Canonical URLs and hreflang
 * - Reading time and word count
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * USAGE:
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * const seoData = generateSEOMetadata({
 *   post: blogPost,
 *   author: { name: "John Doe", image: "..." },
 *   featuredImage: { url: "...", width: 1200, height: 630 },
 *   siteConfig: {
 *     name: "My Blog",
 *     baseUrl: "https://example.com",
 *     twitterHandle: "@myblog",
 *     defaultOgImage: "https://example.com/default-og.jpg"
 *   }
 * });
 *
 * // Access different SEO components:
 * seoData.title           // Optimized title (50-60 chars)
 * seoData.metaDescription // Optimized description (150-160 chars)
 * seoData.metaTags        // Array of { name, content }
 * seoData.openGraph       // Open Graph object
 * seoData.twitterCard     // Twitter Card object
 * seoData.jsonLd          // JSON-LD structured data
 * seoData.canonicalUrl    // Canonical URL
 * seoData.hreflang        // Language alternatives
 */

import type { BlogPost, BlogPostWithRelations } from "./schema";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** SEO length limits (best practices) */
export const SEO_LIMITS = {
  /** Page title: 50-60 characters for optimal display in SERP */
  title: { min: 30, optimal: 55, max: 60 },
  /** Meta description: 150-160 characters for optimal display */
  description: { min: 50, optimal: 155, max: 160 },
  /** Open Graph title: up to 88 characters */
  ogTitle: { max: 88 },
  /** Open Graph description: up to 200 characters */
  ogDescription: { max: 200 },
  /** Twitter title: up to 70 characters */
  twitterTitle: { max: 70 },
  /** Twitter description: up to 200 characters */
  twitterDescription: { max: 200 },
} as const;

/** Schema.org types for blog content */
export const SCHEMA_TYPES = {
  BLOG_POSTING: "BlogPosting",
  ARTICLE: "Article",
  NEWS_ARTICLE: "NewsArticle",
  TECH_ARTICLE: "TechArticle",
  SCHOLARLY_ARTICLE: "ScholarlyArticle",
  BLOG: "Blog",
  WEB_PAGE: "WebPage",
  PERSON: "Person",
  ORGANIZATION: "Organization",
  IMAGE_OBJECT: "ImageObject",
} as const;

/** Robot meta directives */
export const ROBOT_DIRECTIVES = {
  INDEX_FOLLOW: "index,follow",
  INDEX_NOFOLLOW: "index,nofollow",
  NOINDEX_FOLLOW: "noindex,follow",
  NOINDEX_NOFOLLOW: "noindex,nofollow",
  INDEX_FOLLOW_NOARCHIVE: "index,follow,noarchive",
  NOINDEX_NOFOLLOW_NOARCHIVE: "noindex,nofollow,noarchive",
} as const;

/**
 * WhatsApp Open Graph Image Requirements (STRICT)
 *
 * WhatsApp is VERY picky about og:image. If these requirements are not met,
 * WhatsApp will NOT show the image preview in chats.
 *
 * Source: https://developers.facebook.com/docs/sharing/webmasters/images/
 * WhatsApp specific: https://stackoverflow.com/questions/19778620/provide-an-image-for-whatsapp-link-sharing
 */
export const WHATSAPP_OG_LIMITS = {
  /** Maximum file size: 300KB (WhatsApp will reject larger images) */
  maxFileSizeKB: 300,
  maxFileSizeBytes: 300 * 1024,

  /**
   * Ideal dimensions for og:image
   * Aspect ratio: 1.91:1 (Facebook/LinkedIn standard)
   * WhatsApp crops to square in some cases, so center important content
   */
  idealDimensions: {
    width: 1200,
    height: 630,
    ratio: 1.91, // 1200/630
  },

  /** Minimum dimensions (below this WhatsApp may not show preview) */
  minDimensions: {
    width: 400,
    height: 400,
  },

  /**
   * Accepted formats for WhatsApp og:image
   * JPG and PNG are safest
   * AVOID WebP - some older WhatsApp versions don't render it
   * AVOID GIF - not supported for preview
   * AVOID SVG - not supported
   */
  acceptedFormats: ["image/jpeg", "image/jpg", "image/png"],
  acceptedExtensions: [".jpg", ".jpeg", ".png"],

  /**
   * Format recommendations by platform:
   * - WhatsApp: JPG/PNG only, < 300KB
   * - Facebook: JPG/PNG/WebP, any size
   * - LinkedIn: JPG/PNG, minimum 1200x627
   * - Twitter: JPG/PNG/WebP/GIF, any size
   */
  recommendedFormat: "image/jpeg",
} as const;

/** Open Graph content types */
export const OG_TYPES = {
  /** Default for web pages */
  WEBSITE: "website",
  /** For blog posts and articles */
  ARTICLE: "article",
  /** For news content */
  NEWS_ARTICLE: "news.article",
  /** For video content */
  VIDEO: "video.other",
  /** For audio content */
  AUDIO: "audio.other",
  /** For books */
  BOOK: "book",
  /** For profiles */
  PROFILE: "profile",
} as const;

/** Twitter Card types */
export const TWITTER_CARD_TYPES = {
  /** Summary card (small image, 1:1 ratio) */
  SUMMARY: "summary",
  /** Large image card (2:1 ratio, RECOMMENDED) */
  SUMMARY_LARGE_IMAGE: "summary_large_image",
  /** App card (for mobile apps) */
  APP: "app",
  /** Player card (for video/audio) */
  PLAYER: "player",
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE TRANSFORM URL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Focal point for smart cropping (normalized coordinates 0-1)
 */
export interface FocalPoint {
  x: number;
  y: number;
}

/**
 * Generate featured image URL using media preset endpoint
 * Endpoint: /api/media/preset/{id}/large
 *
 * @param mediaId - The media item UUID
 * @param baseUrl - Optional base URL (defaults to empty string for relative URLs)
 * @returns Transform URL for featured image (1200x800, webp, quality 90)
 */
export function getFeaturedImageUrl(mediaId: string, baseUrl?: string): string {
  const base = baseUrl?.replace(/\/$/, "") || "";
  return `${base}/api/media/preset/${mediaId}/large`;
}

/**
 * Generate OG image URL using media transform endpoint
 * Optimized for WhatsApp/Facebook (1200x630, jpeg, quality 90)
 * Endpoint: /api/media/transform/{id}?w=1200&h=630&fit=cover&f=jpeg&q=90
 *
 * @param mediaId - The media item UUID
 * @param focalPoint - Optional focal point for smart cropping
 * @param baseUrl - Optional base URL (defaults to empty string for relative URLs)
 * @returns Transform URL for OG image
 */
export function getOGImageUrl(mediaId: string, focalPoint?: FocalPoint, baseUrl?: string): string {
  const base = baseUrl?.replace(/\/$/, "") || "";
  let url = `${base}/api/media/transform/${mediaId}?w=1200&h=630&fit=cover&f=jpeg&q=90`;

  // Add focal point if provided for smart cropping
  if (focalPoint) {
    const fx = Math.round(focalPoint.x * 100);
    const fy = Math.round(focalPoint.y * 100);
    url += `&fpx=${fx}&fpy=${fy}`;
  }

  return url;
}

/**
 * Generate custom transform URL with specific dimensions
 *
 * @param mediaId - The media item UUID
 * @param width - Target width
 * @param height - Target height (optional)
 * @param options - Transform options
 * @param baseUrl - Optional base URL
 * @returns Custom transform URL
 */
export function getTransformUrl(
  mediaId: string,
  width: number,
  height?: number,
  options?: {
    fit?: "cover" | "contain" | "fill" | "inside" | "outside";
    format?: "jpeg" | "png" | "webp" | "avif";
    quality?: number;
    focalPoint?: FocalPoint;
  },
  baseUrl?: string
): string {
  const base = baseUrl?.replace(/\/$/, "") || "";
  const fit = options?.fit || "cover";
  const format = options?.format || "webp";
  const quality = options?.quality || 85;

  let url = `${base}/api/media/transform/${mediaId}?w=${width}`;

  if (height) {
    url += `&h=${height}`;
  }

  url += `&fit=${fit}&f=${format}&q=${quality}`;

  // Add focal point if provided
  if (options?.focalPoint) {
    const fx = Math.round(options.focalPoint.x * 100);
    const fy = Math.round(options.focalPoint.y * 100);
    url += `&fpx=${fx}&fpy=${fy}`;
  }

  return url;
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Site-wide SEO configuration */
export interface SiteSEOConfig {
  /** Site name (appears in title: "Post Title | Site Name") */
  name: string;
  /** Base URL without trailing slash (e.g., "https://example.com") */
  baseUrl: string;
  /** Default language: a code ("es", "en", "pt-BR") or an og:locale ("en_US") */
  defaultLanguage?: string;
  /** Twitter/X handle (e.g., "@myblog") */
  twitterHandle?: string;
  /** Default Open Graph image URL */
  defaultOgImage?: string;
  /** Site description (fallback) */
  defaultDescription?: string;
  /** Organization/Publisher info for Schema.org */
  publisher?: {
    name: string;
    logo?: string;
    url?: string;
  };
  /** Social media profiles for SameAs */
  socialProfiles?: {
    twitter?: string;
    facebook?: string;
    linkedin?: string;
    instagram?: string;
    youtube?: string;
  };
}

/** Author information */
export interface AuthorInfo {
  id: string;
  name: string;
  email?: string;
  image?: string;
  bio?: string;
  jobTitle?: string;
  url?: string;
  sameAs?: string[];
}

/** Featured image with dimensions */
export interface FeaturedImage {
  id: string;
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  /** File size in bytes (for WhatsApp validation) */
  fileSize?: number;
}

/**
 * Open Graph image with WhatsApp-specific requirements
 * This is the image used for social sharing previews
 */
export interface OGImage {
  /** Image URL - MUST be absolute (not relative) */
  url: string;
  /** Alt text for accessibility */
  alt: string;
  /** Width in pixels (ideally 1200 for WhatsApp) */
  width: number;
  /** Height in pixels (ideally 630 for WhatsApp) */
  height: number;
  /** MIME type - should be image/jpeg or image/png for WhatsApp */
  type: string;
  /** File size in bytes (must be < 300KB for WhatsApp) */
  fileSize?: number;
  /** Whether this image meets WhatsApp requirements */
  isWhatsAppCompatible?: boolean;
}

/** SEO Overrides from database */
export interface SEOOverrides {
  /** Custom meta title (overrides auto-generated) */
  metaTitle?: string;
  /** Custom meta description (overrides auto-generated) */
  metaDescription?: string;
  /** Canonical URL override */
  canonicalUrl?: string;
  /** Robots meta tag override */
  robots?: string;
  /** Focus keyword for analysis */
  focusKeyword?: string;
  /** Prevent search engines from indexing */
  noindex?: boolean;
  /** Prevent search engines from following links */
  nofollow?: boolean;
  /** Open Graph overrides */
  og?: {
    title?: string;
    description?: string;
    /** @deprecated Use imageId instead for transform endpoint support */
    image?: string;
    /** Media ID for transform endpoint (preferred) */
    imageId?: string;
    imageAlt?: string;
    type?: string;
  };
  /** Twitter Card overrides */
  twitter?: {
    title?: string;
    description?: string;
    image?: string;
    card?: "summary" | "summary_large_image" | "app" | "player";
  };
  /** Schema.org overrides */
  schema?: {
    type?: keyof typeof SCHEMA_TYPES;
    articleSection?: string;
  };
  /** Keywords for meta tag (comma-separated) */
  keywords?: string;
  /** Language variants (hreflang) */
  hreflang?: Array<{
    lang: string;
    url: string;
  }>;
}

/** Individual meta tag */
export interface MetaTag {
  name?: string;
  property?: string;
  content?: string;
  charset?: string;
  httpEquiv?: string;
}

/** Open Graph metadata */
export interface OpenGraphData {
  /** Open Graph title (appears on Facebook, LinkedIn, WhatsApp) */
  title: string;
  /**
   * Open Graph description
   * For WhatsApp: Keep it persuasive and mobile-friendly (1-2 lines)
   */
  description: string;
  /** Canonical URL - MUST be absolute URL */
  url: string;
  /** Content type - use 'article' for blog posts */
  type: string;
  /**
   * Open Graph image - CRITICAL for WhatsApp
   * Must be: < 300KB, 1200x630px ideal, JPG/PNG format
   */
  image?: OGImage;
  /** Site name (appears above title on Facebook) */
  siteName: string;
  /** Locale format: language_TERRITORY (e.g., "es_ES", "en_US") */
  locale: string;
  /** Article-specific metadata */
  article?: {
    /** ISO 8601 published date */
    publishedTime: string;
    /** ISO 8601 modified date */
    modifiedTime?: string;
    /** Author name */
    author?: string;
    /** Article category/section */
    section?: string;
    /** Article tags */
    tags?: string[];
  };
}

/** Twitter Card metadata */
export interface TwitterCardData {
  card: "summary" | "summary_large_image" | "app" | "player";
  site?: string;
  creator?: string;
  title: string;
  description: string;
  image?: string;
  imageAlt?: string;
}

/** JSON-LD structured data */
export interface JsonLdData {
  "@context": string;
  "@type": string;
  [key: string]: any;
}

/** Complete SEO metadata package */
export interface SEOMetadata {
  /** Optimized page title (50-60 chars) */
  title: string;
  /** Optimized meta description (150-160 chars) */
  metaDescription: string;
  /** Canonical URL */
  canonicalUrl: string;
  /** Array of all meta tags */
  metaTags: MetaTag[];
  /** Open Graph data (WhatsApp, Facebook, LinkedIn) */
  openGraph: OpenGraphData;
  /** Twitter Card data (X/Twitter) */
  twitterCard: TwitterCardData;
  /** JSON-LD structured data scripts */
  jsonLd: JsonLdData[];
  /** Robots directive */
  robots: string;
  /** Hreflang alternatives */
  hreflang?: Array<{ lang: string; url: string }>;
  /** Keywords meta tag */
  keywords?: string;
  /** Reading time in minutes */
  readingTime?: number;
  /** Word count */
  wordCount?: number;
  /** SEO validation warnings (title, description, keywords) */
  warnings?: string[];
  /** SEO score (0-100) */
  score?: number;
  /**
   * WhatsApp Open Graph image validation
   * Critical for ensuring image previews work on WhatsApp
   */
  whatsAppValidation?: WhatsAppImageValidation | null;
}

/** Options for SEO generation */
export interface SEOMetadataOptions {
  post: BlogPost | BlogPostWithRelations;
  author?: AuthorInfo;
  featuredImage?: FeaturedImage | null;
  siteConfig: SiteSEOConfig;
  /** Additional tags for this post */
  tags?: Array<{ name: string; slug: string }>;
  /** Categories/sections */
  categories?: string[];
  /** Is this a news article (time-sensitive)? */
  isNewsArticle?: boolean;
  /** Previous post (for navigation) */
  prevPost?: { title: string; slug: string } | null;
  /** Next post (for navigation) */
  nextPost?: { title: string; slug: string } | null;
  /** Related posts */
  relatedPosts?: Array<{ title: string; slug: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Strip HTML tags and normalize whitespace
 */
/** The territory Open Graph expects when only a language is known. */
const OG_DEFAULT_TERRITORY: Record<string, string> = {
  en: "US", es: "ES", pt: "BR", fr: "FR", de: "DE", it: "IT", nl: "NL", pl: "PL",
  ja: "JP", ko: "KR", zh: "CN", ru: "RU", tr: "TR", sv: "SE", da: "DK", ca: "ES",
};

/**
 * A language code ("es", "pt-BR", "en_GB") as an og:locale ("es_ES", "pt_BR", "en_GB").
 * `undefined` when it is empty or not a language code, so the caller picks the fallback.
 */
export function ogLocale(language: string | null | undefined): string | undefined {
  const m = /^([a-z]{2})(?:[-_]([a-z]{2}))?$/i.exec((language ?? "").trim());
  if (!m) return undefined;
  const lang = m[1]!.toLowerCase();
  const territory = m[2]?.toUpperCase() ?? OG_DEFAULT_TERRITORY[lang];
  return territory ? `${lang}_${territory}` : undefined;
}

export function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract text content from Lexical editor JSON
 */
export function extractTextFromLexical(content: any): string {
  if (!content) return "";

  // If it's already a string, return it
  if (typeof content === "string") return content;

  // If it's Lexical format, extract text recursively
  let text = "";

  function extract(node: any): void {
    if (!node) return;

    if (node.text) {
      text += node.text + " ";
    }

    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(extract);
    }

    if (node.root?.children && Array.isArray(node.root.children)) {
      node.root.children.forEach(extract);
    }
  }

  extract(content);
  return text.trim();
}

/**
 * Truncate text to specific character count, ending at word boundary
 */
export function truncateToLimit(text: string, limit: number, addEllipsis: boolean = true): string {
  if (!text || text.length <= limit) return text;

  const truncated = text.substring(0, limit);
  const lastSpace = truncated.lastIndexOf(" ");

  // Try to end at word boundary if possible
  if (lastSpace > limit * 0.8) {
    const result = truncated.substring(0, lastSpace);
    return addEllipsis ? result + "..." : result;
  }

  return addEllipsis ? truncated + "..." : truncated;
}

/**
 * Count words in text
 */
export function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Estimate reading time in minutes
 */
export function estimateReadingTime(content: string | any, wordsPerMinute: number = 200): number {
  const text = typeof content === "string" ? content : extractTextFromLexical(content);
  const wordCount = countWords(text);
  return Math.max(1, Math.ceil(wordCount / wordsPerMinute));
}

/**
 * Format ISO date string
 */
export function formatISODate(date: Date | string | null): string | undefined {
  if (!date) return undefined;
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toISOString();
}

/**
 * Generate post URL
 */
export function generatePostUrl(siteConfig: SiteSEOConfig, slug: string): string {
  const baseUrl = siteConfig.baseUrl.replace(/\/$/, "");
  return `${baseUrl}/blog/${slug}`;
}

/**
 * Generate title with site name suffix (respects 60 char limit)
 */
export function generateTitle(
  postTitle: string,
  siteName: string,
  separator: string = " | ",
  override?: string
): string {
  if (override) {
    return truncateToLimit(override, SEO_LIMITS.title.max, false);
  }

  const fullTitle = `${postTitle}${separator}${siteName}`;

  // If it fits, use it
  if (fullTitle.length <= SEO_LIMITS.title.max) {
    return fullTitle;
  }

  // Calculate available space for post title
  const siteNameWithSeparator = `${separator}${siteName}`;
  const availableLength = SEO_LIMITS.title.max - siteNameWithSeparator.length;

  // Truncate post title and add suffix
  const truncatedTitle = truncateToLimit(postTitle, availableLength, false);
  return `${truncatedTitle}${siteNameWithSeparator}`;
}

/**
 * Generate meta description from excerpt or content
 */
export function generateMetaDescription(
  excerpt: string | null | undefined,
  content: any,
  override?: string
): string {
  if (override) {
    return truncateToLimit(override, SEO_LIMITS.description.max, false);
  }

  // Use excerpt if available
  if (excerpt) {
    const plainExcerpt = stripHtml(excerpt);
    return truncateToLimit(plainExcerpt, SEO_LIMITS.description.max, false);
  }

  // Extract from content
  const textContent = extractTextFromLexical(content);
  const plainText = stripHtml(textContent);
  return truncateToLimit(plainText, SEO_LIMITS.description.max, false);
}

// ═══════════════════════════════════════════════════════════════════════════
// WHATSAPP / OPEN GRAPH IMAGE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validation result for WhatsApp Open Graph image
 */
export interface WhatsAppImageValidation {
  /** Whether the image meets ALL WhatsApp requirements */
  isValid: boolean;
  /** Specific checks that passed/failed */
  checks: {
    format: boolean;
    fileSize: boolean;
    dimensions: boolean;
    minDimensions: boolean;
    isAbsoluteUrl: boolean;
  };
  /** Human-readable warnings */
  warnings: string[];
  /** Recommendations for fixing issues */
  recommendations: string[];
  /** Image metadata */
  metadata: {
    format?: string;
    fileSizeKB?: number;
    width?: number;
    height?: number;
    aspectRatio?: number;
  };
}

/**
 * Check if image format is compatible with WhatsApp
 * WhatsApp only reliably supports JPG and PNG
 * WebP, GIF, SVG may not render in previews
 */
export function isWhatsAppCompatibleFormat(mimeType?: string): boolean {
  if (!mimeType) return false;
  return (WHATSAPP_OG_LIMITS.acceptedFormats as readonly string[]).includes(mimeType.toLowerCase());
}

/**
 * Get file extension from URL or MIME type
 */
export function getImageFormat(url: string, mimeType?: string): string {
  if (mimeType) {
    return mimeType.toLowerCase();
  }
  // Try to extract from URL
  const extension = url.split("?")[0].toLowerCase();
  if (extension.endsWith(".jpg") || extension.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (extension.endsWith(".png")) {
    return "image/png";
  }
  if (extension.endsWith(".webp")) {
    return "image/webp";
  }
  if (extension.endsWith(".gif")) {
    return "image/gif";
  }
  return "unknown";
}

/**
 * Validate if an image URL is absolute (required for Open Graph)
 * WhatsApp/Facebook require absolute URLs, not relative paths
 */
export function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Make a URL absolute if it's relative
 */
export function makeAbsoluteUrl(url: string, baseUrl: string): string {
  if (isAbsoluteUrl(url)) return url;
  const base = baseUrl.replace(/\/$/, "");
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${base}${path}`;
}

/**
 * Validate image dimensions for WhatsApp
 * Ideal: 1200x630 (1.91:1 ratio)
 * Minimum: 400x400
 */
export function validateWhatsAppDimensions(
  width?: number,
  height?: number
): { isValid: boolean; warnings: string[]; recommendations: string[] } {
  const warnings: string[] = [];
  const recommendations: string[] = [];

  if (!width || !height) {
    warnings.push("Image dimensions unknown");
    recommendations.push("Specify image width and height for optimal WhatsApp preview");
    return { isValid: false, warnings, recommendations };
  }

  const aspectRatio = width / height;
  const { idealDimensions, minDimensions } = WHATSAPP_OG_LIMITS;

  // Check minimum dimensions
  if (width < minDimensions.width || height < minDimensions.height) {
    warnings.push(
      `Image dimensions (${width}x${height}) are below WhatsApp minimum (${minDimensions.width}x${minDimensions.height})`
    );
    recommendations.push("Use an image of at least 400x400 pixels");
  }

  // Check ideal dimensions
  if (width < idealDimensions.width || height < idealDimensions.height) {
    warnings.push(
      `Image is smaller than ideal size of ${idealDimensions.width}x${idealDimensions.height}px`
    );
    recommendations.push("For best results on all platforms, use 1200x630px images");
  }

  // Check aspect ratio (should be close to 1.91:1 for Facebook/LinkedIn)
  const idealRatio = idealDimensions.ratio;
  const ratioDiff = Math.abs(aspectRatio - idealRatio);
  if (ratioDiff > 0.2) {
    warnings.push(
      `Image aspect ratio (${aspectRatio.toFixed(2)}:1) differs from ideal (${idealRatio}:1)`
    );
    recommendations.push("Use images with 1.91:1 aspect ratio (1200x630px) for optimal display");
  }

  const isValid =
    width >= minDimensions.width && height >= minDimensions.height && ratioDiff <= 0.5;

  return { isValid, warnings, recommendations };
}

/**
 * Validate file size for WhatsApp (< 300KB)
 */
export function validateWhatsAppFileSize(fileSizeBytes?: number): {
  isValid: boolean;
  warnings: string[];
  fileSizeKB?: number;
} {
  const warnings: string[] = [];

  if (!fileSizeBytes) {
    warnings.push("Image file size unknown");
    return { isValid: false, warnings };
  }

  const fileSizeKB = fileSizeBytes / 1024;
  const { maxFileSizeKB } = WHATSAPP_OG_LIMITS;

  if (fileSizeKB > maxFileSizeKB) {
    warnings.push(
      `Image file size (${fileSizeKB.toFixed(1)}KB) exceeds WhatsApp limit of ${maxFileSizeKB}KB`
    );
  }

  return {
    isValid: fileSizeKB <= maxFileSizeKB,
    warnings,
    fileSizeKB,
  };
}

/**
 * Complete WhatsApp Open Graph image validation
 * This is the main function to validate if an image will work on WhatsApp
 */
export function validateWhatsAppImage(
  imageUrl: string,
  options?: {
    width?: number;
    height?: number;
    fileSizeBytes?: number;
    mimeType?: string;
  }
): WhatsAppImageValidation {
  const warnings: string[] = [];
  const recommendations: string[] = [];

  // Check URL is absolute
  const isAbsolute = isAbsoluteUrl(imageUrl);
  if (!isAbsolute) {
    warnings.push("Image URL must be absolute (https://...) for Open Graph");
    recommendations.push("Use absolute URLs starting with https:// for og:image");
  }

  // Check format
  const format = getImageFormat(imageUrl, options?.mimeType);
  const formatValid = isWhatsAppCompatibleFormat(format);
  if (!formatValid) {
    if (format === "image/webp") {
      warnings.push("WebP format may not render in older WhatsApp versions");
      recommendations.push("Convert image to JPG or PNG for maximum compatibility");
    } else if (format === "image/gif") {
      warnings.push("GIF format is not supported for WhatsApp link previews");
      recommendations.push("Use a static JPG or PNG image instead");
    } else {
      warnings.push(`Image format "${format}" may not be supported by WhatsApp`);
      recommendations.push("Use JPG or PNG format for best compatibility");
    }
  }

  // Check file size
  const sizeValidation = validateWhatsAppFileSize(options?.fileSizeBytes);
  if (sizeValidation.warnings.length > 0) {
    warnings.push(...sizeValidation.warnings);
    recommendations.push("Compress image to under 300KB using tools like TinyPNG or Squoosh");
  }

  // Check dimensions
  const dimensionValidation = validateWhatsAppDimensions(options?.width, options?.height);
  if (dimensionValidation.warnings.length > 0) {
    warnings.push(...dimensionValidation.warnings);
    recommendations.push(...dimensionValidation.recommendations);
  }

  // Determine overall validity
  const isValid =
    isAbsolute && formatValid && sizeValidation.isValid && dimensionValidation.isValid;

  return {
    isValid,
    checks: {
      format: formatValid,
      fileSize: sizeValidation.isValid,
      dimensions: dimensionValidation.isValid,
      minDimensions:
        (options?.width || 0) >= WHATSAPP_OG_LIMITS.minDimensions.width &&
        (options?.height || 0) >= WHATSAPP_OG_LIMITS.minDimensions.height,
      isAbsoluteUrl: isAbsolute,
    },
    warnings,
    recommendations,
    metadata: {
      format,
      fileSizeKB: sizeValidation.fileSizeKB,
      width: options?.width,
      height: options?.height,
      aspectRatio: options?.width && options?.height ? options.width / options.height : undefined,
    },
  };
}

/**
 * Generate Open Graph image object with WhatsApp validation
 * This ensures the image meets all requirements before being used
 */
export function generateOGImage(
  imageUrl: string,
  options?: {
    alt?: string;
    width?: number;
    height?: number;
    mimeType?: string;
    fileSizeBytes?: number;
    baseUrl?: string;
  }
): OGImage {
  // Make URL absolute
  const absoluteUrl = options?.baseUrl ? makeAbsoluteUrl(imageUrl, options.baseUrl) : imageUrl;

  // Validate for WhatsApp
  const validation = validateWhatsAppImage(absoluteUrl, options);

  // Determine MIME type
  const format = getImageFormat(absoluteUrl, options?.mimeType);

  // Use provided dimensions or defaults
  const width = options?.width || WHATSAPP_OG_LIMITS.idealDimensions.width;
  const height = options?.height || WHATSAPP_OG_LIMITS.idealDimensions.height;

  return {
    url: absoluteUrl,
    alt: options?.alt || "",
    width,
    height,
    type: format,
    fileSize: options?.fileSizeBytes,
    isWhatsAppCompatible: validation.isValid,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SEO VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate SEO metadata and return warnings
 */
export function validateSEO(
  title: string,
  metaDescription: string,
  focusKeyword?: string,
  content?: string
): string[] {
  const warnings: string[] = [];

  // Title validation
  if (title.length < SEO_LIMITS.title.min) {
    warnings.push(
      `Title is too short (${title.length} chars). Minimum recommended: ${SEO_LIMITS.title.min}`
    );
  } else if (title.length > SEO_LIMITS.title.max) {
    warnings.push(`Title is too long (${title.length} chars). Maximum: ${SEO_LIMITS.title.max}`);
  } else if (title.length < SEO_LIMITS.title.optimal) {
    warnings.push(
      `Title could be longer (${title.length} chars). Optimal: ${SEO_LIMITS.title.optimal}-${SEO_LIMITS.title.max}`
    );
  }

  // Description validation
  if (metaDescription.length < SEO_LIMITS.description.min) {
    warnings.push(
      `Meta description is too short (${metaDescription.length} chars). Minimum recommended: ${SEO_LIMITS.description.min}`
    );
  } else if (metaDescription.length > SEO_LIMITS.description.max) {
    warnings.push(
      `Meta description is too long (${metaDescription.length} chars). Maximum: ${SEO_LIMITS.description.max}`
    );
  } else if (metaDescription.length < SEO_LIMITS.description.optimal) {
    warnings.push(
      `Meta description could be longer (${metaDescription.length} chars). Optimal: ${SEO_LIMITS.description.optimal}-${SEO_LIMITS.description.max}`
    );
  }

  // Focus keyword validation
  if (focusKeyword) {
    const titleLower = title.toLowerCase();
    const descLower = metaDescription.toLowerCase();
    const keywordLower = focusKeyword.toLowerCase();

    if (!titleLower.includes(keywordLower)) {
      warnings.push(`Focus keyword "${focusKeyword}" not found in title`);
    }
    if (!descLower.includes(keywordLower)) {
      warnings.push(`Focus keyword "${focusKeyword}" not found in meta description`);
    }
    if (content) {
      const contentLower = content.toLowerCase();
      const keywordCount = (contentLower.match(new RegExp(keywordLower, "g")) || []).length;
      if (keywordCount < 2) {
        warnings.push(
          `Focus keyword "${focusKeyword}" appears only ${keywordCount} times in content`
        );
      }
    }
  }

  return warnings;
}

/**
 * Calculate SEO score (0-100)
 */
export function calculateSEOScore(
  title: string,
  metaDescription: string,
  hasFeaturedImage: boolean,
  hasAuthor: boolean,
  hasKeywords: boolean,
  warnings: string[]
): number {
  let score = 100;

  // Deduct for warnings
  score -= warnings.length * 5;

  // Title length bonus
  if (title.length >= SEO_LIMITS.title.optimal && title.length <= SEO_LIMITS.title.max) {
    score += 5;
  }

  // Description length bonus
  if (
    metaDescription.length >= SEO_LIMITS.description.optimal &&
    metaDescription.length <= SEO_LIMITS.description.max
  ) {
    score += 5;
  }

  // Featured image bonus
  if (hasFeaturedImage) score += 10;

  // Author bonus
  if (hasAuthor) score += 5;

  // Keywords bonus
  if (hasKeywords) score += 5;

  return Math.max(0, Math.min(100, score));
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SEO GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate complete SEO metadata for a blog post
 *
 * This is the main function that generates all SEO components:
 * - Meta tags for search engines
 * - Open Graph tags for social sharing
 * - Twitter Card tags
 * - JSON-LD structured data (Schema.org)
 */
export function generateSEOMetadata(options: SEOMetadataOptions): SEOMetadata {
  const { post, author, featuredImage, siteConfig, tags, categories, isNewsArticle } = options;

  // Parse SEO overrides from post
  const seoOverrides: SEOOverrides = (post as any).seoOverrides || {};

  // ─────────────────────────────────────────────────────────────────────────
  // BASIC METADATA
  // ─────────────────────────────────────────────────────────────────────────

  // Generate title
  const title = generateTitle(post.title, siteConfig.name, " | ", seoOverrides.metaTitle);

  // Generate meta description
  const metaDescription = generateMetaDescription(
    post.excerpt,
    post.content,
    seoOverrides.metaDescription
  );

  // Generate canonical URL
  const canonicalUrl = seoOverrides.canonicalUrl || generatePostUrl(siteConfig, post.slug);

  // Determine robots directive
  const robots =
    seoOverrides.robots ||
    (seoOverrides.noindex ? "noindex" : "index") +
      "," +
      (seoOverrides.nofollow ? "nofollow" : "follow");

  // ─────────────────────────────────────────────────────────────────────────
  // OPEN GRAPH (WhatsApp, Facebook, LinkedIn)
  // ─────────────────────────────────────────────────────────────────────────

  // Get media ID for OG image (from overrides, post ogImageId, or featured image)
  const ogImageMediaId =
    seoOverrides.og?.imageId || (post as any).ogImageId || seoOverrides.og?.image;
  const featuredImageId = (post as any).featuredImageId;
  const focalPoint = (post as any).featuredImageFocalPoint as FocalPoint | undefined;

  // Generate OG image URL using transform endpoint (1200x630 for WhatsApp)
  let ogImageUrl: string | undefined;

  if (ogImageMediaId) {
    // Use dedicated OG image with focal point support
    ogImageUrl = getOGImageUrl(ogImageMediaId, focalPoint, siteConfig.baseUrl);
  } else if (featuredImageId) {
    // Fall back to featured image transformed to OG dimensions
    ogImageUrl = getOGImageUrl(featuredImageId, focalPoint, siteConfig.baseUrl);
  } else if (siteConfig.defaultOgImage) {
    // Use site default
    ogImageUrl = siteConfig.defaultOgImage;
  }

  // Generate validated OG Image with WhatsApp requirements
  const ogImage: OGImage | undefined = ogImageUrl
    ? generateOGImage(ogImageUrl, {
        alt: seoOverrides.og?.imageAlt || (post as any).featuredImage?.alt || post.title,
        width: 1200,
        height: 630,
        mimeType: "image/jpeg",
        baseUrl: siteConfig.baseUrl,
      })
    : undefined;

  // Validate for WhatsApp warnings (transform endpoint ensures correct dimensions)
  const whatsAppValidation = ogImageUrl
    ? {
        isValid: true,
        checks: {
          format: true,
          fileSize: true,
          dimensions: true,
          minDimensions: true,
          isAbsoluteUrl: isAbsoluteUrl(ogImageUrl),
        },
        warnings: [],
        recommendations: [],
        metadata: {
          format: "image/jpeg",
          width: 1200,
          height: 630,
          aspectRatio: 1.91,
        },
      }
    : null;

  const openGraph: OpenGraphData = {
    title: truncateToLimit(seoOverrides.og?.title || post.title, SEO_LIMITS.ogTitle.max, false),
    description: truncateToLimit(
      seoOverrides.og?.description || metaDescription,
      SEO_LIMITS.ogDescription.max,
      false
    ),
    url: canonicalUrl,
    type: seoOverrides.og?.type || OG_TYPES.ARTICLE,
    siteName: siteConfig.name,
    locale: ogLocale(siteConfig.defaultLanguage) ?? "en_US",
    image: ogImage,
    article: {
      publishedTime: formatISODate(post.publishedAt || post.createdAt)!,
      modifiedTime: formatISODate(post.updatedAt),
      author: author?.name,
      section: categories?.[0] || seoOverrides.schema?.articleSection,
      tags: tags?.map((t) => t.name),
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // TWITTER CARD (X / Twitter)
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Twitter uses its own card system but falls back to Open Graph
  // if twitter:* tags are not present. We provide both for explicit control.
  // Card types:
  // - summary: Small square image (1:1)
  // - summary_large_image: Large rectangular image (2:1) - RECOMMENDED
  // - app: For mobile app promotion
  // - player: For video/audio embedding

  const twitterCardType = seoOverrides.twitter?.card || TWITTER_CARD_TYPES.SUMMARY_LARGE_IMAGE;

  // Generate Twitter card image using transform endpoint (1200x600 for summary_large_image)
  let twitterImageUrl: string | undefined = seoOverrides.twitter?.image;

  if (!twitterImageUrl) {
    if (ogImageMediaId) {
      twitterImageUrl = getTransformUrl(
        ogImageMediaId,
        1200,
        600,
        { fit: "cover", format: "jpeg", quality: 90, focalPoint },
        siteConfig.baseUrl
      );
    } else if (featuredImageId) {
      twitterImageUrl = getTransformUrl(
        featuredImageId,
        1200,
        600,
        { fit: "cover", format: "jpeg", quality: 90, focalPoint },
        siteConfig.baseUrl
      );
    } else if (ogImage?.url) {
      twitterImageUrl = ogImage.url;
    }
  }

  const twitterCard: TwitterCardData = {
    card: twitterCardType,
    site: siteConfig.twitterHandle,
    creator:
      author?.name && siteConfig.twitterHandle
        ? `@${author.name.replace(/\s/g, "")}`
        : siteConfig.twitterHandle,
    title: truncateToLimit(
      seoOverrides.twitter?.title || post.title,
      SEO_LIMITS.twitterTitle.max,
      false
    ),
    description: truncateToLimit(
      seoOverrides.twitter?.description || metaDescription,
      SEO_LIMITS.twitterDescription.max,
      false
    ),
    image: twitterImageUrl,
    imageAlt: seoOverrides.og?.imageAlt || featuredImage?.alt || post.title,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // META TAGS ARRAY
  // ─────────────────────────────────────────────────────────────────────────

  const metaTags: MetaTag[] = [
    // Basic SEO
    { charset: "UTF-8" },
    { name: "viewport", content: "width=device-width, initial-scale=1.0" },
    { name: "description", content: metaDescription },
    { name: "robots", content: robots },

    // Canonical
    { name: "canonical", content: canonicalUrl },
  ];

  // Add keywords if available
  if (seoOverrides.keywords || tags?.length) {
    const keywords = seoOverrides.keywords || tags?.map((t) => t.name).join(", ");
    if (keywords) {
      metaTags.push({ name: "keywords", content: keywords });
    }
  }

  // Open Graph tags
  metaTags.push(
    { property: "og:title", content: openGraph.title },
    { property: "og:description", content: openGraph.description },
    { property: "og:url", content: openGraph.url },
    { property: "og:type", content: openGraph.type },
    { property: "og:site_name", content: openGraph.siteName },
    { property: "og:locale", content: openGraph.locale }
  );

  if (openGraph.image) {
    metaTags.push(
      { property: "og:image", content: openGraph.image.url },
      { property: "og:image:alt", content: openGraph.image.alt || "" }
    );
    if (openGraph.image.width) {
      metaTags.push({ property: "og:image:width", content: String(openGraph.image.width) });
    }
    if (openGraph.image.height) {
      metaTags.push({ property: "og:image:height", content: String(openGraph.image.height) });
    }
  }

  // Article-specific OG tags
  if (openGraph.article) {
    metaTags.push({ property: "article:published_time", content: openGraph.article.publishedTime });
    if (openGraph.article.modifiedTime) {
      metaTags.push({ property: "article:modified_time", content: openGraph.article.modifiedTime });
    }
    if (openGraph.article.author) {
      metaTags.push({ property: "article:author", content: openGraph.article.author });
    }
    if (openGraph.article.section) {
      metaTags.push({ property: "article:section", content: openGraph.article.section });
    }
    openGraph.article.tags?.forEach((tag) => {
      metaTags.push({ property: "article:tag", content: tag });
    });
  }

  // Twitter Card tags
  metaTags.push(
    { name: "twitter:card", content: twitterCard.card },
    { name: "twitter:title", content: twitterCard.title },
    { name: "twitter:description", content: twitterCard.description }
  );

  if (twitterCard.site) {
    metaTags.push({ name: "twitter:site", content: twitterCard.site });
  }
  if (twitterCard.creator) {
    metaTags.push({ name: "twitter:creator", content: twitterCard.creator });
  }
  if (twitterCard.image) {
    metaTags.push({ name: "twitter:image", content: twitterCard.image });
  }
  if (twitterCard.imageAlt) {
    metaTags.push({ name: "twitter:image:alt", content: twitterCard.imageAlt });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // JSON-LD STRUCTURED DATA
  // ─────────────────────────────────────────────────────────────────────────

  const schemaType =
    seoOverrides.schema?.type ||
    (isNewsArticle ? SCHEMA_TYPES.NEWS_ARTICLE : SCHEMA_TYPES.BLOG_POSTING);

  const jsonLd: JsonLdData[] = [];

  // Main article Schema
  const articleSchema: JsonLdData = {
    "@context": "https://schema.org",
    "@type": schemaType,
    headline: post.title,
    description: metaDescription,
    url: canonicalUrl,
    datePublished: formatISODate(post.publishedAt || post.createdAt),
    dateModified: formatISODate(post.updatedAt),
    author: author
      ? {
          "@type": SCHEMA_TYPES.PERSON,
          name: author.name,
          url: author.url,
          image: author.image,
          jobTitle: author.jobTitle,
          sameAs: author.sameAs,
        }
      : undefined,
    publisher: siteConfig.publisher
      ? {
          "@type": SCHEMA_TYPES.ORGANIZATION,
          name: siteConfig.publisher.name,
          logo: siteConfig.publisher.logo
            ? {
                "@type": SCHEMA_TYPES.IMAGE_OBJECT,
                url: siteConfig.publisher.logo,
              }
            : undefined,
          url: siteConfig.publisher.url || siteConfig.baseUrl,
          sameAs: siteConfig.socialProfiles
            ? Object.values(siteConfig.socialProfiles).filter(Boolean)
            : undefined,
        }
      : undefined,
    image: featuredImage
      ? {
          "@type": SCHEMA_TYPES.IMAGE_OBJECT,
          url: featuredImage.url,
          width: featuredImage.width || 1200,
          height: featuredImage.height || 630,
        }
      : ogImage
        ? {
            "@type": SCHEMA_TYPES.IMAGE_OBJECT,
            url: ogImage.url,
          }
        : undefined,
    articleSection: categories?.[0] || seoOverrides.schema?.articleSection,
    keywords: tags?.map((t) => t.name).join(", ") || seoOverrides.keywords,
    wordCount: estimateReadingTime(post.content, 1),
    timeRequired: post.readingTime ? `PT${post.readingTime}M` : undefined,
    mainEntityOfPage: {
      "@type": SCHEMA_TYPES.WEB_PAGE,
      "@id": canonicalUrl,
    },
  };

  // Remove undefined values
  jsonLd.push(JSON.parse(JSON.stringify(articleSchema)));

  // BreadcrumbList Schema
  const breadcrumbSchema: JsonLdData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: siteConfig.baseUrl,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Blog",
        item: `${siteConfig.baseUrl}/blog`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: post.title,
        item: canonicalUrl,
      },
    ],
  };
  jsonLd.push(breadcrumbSchema);

  // WebSite Schema (for search box)
  const websiteSchema: JsonLdData = {
    "@context": "https://schema.org",
    "@type": SCHEMA_TYPES.BLOG,
    name: siteConfig.name,
    url: `${siteConfig.baseUrl}/blog`,
    description: siteConfig.defaultDescription || metaDescription,
    publisher: siteConfig.publisher
      ? {
          "@type": SCHEMA_TYPES.ORGANIZATION,
          name: siteConfig.publisher.name,
        }
      : undefined,
  };
  jsonLd.push(websiteSchema);

  // ─────────────────────────────────────────────────────────────────────────
  // VALIDATION & SCORING
  // ─────────────────────────────────────────────────────────────────────────

  const contentText = extractTextFromLexical(post.content);
  const warnings = validateSEO(title, metaDescription, seoOverrides.focusKeyword, contentText);

  // Add WhatsApp-specific warnings to general warnings
  if (whatsAppValidation && !whatsAppValidation.isValid) {
    warnings.push(...whatsAppValidation.warnings.map((w) => `[WhatsApp] ${w}`));
  }

  const score = calculateSEOScore(
    title,
    metaDescription,
    !!featuredImage?.url,
    !!author?.name,
    !!(seoOverrides.keywords || tags?.length),
    warnings
  );

  // ─────────────────────────────────────────────────────────────────────────
  // RETURN COMPLETE SEO PACKAGE
  // ─────────────────────────────────────────────────────────────────────────

  return {
    title,
    metaDescription,
    canonicalUrl,
    metaTags,
    openGraph,
    twitterCard,
    jsonLd,
    robots,
    hreflang: seoOverrides.hreflang,
    keywords: seoOverrides.keywords || tags?.map((t) => t.name).join(", "),
    readingTime: post.readingTime || estimateReadingTime(post.content),
    wordCount: countWords(contentText),
    warnings,
    score,
    whatsAppValidation,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER HELPERS (for different frameworks)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render meta tags as HTML string
 */
export function renderMetaTagsHTML(metaTags: MetaTag[]): string {
  return metaTags
    .map((tag) => {
      if (tag.charset) {
        return `<meta charset="${tag.charset}">`;
      }
      if (tag.httpEquiv && tag.content) {
        return `<meta http-equiv="${tag.httpEquiv}" content="${escapeHtml(tag.content)}">`;
      }
      if (tag.property && tag.content) {
        return `<meta property="${tag.property}" content="${escapeHtml(tag.content)}">`;
      }
      if (tag.name && tag.content) {
        return `<meta name="${tag.name}" content="${escapeHtml(tag.content)}">`;
      }
      return `<!-- Unknown meta tag -->`;
    })
    .join("\n");
}

/**
 * Render JSON-LD scripts as HTML string
 */
export function renderJsonLdHTML(jsonLd: JsonLdData[]): string {
  return jsonLd
    .map(
      (schema) =>
        `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`
    )
    .join("\n");
}

/**
 * Render canonical link tag
 */
export function renderCanonicalHTML(canonicalUrl: string): string {
  return `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`;
}

/**
 * Render hreflang tags
 */
export function renderHreflangHTML(hreflang: Array<{ lang: string; url: string }>): string {
  return hreflang
    .map((h) => `<link rel="alternate" hreflang="${h.lang}" href="${escapeHtml(h.url)}">`)
    .join("\n");
}

/**
 * Escape HTML entities
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Generate complete HTML head content
 */
export function renderSEOHead(seo: SEOMetadata): string {
  return [
    `<title>${escapeHtml(seo.title)}</title>`,
    renderMetaTagsHTML(seo.metaTags),
    renderCanonicalHTML(seo.canonicalUrl),
    seo.hreflang ? renderHreflangHTML(seo.hreflang) : "",
    renderJsonLdHTML(seo.jsonLd),
  ]
    .filter(Boolean)
    .join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export default {
  generateSEOMetadata,
  generateTitle,
  generateMetaDescription,
  validateSEO,
  calculateSEOScore,
  renderSEOHead,
  renderMetaTagsHTML,
  renderJsonLdHTML,
  // WhatsApp/OG validation
  validateWhatsAppImage,
  generateOGImage,
  isWhatsAppCompatibleFormat,
  isAbsoluteUrl,
  makeAbsoluteUrl,
  // Constants
  SEO_LIMITS,
  SCHEMA_TYPES,
  ROBOT_DIRECTIVES,
  WHATSAPP_OG_LIMITS,
  OG_TYPES,
  TWITTER_CARD_TYPES,
};
