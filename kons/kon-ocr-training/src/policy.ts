/**
 * kon-ocr-training — authorization policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "ocr-training" policy.
 *
 * This kon OPERATES the model: it promotes templates, launches trainings and spends
 * the vision LLM key (money). There is no action here that belongs to an
 * ordinary user, and account sign-up is public: «having a session» cannot
 * be enough. Everything is administration.
 */
import { definePolicy, type AuthzUser } from "@kitsuden/engine";

const isAdmin = (u: AuthzUser | null) => u?.role === "admin";

export function registerOcrTrainingPolicy(): void {
  definePolicy("ocr-training", {
    /** Proxy to the engine (proposals, train, vocabulary…) and overview. */
    operate: (u) => isAdmin(u),
    /** Read/change the vision LLM config, test the key, reprocess. */
    configure: (u) => isAdmin(u),
  });
}

registerOcrTrainingPolicy();
