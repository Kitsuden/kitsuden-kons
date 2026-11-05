/**
 * Content Publishing Utilities
 *
 * Helper functions for content generation and manipulation.
 * These were previously in @kitsuden/core/content-publishing
 */

/**
 * Generate a URL-friendly slug from a string
 */
export function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD") // Normalize accents
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
    .substring(0, 100); // Limit length
}

/**
 * Render a template string with data interpolation
 * Simple template: "Hello {name}" + {name: "World"} = "Hello World"
 */
export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = data[key];
    return value !== undefined ? String(value) : match;
  });
}

/**
 * Generate an excerpt from content
 * Takes first N characters and adds ellipsis if truncated
 */
export function generateExcerpt(content: Record<string, unknown>, maxLength: number = 200): string {
  // Try to find text content in various fields
  const textContent =
    content.description || content.content || content.body || content.text || content.summary || "";

  // If it's a string, use it directly; otherwise stringify
  const text = typeof textContent === "string" ? textContent : JSON.stringify(textContent);

  // Strip HTML tags if present
  const plainText = text.replace(/<[^>]+>/g, " ");

  // Trim and truncate
  const trimmed = plainText.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  // Find last space before maxLength
  const truncated = trimmed.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > maxLength * 0.8) {
    return truncated.substring(0, lastSpace) + "...";
  }

  return truncated + "...";
}

/**
 * Estimate reading time in minutes
 * Average reading speed: 200 words per minute
 */
export function estimateReadingTime(text: string, wordsPerMinute: number = 200): number {
  const wordCount = text.trim().split(/\s+/).length;
  return Math.max(1, Math.ceil(wordCount / wordsPerMinute));
}

/**
 * Sanitize HTML content
 * Basic sanitization - removes script tags and dangerous attributes
 */
export function sanitizeHtml(html: string): string {
  return (
    html
      // Remove script tags and contents
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      // Remove event handlers
      .replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, "")
      // Remove javascript: URLs
      .replace(/javascript:/gi, "")
      // Remove data: URLs (except images)
      .replace(/data:(?!image\/)\/[^;]*;/gi, "")
  );
}

/**
 * Convert plain text to HTML paragraphs
 */
export function textToHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/**
 * Extract first image URL from HTML content
 */
export function extractFirstImage(html: string): string | null {
  const match = html.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  return match?.[1] || null;
}

/**
 * Count words in text
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, maxLength: number, suffix: string = "..."): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - suffix.length) + suffix;
}
