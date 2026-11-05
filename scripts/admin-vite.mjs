/**
 * The Vite config every kon admin view is built with (scripts/build-admin.mjs).
 *
 * A view is one Svelte component compiled as a custom element and bundled alone into the file
 * its kon.json points at (`admin/<out>`): the admin loads that one file at runtime, so nothing
 * is split into chunks. Only the view's root component is compiled with `customElement: true`;
 * the rest keep `css: "injected"`, so their styles land in the element's Shadow DOM. `$lib` is
 * the kon's copy of tallao (admin-src/tallao, see scripts/sync-tallao.mjs).
 */
import { join } from "node:path";

import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * @param {{ adminSrc: string, entry: string, out: string }} view
 *   adminSrc: the kon's admin-src folder; entry: the view's root .svelte file, relative to it;
 *   out: the built file's name inside the kon's admin/ folder.
 */
export function adminViteConfig({ adminSrc, entry, out }) {
  const root = join(adminSrc, entry).replaceAll("\\", "/");
  return {
    root: adminSrc,
    configFile: false,
    logLevel: "warn",
    plugins: [
      svelte({
        configFile: false,
        emitCss: false,
        compilerOptions: { css: "injected" },
        dynamicCompileOptions: ({ filename }) =>
          filename.replaceAll("\\", "/") === root ? { customElement: true } : undefined,
      }),
    ],
    resolve: { alias: { $lib: join(adminSrc, "tallao") } },
    build: {
      outDir: join(adminSrc, "..", "admin"),
      emptyOutDir: false,
      target: "es2022",
      sourcemap: false,
      modulePreload: false,
      // An app build with a script entry, not library mode: library mode leaves the whitespace of
      // an ES bundle in (the file came out twice as large).
      rollupOptions: {
        input: { view: root },
        preserveEntrySignatures: false,
        output: { format: "es", entryFileNames: out, inlineDynamicImports: true },
      },
    },
  };
}
