/**
 * @kitsuden/kon-academy-lms — Academy LMS (Kon Core)
 *
 * Complete Learning Management System with courses, modules, quizzes,
 * student progress, assignment groups, Learning Paths,
 * satisfaction surveys, PDF certificates and Excel export.
 *
 * Layer: Kon Core (Nivel 3 — loaded via module-loader)
 * Mount: /api/academy
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTE: This kon is now MODERN and uses defineKon.
 * It exports a KonDefinition with createRouter factory.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// Re-export from src/ (modern kon definition)
export * from "./src/index";
export { default } from "./src/index";
