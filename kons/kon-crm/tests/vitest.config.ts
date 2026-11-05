// Vitest Configuration for CRM Kon Tests

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.spec.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "tests/", "**/*.d.ts"],
    },
  },
  resolve: {
    alias: {
      "@kitsuden/shared": path.resolve(__dirname, "../../../packages/shared"),
    },
  },
});
