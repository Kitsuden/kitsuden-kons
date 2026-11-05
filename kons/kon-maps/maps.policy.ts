/**
 * Maps — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "maps" policy.
 *
 * Maps are editorial content: the viewer reads them without a session —it lives
 * on a public page and is often embedded— and writing them requires a role. A
 * badly placed marker is seen by everyone at once.
 */
import { definePolicy } from "@kitsuden/engine";

export function registerMapsPolicy(): void {
  definePolicy<{ id: string }>("maps", {
    view: () => true,
    create: (user) => user?.role === "admin" || user?.role === "editor",
    update: (user) => user?.role === "admin" || user?.role === "editor",
    delete: (user) => user?.role === "admin",
  });
}

registerMapsPolicy();
