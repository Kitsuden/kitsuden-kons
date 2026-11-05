/**
 * @kitsuden/kon-blog — Blog & Content Publishing (Core Kon)
 *
 * Complete publishing platform with:
 * - Rich text editor and content blocks
 * - SEO metadata and slug management
 * - Editorial workflow (draft → scheduled → published → archived)
 * - Featured images and authorship
 * - Content scheduling
 * - Public content API by slug
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE:
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is a Core Kon that receives all dependencies via injected context.
 * It does NOT import from apps/api/src.
 *
 *   ┌─────────────────────────────────────────┐
 *   │  Kon Loader (apps/api/src)         │
 *   │  ├─ Creates KonContext             │
 *   │  ├─ Calls createRouter(ctx)             │
 *   │  └─ Mounts at /api/blog                 │
 *   └─────────────────────────────────────────┘
 *                   │
 *                   ▼ injects
 *   ┌─────────────────────────────────────────┐
 *   │  kon-blog (this package)           │
 *   │  ├─ Routes (routes.ts)                  │
 *   │  ├─ Schema (schema.ts)                  │
 *   │  └─ Uses ctx.db, ctx.cache, etc.        │
 *   └─────────────────────────────────────────┘
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonDefinition, KonContext } from "@kitsuden/shared";

// KonHooks removed from @kitsuden/shared — inline the type
type KonHooks = Record<string, (...args: any[]) => void | Promise<void>>;

import { sql } from "drizzle-orm";

import { createBlogRouter, blogOperations } from "./routes";

// Re-export schema
export {
  blogPosts,
  blogPostsToTags,
  blogPostsToGames,
  blogPostsRelations,
  blogPostsToTagsRelations,
  blogPostsToGamesRelations,
} from "./schema";

// Tables array for kon definition
const tables = ["blog_posts", "blog_posts_to_tags", "blog_posts_to_games"];

export type {
  BlogPost,
  NewBlogPost,
  BlogPostWithRelations,
  BlogPostStatus,
  FocalPoint,
} from "./schema";

// Re-export FocalPoint type from seo-utils for convenience
export type { FocalPoint as ImageFocalPoint } from "./seo-utils";

// Export router
export { createBlogRouter } from "./routes";

// Export SEO utilities
export {
  generateSEOMetadata,
  validateSEO,
  calculateSEOScore,
  generateTitle,
  generateMetaDescription,
  renderSEOHead,
  renderMetaTagsHTML,
  renderJsonLdHTML,
  // WhatsApp/OG validation
  validateWhatsAppImage,
  generateOGImage,
  isWhatsAppCompatibleFormat,
  isAbsoluteUrl,
  makeAbsoluteUrl,
  validateWhatsAppFileSize,
  validateWhatsAppDimensions,
  getImageFormat,
  // Image transform URL helpers (NEW)
  getFeaturedImageUrl,
  getOGImageUrl,
  getTransformUrl,
  // Utilities
  stripHtml,
  extractTextFromLexical,
  estimateReadingTime,
  countWords,
  truncateToLimit,
  formatISODate,
  // Constants
  SEO_LIMITS,
  SCHEMA_TYPES,
  ROBOT_DIRECTIVES,
  WHATSAPP_OG_LIMITS,
  OG_TYPES,
  TWITTER_CARD_TYPES,
} from "./seo-utils";

// Export GEO utilities
export {
  generateFAQPageSchema,
  generateArticleSchema,
  validateBLUF,
  suggestBLUF,
  sanitizeHTML,
  stripHtmlTags,
  sanitizeFAQText,
  extractTOC,
  buildAPIPayload,
  ALLOWED_HTML_TAGS,
  ALLOWED_ATTRIBUTES,
} from "./geo-utils";

export type {
  SiteSEOConfig,
  AuthorInfo,
  FeaturedImage,
  OGImage,
  SEOOverrides,
  MetaTag,
  OpenGraphData,
  TwitterCardData,
  JsonLdData,
  SEOMetadata,
  SEOMetadataOptions,
  WhatsAppImageValidation,
} from "./seo-utils";

export type {
  FAQItem,
  FAQPageSchema,
  ArticleSchema,
  TOCItem,
  ValidationResult,
  BlogPostAPIPayload,
  BlogPostSEOOverrides,
  BlogPostSource,
} from "./schema.local";
import manifest from "../kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

type AdminDeclaration = NonNullable<KonDefinition["admin"]>;

// ═══════════════════════════════════════════════════════════════════════════
// HOOKS
// ═══════════════════════════════════════════════════════════════════════════

const hooks: KonHooks = {
  /**
   * onStartup: Verify tables exist
   */
  onStartup: async (ctx: KonContext) => {
    ctx.logger.info("[Blog] Verifying database tables...");

    try {
      // Check if blog_posts table exists
      const result = await ctx.db.instance.execute(sql`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = 'blog_posts'
        );
      `);

      const exists = result.rows?.[0]?.exists ?? false;

      if (!exists) {
        ctx.logger.warn("[Blog] Tables not found. Run migrations:");
        ctx.logger.warn("  cd apps/api && bun run db:migrate");
      } else {
        ctx.logger.info("[Blog] ✓ Tables verified");
      }
    } catch (err) {
      ctx.logger.error("[Blog] Failed to verify tables", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * onShutdown: Cleanup
   */
  onShutdown: async (ctx: KonContext) => {
    ctx.logger.info("[Blog] Shutting down...");
  },

  /**
   * onEnable: Setup when enabled
   */
  onEnable: async (ctx: KonContext) => {
    ctx.logger.info("[Blog] Enabled");
  },

  /**
   * onDisable: Cleanup when disabled
   */
  onDisable: async (ctx: KonContext) => {
    ctx.logger.info("[Blog] Disabled - routes will be removed");
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// KON DEFINITION
// ═══════════════════════════════════════════════════════════════════════════

// Kon SDK (the pilot kon): the router, the OpenAPI and the MCP tools
// come from the operations declared in routes.ts.
export const kon: KonDefinition = defineKonSdk({
  // Identity
  id: "kon-blog",
  name: "Blog Posts",
  version: manifest.version,
  description: "Publishing platform with rich text editor, scheduling, tags, and SEO overrides.",

  // Icon
  icon: "FileText",

  // Type
  mountPath: "/api/blog",

  // Router factory
  operations: (ctx: KonContext) => blogOperations(ctx),

  // Admin configuration: kon.json `admin` is the one source (the admin registry
  // reads it); this mirrors it so the definition and the manifest never differ.
  admin: {
    category: manifest.admin.category as AdminDeclaration["category"],
    views: manifest.admin.views.map((v) => ({ ...v })) as AdminDeclaration["views"],
  },

  // Tables
  tables: konTables,

  // Dependencies
  dependencies: {
    kons: ["kon-media"], // Needs media for featured images
    core: ["auth"],
  },

  // Hooks
  hooks,
});

// Default export
export default kon;

// Legacy exports for compatibility
export const blogRoutes = createBlogRouter;
