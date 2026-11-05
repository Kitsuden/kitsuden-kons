/**
 * A screen that says "there is nothing" has to let you create something
 * ============================================================================
 *
 * ── WHAT THERE WAS ─────────────────────────────────────────────────────────
 *
 * The tier list editor, with the table empty, said:
 *
 *     There are no templates yet.
 *
 * And that was the end of it. Its three buttons were "Reload", "Compare" and "Copy
 * as markdown" — all three useless without a template. A dead end
 * that could only be escaped by calling the API by hand.
 *
 * And the API DID know how to create them from the start: `PUT /templates`, with its
 * validation and permission check. Once again the capability written with no
 * way to reach it from the panel — like the block editor, like the media
 * picker, like the image upload.
 *
 * ── THE RULE IT GUARDS ─────────────────────────────────────────────────────
 *
 * If a view knows how to say "there are none", it has to know how to create the first one.
 * The empty state is exactly when someone needs the button, and it is the only
 * moment when the screen has nothing else to offer.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { slugDe } from "../../kons/kon-tierlist/admin-src/format";

const ROOT = join(__dirname, "..", "..");
const KON = join(ROOT, "kons", "kon-tierlist");
const ROUTES = join(KON, "index.ts");

/**
 * The editor's SOURCES (Svelte 5 + tallao), not its minified bundle: the build renames and
 * folds everything, so a text probe on it would test the minifier. The synced copy of tallao
 * (`admin-src/tallao/`) is left out: it is the kit, not this view.
 */
function editorSources(): string {
  const root = join(KON, "admin-src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === "tallao") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(svelte|ts)$/.test(entry.name)) files.push(readFileSync(path, "utf-8"));
    }
  };
  walk(root);
  return files.join("\n");
}

describe("the tier list editor lets you create the first one", () => {
  const editor = editorSources();
  const routes = readFileSync(ROUTES, "utf-8");

  it("the API still exposes creation", () => {
    /**
     * If the route disappeared, the panel form would be left calling
     * into the void — and this test would say why instead of leaving a stray 404.
     */
    expect(routes).toContain('id: "publish-template"');
    expect(routes, "creation has to keep checking permissions").toContain(
      'policy: { resource: "tierlist", action: "publish", inHandler: true }'
    );
  });

  it("the panel offers to create it", () => {
    expect(
      /onclick=\{\(\) => void toggleNew\(true\)\}>New tier list</.test(editor),
      "the editor has to have a create button: without it, a new installation " +
        "cannot start any tier list from the panel."
    ).toBe(true);

    expect(editor).toContain("async function create(");
    expect(editor, "creation has to call `PUT /templates`").toContain('api.tierlist("templates", "PUT"');
  });

  it("the empty state opens the form instead of staying mute", () => {
    const load = editor.slice(editor.indexOf("async function load()"), editor.indexOf("async function open("));

    expect(load.length, "`load` not found").toBeGreaterThan(0);
    expect(
      load.includes("toggleNew(true)"),
      "when there is no template, the only possible action is to create one: " +
        "the form opens on its own instead of leaving a message with no way out."
    ).toBe(true);
  });

  it("after creating it, it opens", () => {
    /**
     * Creating something and leaving the user looking at the same empty screen is what
     * the games "New Game" button used to do: technically it did something, and it is not
     * noticeable.
     */
    const create = editor.slice(editor.indexOf("async function create("));
    const body = create.slice(0, create.indexOf("// ── Board"));

    expect(body.length, "`create` not found").toBeGreaterThan(0);
    expect(body).toContain("await open(s)");
  });

  it("the slug tolerates accents", () => {
    /**
     * The field only accepts `[a-z0-9-]`. Without normalizing before filtering,
     * "Programación" becomes "programacin" —the `ó` does not fit and
     * drops out— and nobody connects the odd URL with the accent.
     */
    expect(editor).toContain('normalize("NFD")');

    // The editor's own function, not a copy of it: a copy would keep passing after the
    // editor's one broke.
    expect(slugDe("Programación competitiva")).toBe("programacion-competitiva");
    expect(slugDe("Tier list del parche 1.2")).toBe("tier-list-del-parche-1-2");
  });
});
