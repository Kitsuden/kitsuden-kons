/**
 * @kitsuden/kon-blog — Blog Posts (Kon Core)
 *
 * Publishing platform with rich text editor, scheduling,
 * tags, and SEO overrides.
 *
 * Layer: Kon Core (Nivel 3 — loaded via module-loader)
 * Mount: /api/blog
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTE: This kon is now self-contained and uses dependency injection.
 * It does NOT import from apps/api/src/ anymore.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// Re-export from src/
export * from "./src/index";
export { default } from "./src/index";
