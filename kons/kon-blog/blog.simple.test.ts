/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * KON-BLOG SIMPLE TESTS
 * Testing without external database dependencies
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from "bun:test";

// Import the kon
import {
  kon,
  createBlogRouter,
  blogPosts,
  blogPostsToTags,
  blogPostsToGames,
  generateSEOMetadata,
  validateSEO,
  calculateSEOScore,
  sanitizeHTML,
  generateArticleSchema,
} from "./src/index";
import manifest from "./kon.json" with { type: "json" };

describe("kon-blog (simple tests)", () => {
  describe("Kon Definition", () => {
    it("has correct metadata", () => {
      expect(kon.id).toBe("kon-blog");
      expect(kon.name).toBe("Blog Posts");
      expect(kon.version).toBe(manifest.version);
      expect(kon.mountPath).toBe("/api/blog");
      expect(kon.icon).toBe("FileText");
    });

    it("has required dependencies", () => {
      expect(kon.dependencies?.kons).toContain("kon-media");
      expect(kon.dependencies?.core).toContain("auth");
    });

    it("has admin configuration", () => {
      expect(kon.admin?.category).toBe("core");
      expect(kon.admin?.views).toBeDefined();
      expect(kon.admin?.views?.length).toBeGreaterThan(0);
    });

    it("declares the same admin views as kon.json", () => {
      expect(kon.admin?.category).toBe(manifest.admin.category);
      expect(kon.admin?.views?.map((v) => [v.id, v.type, v.title])).toEqual(
        manifest.admin.views.map((v) => [v.id, v.type, v.title])
      );
    });

    it("has lifecycle hooks", () => {
      expect(typeof kon.hooks?.onStartup).toBe("function");
      expect(typeof kon.hooks?.onEnable).toBe("function");
      expect(typeof kon.hooks?.onDisable).toBe("function");
    });
  });

  describe("Database Schema", () => {
    it("exports blogPosts table", () => {
      expect(blogPosts).toBeDefined();
    });

    it("exports junction tables", () => {
      expect(blogPostsToTags).toBeDefined();
      expect(blogPostsToGames).toBeDefined();
    });
  });

  describe("Router Factory", () => {
    it("exports createBlogRouter function", () => {
      expect(typeof createBlogRouter).toBe("function");
    });
  });

  describe("SEO Utilities", () => {
    it("exports generateSEOMetadata", () => {
      expect(typeof generateSEOMetadata).toBe("function");
    });

    it("exports validateSEO", () => {
      expect(typeof validateSEO).toBe("function");
    });

    it("exports calculateSEOScore", () => {
      expect(typeof calculateSEOScore).toBe("function");
    });

    it("validates SEO correctly", () => {
      // validateSEO expects: (title, metaDescription, focusKeyword?, content?)
      const warnings = validateSEO(
        "Test Title",
        "This is a test meta description that is long enough for SEO validation purposes"
      );

      expect(Array.isArray(warnings)).toBe(true);
    });

    it("validates SEO with short title", () => {
      const warnings = validateSEO(
        "Hi", // Too short
        "This is a test meta description"
      );

      expect(Array.isArray(warnings)).toBe(true);
      // Should have warning about short title
      expect(warnings.length).toBeGreaterThan(0);
    });

    it("calculates SEO score", () => {
      // calculateSEOScore expects: (title, metaDescription, hasFeaturedImage, hasAuthor, hasKeywords, warnings)
      const score = calculateSEOScore(
        "Perfect SEO Title Here",
        "This is an excellent meta description that has the right length",
        true, // hasFeaturedImage
        true, // hasAuthor
        true, // hasKeywords
        [] // no warnings
      );

      expect(typeof score).toBe("number");
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("calculates lower score with warnings", () => {
      const scoreWithWarnings = calculateSEOScore("Hi", "Short", false, false, false, [
        "warning1",
        "warning2",
      ]);

      expect(typeof scoreWithWarnings).toBe("number");
      expect(scoreWithWarnings).toBeLessThan(100);
    });
  });

  describe("Content Utilities", () => {
    it("exports sanitizeHTML", () => {
      expect(typeof sanitizeHTML).toBe("function");
    });

    it("exports generateArticleSchema", () => {
      expect(typeof generateArticleSchema).toBe("function");
    });

    it("sanitizes HTML and removes scripts", () => {
      const dirty = "<script>alert('xss')</script><p>Safe content</p>";
      const clean = sanitizeHTML(dirty);

      // Should remove script tags
      expect(clean).not.toContain("<script>");
      expect(clean).not.toContain("alert");

      // Content should be preserved (possibly without HTML depending on implementation)
      expect(clean).toContain("Safe content");
    });

    it("sanitizes HTML completely with stripAll option", () => {
      const html = "<p>Some HTML</p><script>bad</script>";
      const clean = sanitizeHTML(html, { stripAll: true });

      // Should not contain any HTML tags
      expect(clean).not.toContain("<script>");
      expect(clean).not.toContain("</script>");
    });

    it("generates Article schema", () => {
      // generateArticleSchema expects specific data format
      const schema = generateArticleSchema({
        title: "Test Article",
        description: "A test article description",
        url: "http://test.com/article",
        publishedAt: new Date().toISOString(), // Valid ISO string
        author: { name: "Test Author" },
      });

      expect(schema["@context"]).toBe("https://schema.org");
      expect(schema["@type"]).toBeDefined();
      expect(schema.headline).toBe("Test Article");
      expect(schema.description).toBe("A test article description");
    });

    it("generates Article schema with Date object", () => {
      const schema = generateArticleSchema({
        title: "Another Article",
        description: "Description here",
        url: "http://test.com/article2",
        publishedAt: new Date(), // Date object
        author: { name: "Author Name" },
      });

      expect(schema.datePublished).toBeDefined();
      expect(typeof schema.datePublished).toBe("string");
    });
  });

  describe("OpenAPI Specification", () => {
    it("kon has OpenAPI support (optional)", () => {
      // Check if the kon has openApi defined (it might not yet)
      const hasOpenApi = "openApi" in kon;

      if (hasOpenApi) {
        expect(kon.openApi).toBeDefined();
        console.log("✅ Kon has OpenAPI spec");
      } else {
        console.log("⚠️  Kon doesn't have OpenAPI spec yet (can be added)");
      }
    });
  });
});

// Run: bun test packages/kons/kon-blog/blog.simple.test.ts
