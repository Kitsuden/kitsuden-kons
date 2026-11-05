/**
 * Every icon declared by a kon must be in the admin's map
 * ============================================================================
 *
 * The manifests (`kon.json`) and the registry's `getDefaultIcon` declare the
 * icon as the NAME of a lucide component: `Gamepad2`, `FileText`,
 * `ScanText`… The admin translates it into a component with a static map in
 * `KonIcon.svelte`.
 *
 * ── WHY A MAP, AND WHY THIS TEST ───────────────────────────────────────────
 *
 * The first attempt was to resolve it with a dynamic import:
 *
 *     import(/* @vite-ignore *​/ `lucide-svelte/icons/${name}`)
 *
 * and it failed in the worst possible way: `@vite-ignore` means "do not analyze
 * this", so Vite bundled NO icon and the browser received a bare specifier
 * it does not know how to resolve. All imports failed,
 * all cards showed the fallback icon, and the screen looked
 * exactly the same as if the design were meant to be that way.
 *
 * The static map fixes that, but introduces the opposite risk: as soon as
 * someone writes a kon with a new icon, the map falls short. And the failure
 * is silent again — a generic icon instead of its own.
 *
 * This test closes that gap: it compares what is declared with what is mapped.
 *
 * ── THE ALIASES ────────────────────────────────────────────────────────────
 *
 * Three names —`CheckCircle`, `HelpCircle`, `UserCircle`— no longer exist in
 * lucide: they were renamed to `CircleCheck`, `CircleHelp` and `CircleUser`. The
 * manifests still use the old name, so the map translates them. That is why the
 * map KEYS are checked and not the imports.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
// The map lives in `lib/icons.ts`, not in the component: both the
// list cards and the side menu use it, and two copies would have diverged.
const MAP = join(ROOT, ".kitsuden", "packages", "admin", "src", "lib", "icons.ts");
const KON_ICON = join(ROOT, ".kitsuden", "packages", "admin", "src", "lib", "components", "KonIcon.svelte");

/** Icon names declared by kon and grimoire manifests. */
function declaredIcons(): Map<string, string[]> {
  const foundItems = new Map<string, string[]>();

  const dirs = [join(ROOT, "kons"), join(ROOT, ".kitsuden", "packages", "grimoires")];

  for (const base of dirs) {
    if (!existsSync(base)) continue;
    for (const input of readdirSync(base, { withFileTypes: true })) {
      if (!input.isDirectory()) continue;
      for (const name of ["kon.json", "grimoire.json", "kitsuden.json"]) {
        const p = join(base, input.name, name);
        if (!existsSync(p)) continue;
        const text = readFileSync(p, "utf-8");
        for (const m of text.matchAll(/"icon"\s*:\s*"([A-Z][A-Za-z0-9]*)"/g)) {
          const icon = m[1]!;
          const list = foundItems.get(icon) ?? [];
          list.push(`${input.name}/${name}`);
          foundItems.set(icon, list);
        }
      }
    }
  }

  return foundItems;
}

/** Keys of the `ICONS` map in KonIcon.svelte. */
function mappedIcons(): Set<string> {
  const source = readFileSync(MAP, "utf-8");
  const block = source.match(/const ICONS[^{]*\{([\s\S]*?)\n\s*\};/);
  if (!block) return new Set();

  const keys = new Set<string>();
  for (const line of block[1]!.split("\n")) {
    // Accepts `Name,` and `Name: OtherName,`; ignores comments.
    const m = line.match(/^\s*([A-Z][A-Za-z0-9]*)\s*[,:]/);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

describe("kon icons", () => {
  const declaredAll = declaredIcons();
  const mappedItems = mappedIcons();

  it("declared icons were found", () => {
    // Without this, a format change in the manifests would leave the list empty
    // and the check below would pass without looking at anything.
    expect(declaredAll.size).toBeGreaterThan(20);
  });

  it("the icon map could be read", () => {
    expect(mappedItems.size).toBeGreaterThan(20);
  });

  it("all declared ones are in the map", () => {
    const absent = [...declaredAll.entries()]
      .filter(([icon]) => !mappedItems.has(icon))
      .map(([icon, where]) => `${icon}  (${where.slice(0, 3).join(", ")})`);

    expect(
      absent,
      `These icons are declared by some kon and KonIcon.svelte does not know them:\n\n` +
        `${absent.join("\n")}\n\n` +
        `They will be shown with the generic icon, without any notice. Add them to the map ` +
        `of packages/admin/src/lib/components/KonIcon.svelte with its ` +
        `corresponding import (the lucide file goes in kebab-case: ` +
        `Gamepad2 → lucide-svelte/icons/gamepad-2).`
    ).toEqual([]);
  });

  it("KonIcon does not use dynamic import with @vite-ignore", () => {
    /**
     * The failure mode that motivated the map: with `@vite-ignore`, Vite does not bundle
     * the icons and the browser receives a specifier it cannot resolve.
     * It gives no compile error — no icon is simply shown.
     */
    const source = readFileSync(MAP, "utf-8") + readFileSync(KON_ICON, "utf-8");
    const code = source
      .replace(/\/\*\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"))
      .join("\n");

    expect(
      /import\(\s*\/\*\s*@vite-ignore/.test(code),
      "KonIcon resolves icons again with a dynamic import marked " +
        "@vite-ignore. Vite does not bundle them and the browser cannot resolve " +
        "the specifier: no icon would be shown, and with no error at all."
    ).toBe(false);
  });
});
