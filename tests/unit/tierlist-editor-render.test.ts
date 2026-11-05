/**
 * Tier list editor — render and movement in a real DOM
 * ============================================================================
 *
 * The engine is tested as pure functions, but the editor is the only piece
 * that runs in the editorial team's browser. The view is Svelte 5 + tallao
 * (`kons/kon-tierlist/admin-src/`), and what the admin loads is its BUILD
 * (`admin/tierlist-editor.js`, a self-contained custom element): that is what
 * is mounted here, so a stale or broken build fails these tests.
 *
 * It is driven like a person would: by roles, accessible names and visible
 * text inside its Shadow DOM, not by internal hooks.
 *
 * What is pinned down here:
 *
 *   1. Every section of the view renders with its controls.
 *   2. The path WITHOUT dragging works. It is the only one on touch and with the
 *      keyboard, and it is where a tier list is really built on a tablet.
 *   3. The optimistic move is REVERTED if the server rejects it. Otherwise the
 *      editor sees a board the server does not have.
 *   4. Nothing a user writes goes through `innerHTML` (or `{@html}`).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mountJsdom } from "../../.kitsuden/tests/unit/dom-in-test";

// jsdom is set up here and not with vitest's environment comment (NOTE: that
// comment is detected on ANY line of the file, even quoted in a
// note, and would set up a second jsdom): see dom-in-test.ts
await mountJsdom();

/**
 * jsdom has no modal <dialog>. The view's confirmations are tallao Dialogs, which call
 * showModal()/close(); the minimum to open and close them is enough here (focus trapping and
 * Escape are checked in a real browser). Same shim as tallao's own tests/setup.ts.
 */
{
  const proto = (globalThis.HTMLDialogElement ?? HTMLElement).prototype as HTMLDialogElement;
  if (typeof proto.showModal !== "function") {
    const isDialog = (el: Element) => el.tagName === "DIALOG";
    Object.defineProperty(proto, "open", {
      configurable: true,
      get(this: HTMLElement) {
        return isDialog(this) ? this.hasAttribute("open") : undefined;
      },
      set(this: HTMLElement, value: boolean) {
        if (!isDialog(this)) return;
        if (value) this.setAttribute("open", "");
        else this.removeAttribute("open");
      },
    });
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    proto.show = proto.showModal;
    proto.close = function (this: HTMLDialogElement) {
      if (!this.hasAttribute("open")) return;
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
}

const ROOT = resolve(__dirname, "../..");
const ADMIN_SRC = resolve(ROOT, "kons/kon-tierlist/admin-src");

/** The editor's own sources; the synced copy of tallao (`admin-src/tallao/`) is the kit, not this view. */
function editorSources(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === ADMIN_SRC && entry.name === "tallao") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(svelte|ts)$/.test(entry.name)) files.push(readFileSync(path, "utf8"));
    }
  };
  walk(ADMIN_SRC);
  return files.join("\n");
}

// ── Sample data ──────────────────────────────────────────────────────────────

const TEMPLATES = [
  { id: "t-old", slug: "meta-14-1", title: "Meta", version: "14.1" },
  { id: "t-new", slug: "meta-14-2", title: "Meta", version: "14.2" },
];

const TIERS = [
  { id: "s", label: "S", color: "#ff7f7f" },
  { id: "a", label: "A", color: "#ffbf7f" },
];

const ITEMS = [
  { id: "ahri", label: "Ahri", imageUrl: null },
  { id: "zed", label: "Zed", imageUrl: null },
];

const listRow = (placement: Record<string, string> = {}) => ({
  id: "t-new",
  slug: "meta-14-2",
  title: "Meta",
  version: "14.2",
  tiers: TIERS,
  items: ITEMS,
  placement,
});

/** The sign-up case, so that the title and its slug do not drift apart. */
const TITLE = "Tier list del parche 1.2";
const SLUG = "tier-list-del-parche-1-2";

/** Responses per route. Each test overrides what interests it. */
let routes: Record<string, () => unknown>;
let calls: Array<{ url: string; method: string; body: unknown }>;

function stubFetch() {
  calls = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace("/api/tierlist/", "");
    calls.push({
      url: path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });

    const handler = routes[`${init?.method ?? "GET"} ${path}`] ?? routes[path];
    if (!handler) return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };

    const result = handler() as { status?: number; payload: unknown };
    return {
      ok: (result.status ?? 200) < 400,
      status: result.status ?? 200,
      json: async () => result.payload,
    };
  }) as unknown as typeof fetch;
}

/**
 * The calls to the kon's routes. The editor also asks `GET /api/data-sets` for the catalog
 * dropdown whenever it repaints and has not got them yet (here it is a 404, which it tolerates):
 * that one is not part of what these tests count.
 */
const kon = () => calls.filter((c) => !c.url.includes("data-sets"));
const placeCalls = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/place"));

type Editor = HTMLElement & { context: unknown };

function create(params: Record<string, unknown> = {}): Editor {
  const element = document.createElement("tierlist-editor") as Editor;
  document.body.append(element);
  element.context = { apiBase: "/api", params };
  return element;
}

/** Mounts the component already loaded, with the board painted. */
async function mount() {
  const element = create({ slug: "meta-14-2" });
  await vi.waitFor(() => expect(zone(element, "S")).toBeTruthy());
  return element;
}

const shadow = (element: HTMLElement) => element.shadowRoot!;
const text = (element: HTMLElement) => shadow(element).textContent ?? "";

/** A drop zone (a tier row or the pool) by its accessible name. */
const zone = (element: HTMLElement, name: string) =>
  shadow(element).querySelector<HTMLElement>(`[role="group"][aria-label="${name}"]`);

/** The chips are toggle buttons (`aria-pressed`); their tooltip is the item's name. */
const chipsIn = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLElement>('[role="button"][aria-pressed]'));
const chip = (element: HTMLElement, label: string) =>
  chipsIn(shadow(element)).find((c) => c.getAttribute("title") === label)!;
const labelsIn = (element: HTMLElement, zoneName: string) =>
  chipsIn(zone(element, zoneName)!).map((c) => c.getAttribute("title"));
const picked = (element: HTMLElement, label: string) =>
  chip(element, label).getAttribute("aria-pressed") === "true";

/** A native button by its visible text. */
const button = (element: HTMLElement, name: string) =>
  Array.from(shadow(element).querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === name
  )!;
/** The button that names a tier row: clicking it places the selected chip there. */
const rowButton = (element: HTMLElement, tier: string) =>
  zone(element, tier)!.querySelector<HTMLButtonElement>("button")!;

const select = (element: HTMLElement, name: string) =>
  shadow(element).querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
const input = (element: HTMLElement, name: string) =>
  shadow(element).querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
const alerts = (element: HTMLElement) =>
  Array.from(shadow(element).querySelectorAll('[role="alert"]')).map((a) => a.textContent ?? "");

const key = (target: EventTarget, k: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

beforeEach(async () => {
  document.body.innerHTML = "";
  routes = {
    templates: () => ({ payload: { data: TEMPLATES } }),
    "templates/meta-14-2": () => ({ payload: { data: listRow() } }),
  };
  stubFetch();
  // The build registers the custom element on import; once is enough because the module is
  // cached (and Svelte guards against defining the tag twice).
  await import("../../kons/kon-tierlist/admin/tierlist-editor.js");
});

// A Svelte custom element destroys itself a microtask after it is disconnected: the editors
// are removed and that tick is awaited HERE, while jsdom is still mounted, so the last one is
// not destroyed after the environment is torn down ("document is not defined").
afterEach(async () => {
  document.body.innerHTML = "";
  await new Promise((r) => setTimeout(r, 0));
});

// ── The view renders, and paints text as text ────────────────────────────────

describe("the view and its sources", () => {
  test("every section renders with its controls", async () => {
    // A section that silently stopped rendering is the failure this guards: each one is
    // looked for by what a person sees.
    const element = await mount();

    for (const title of ["Tier list", "Board", "What changed"]) {
      expect(
        Array.from(shadow(element).querySelectorAll("h3")).map((h) => h.textContent?.trim()),
        `section «${title}»`
      ).toContain(title);
    }
    for (const name of ["Reload", "New tier list", "Publish as page", "Fetch from catalog", "Add", "Compare", "Copy as markdown"]) {
      expect(button(element, name), `button «${name}»`).toBeTruthy();
    }
    for (const name of ["Tier list to edit", "Catalog", "Version to compare with"]) {
      expect(select(element, name), `dropdown «${name}»`).toBeTruthy();
    }
    expect(zone(element, "Unranked"), "the pool").toBeTruthy();
    expect(input(element, "Chip name"), "the add-by-hand form").toBeTruthy();
  });

  test("nothing written by a user goes through innerHTML", () => {
    // A catalog item's name is written by someone; painting it as HTML would turn the
    // catalog into an injection vector in the admin. In Svelte that means no `{@html}`
    // and no `innerHTML` anywhere in the view's own sources.
    //
    // ── LOOK AT THE CODE, NOT THE COMMENTS ───────────────────────────────
    //
    // A guard that fires on its own explanation («textContent, never innerHTML»)
    // teaches people to ignore it: comments are stripped first.
    const code = editorSources()
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(code.match(/\{@html/g) ?? [], "the view cannot paint anything with {@html}").toHaveLength(0);
    expect(code.match(/innerHTML/g) ?? [], "the view cannot write innerHTML").toHaveLength(0);
  });
});

// ── Board ────────────────────────────────────────────────────────────────────

describe("tablero", () => {
  test("paints a row per tier and the pool with what is left to place", async () => {
    const element = await mount();

    expect(zone(element, "S")).toBeTruthy();
    expect(zone(element, "A")).toBeTruthy();
    expect(labelsIn(element, "Unranked")).toEqual(["Ahri", "Zed"]);
    expect(text(element)).toContain("0/2 placed");
  });

  test("an already placed item appears in ITS row, not in the pool", async () => {
    routes["templates/meta-14-2"] = () => ({ payload: { data: listRow({ ahri: "s" }) } });
    const element = await mount();

    expect(labelsIn(element, "S")).toEqual(["Ahri"]);
    expect(labelsIn(element, "Unranked")).toEqual(["Zed"]);
  });

  test("the name is painted as TEXT", async () => {
    routes["templates/meta-14-2"] = () => ({
      payload: {
        data: {
          ...listRow(),
          items: [{ id: "x", label: "<img src=x onerror=alert(1)>", imageUrl: null }],
        },
      },
    });
    const element = await mount();
    const only = chipsIn(zone(element, "Unranked")!)[0];

    expect(only.querySelector("img")).toBeNull();
    expect(only.textContent).toContain("<img src=x");
  });

  test("the dropdown shows the template being edited", async () => {
    // Repainting the options drops the selection: the other way round, the editor would work
    // on one list and the dropdown would say another.
    const element = await mount();
    expect(select(element, "Tier list to edit").value).toBe("meta-14-2");
  });
});

// ── Placing without dragging ─────────────────────────────────────────────────

describe("placing by clicking (the touch and keyboard path)", () => {
  beforeEach(() => {
    routes["POST templates/meta-14-2/place"] = () => ({
      payload: { data: listRow({ ahri: "s" }) },
    });
  });

  test("selecting an item and clicking the row places it", async () => {
    const element = await mount();

    chip(element, "Ahri").click();
    await vi.waitFor(() => expect(picked(element, "Ahri")).toBe(true));

    rowButton(element, "S").click();

    await vi.waitFor(() => expect(labelsIn(element, "S")).toEqual(["Ahri"]));
    expect(placeCalls().at(-1)).toMatchObject({
      method: "POST",
      body: { itemId: "ahri", tierId: "s" },
    });
  });

  test("Enter on the item selects it just like a click", async () => {
    const element = await mount();
    key(chip(element, "Zed"), "Enter");
    await vi.waitFor(() => expect(picked(element, "Zed")).toBe(true));
  });

  test("with the keyboard alone: Enter picks it up, the arrows choose the row, Enter drops it", async () => {
    // The zones are walked in the order they are seen: from the pool, ↓ wraps to the first row.
    const element = await mount();

    key(chip(element, "Ahri"), "Enter");
    await vi.waitFor(() => expect(picked(element, "Ahri")).toBe(true));
    key(chip(element, "Ahri"), "ArrowDown");
    await vi.waitFor(() => expect(zone(element, "S")!.hasAttribute("data-over")).toBe(true));
    key(chip(element, "Ahri"), "Enter");

    await vi.waitFor(() => expect(labelsIn(element, "S")).toEqual(["Ahri"]));
    expect(placeCalls().at(-1)!.body).toEqual({ itemId: "ahri", tierId: "s" });
    // And it is said, for whoever does not see the board.
    expect(shadow(element).querySelector('[aria-live="assertive"]')!.textContent).toContain(
      "Ahri moved to S"
    );
  });

  test("Escape drops the selection", async () => {
    // Without this, the marked item places itself on the next row that is
    // clicked for any other reason.
    const element = await mount();
    chip(element, "Ahri").click();
    await vi.waitFor(() => expect(picked(element, "Ahri")).toBe(true));

    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await vi.waitFor(() => expect(picked(element, "Ahri")).toBe(false));
  });

  test("clicking a row WITHOUT a selected item sends nothing", async () => {
    const element = await mount();
    const before = kon().length;
    rowButton(element, "S").click();
    await new Promise((r) => setTimeout(r, 20));

    expect(kon()).toHaveLength(before);
  });

  test('dropping into the pool sends `tierId: null`, not the string "null"', async () => {
    routes["templates/meta-14-2"] = () => ({ payload: { data: listRow({ ahri: "s" }) } });
    routes["POST templates/meta-14-2/place"] = () => ({ payload: { data: listRow() } });
    const element = await mount();

    // jsdom has no DragEvent: plain events with the drag's names are what the view listens to.
    chip(element, "Ahri").dispatchEvent(new Event("dragstart", { bubbles: true }));
    zone(element, "Unranked")!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(labelsIn(element, "Unranked")).toEqual(["Ahri", "Zed"]));
    expect(placeCalls().at(-1)!.body).toEqual({ itemId: "ahri", tierId: null });
  });

  test("re-placing in the SAME row does not spend a request", async () => {
    routes["templates/meta-14-2"] = () => ({ payload: { data: listRow({ ahri: "s" }) } });
    const element = await mount();
    const before = kon().length;

    chip(element, "Ahri").click();
    await vi.waitFor(() => expect(picked(element, "Ahri")).toBe(true));
    rowButton(element, "S").click();
    await new Promise((r) => setTimeout(r, 20));

    expect(kon()).toHaveLength(before);
  });
});

// ── Optimistic movement ──────────────────────────────────────────────────────

describe("the move is painted before it is confirmed", () => {
  test("if the server REJECTS, the board goes back and says so", async () => {
    // It is the failure that silently corrupts: without reverting, the editor keeps
    // working on a board the server does not have.
    routes["POST templates/meta-14-2/place"] = () => ({
      status: 409,
      payload: { error: 'La fila "s" no existe' },
    });
    const element = await mount();

    chip(element, "Ahri").click();
    await vi.waitFor(() => expect(picked(element, "Ahri")).toBe(true));
    rowButton(element, "S").click();

    await vi.waitFor(() => {
      expect(alerts(element).join(" ")).toContain("no existe");
    });
    expect(labelsIn(element, "Unranked")).toEqual(["Ahri", "Zed"]);
    expect(labelsIn(element, "S")).toEqual([]);
  });

  test("the SERVER's layout is adopted, not our own", async () => {
    // If another editor moved something in the meantime, their move arrives in the
    // response; keeping the local copy would erase it from the screen.
    routes["POST templates/meta-14-2/place"] = () => ({
      payload: { data: listRow({ ahri: "s", zed: "a" }) },
    });
    const element = await mount();

    chip(element, "Ahri").click();
    await vi.waitFor(() => expect(picked(element, "Ahri")).toBe(true));
    rowButton(element, "S").click();

    await vi.waitFor(() => expect(labelsIn(element, "A")).toEqual(["Zed"]));
    expect(labelsIn(element, "S")).toEqual(["Ahri"]);
  });
});

// ── Diff ─────────────────────────────────────────────────────────────────────

describe("what changed", () => {
  const diff = {
    promoted: [{ item: ITEMS[0], from: TIERS[1], to: TIERS[0], delta: -1 }],
    demoted: [],
    added: [{ item: ITEMS[1], from: null, to: TIERS[1], delta: 0 }],
    removed: [],
    unchanged: 7,
  };

  beforeEach(() => {
    routes["templates/meta-14-2/diff/t-old"] = () => ({ payload: { data: diff } });
  });

  test("it is compared against ANOTHER template, never against itself", async () => {
    const element = await mount();
    const picker = select(element, "Version to compare with");

    expect(Array.from(picker.options).map((o) => o.value)).toEqual(["t-old"]);
  });

  test("groups the changes and COUNTS those that did not move", async () => {
    // In a catalog of 200, listing the 190 that stood still would bury the 10 that
    // changed.
    const element = await mount();
    button(element, "Compare").click();

    await vi.waitFor(() => {
      expect(text(element)).toContain("Moving up (1)");
      expect(text(element)).toContain("New (1)");
      expect(text(element)).toContain("7 unchanged");
    });
    expect(calls.at(-1)).toMatchObject({ method: "GET", url: "templates/meta-14-2/diff/t-old" });
    // With no changes in one direction, that section is not painted empty.
    expect(text(element)).not.toContain("Moving down");
  });

  test("copying gives markdown that can be pasted into the post", async () => {
    // The parameter is declared even if the double does not use it: without it, `mock.calls`
    // is an empty tuple and reading `calls[0][0]` further down does not compile. The signature is
    // that of `navigator.clipboard.writeText`, which is what this double replaces.
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(global.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const element = await mount();
    button(element, "Compare").click();
    await vi.waitFor(() => expect(button(element, "Copy as markdown").disabled).toBe(false));

    button(element, "Copy as markdown").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());

    const markdown = writeText.mock.calls[0][0];
    expect(markdown).toContain("### Moving up");
    expect(markdown).toContain("**Ahri**: A → S");
    expect(markdown).toContain("**Zed**: unranked → A");
    expect(markdown).not.toContain("### Moving down");
    await vi.waitFor(() => expect(button(element, "Copied")).toBeTruthy());
  });

  test("comparing before having a diff does not offer copying", async () => {
    const element = await mount();
    expect(button(element, "Copy as markdown").disabled).toBe(true);
  });
});

// ── Load failures ────────────────────────────────────────────────────────────

describe("when loading fails", () => {
  test("without templates it says so AND offers to create the first", async () => {
    /**
     * ── WHY THE MESSAGE IS NOT ENOUGH ────────────────────────────────────
     *
     * This screen used to say "There are no templates yet." and that was
     * it: its three buttons —Reload, Compare, Copy— are useless without
     * a template. A dead end that could only be escaped by calling
     * the API by hand, which could create them from the start.
     *
     * The empty state is exactly when someone needs the create button, so
     * the form opens on its own.
     */
    routes.templates = () => ({ payload: { data: [] } });
    const element = create();

    await vi.waitFor(() => {
      expect(alerts(element).join(" ")).toContain("There is no tier list yet");
      // The create form is there and open: it is the only thing that can be done here.
      expect(input(element, "Title"), "the create form has to be open").toBeTruthy();
      expect(button(element, "Create")).toBeTruthy();
    });
  });

  test("creating the first one sends it to the API and opens it", async () => {
    /**
     * The test that really closes the case: the form is filled in, submitted,
     * and it is checked THAT `PUT /templates` IS CALLED with the right body
     * — and that afterwards the list stays open.
     *
     * Creating something and leaving the user looking at the same empty screen is what
     * the games "New Game" button used to do: technically it did something, and it is not
     * noticeable.
     */
    let createdOne = false;

    routes["templates"] = () => ({
      payload: { data: createdOne ? [{ id: "t-1", slug: SLUG, title: TITLE, version: null }] : [] },
    });
    routes["PUT templates"] = () => {
      createdOne = true;
      return { payload: { data: { slug: SLUG } } };
    };
    routes[`templates/${SLUG}`] = () => ({
      payload: { data: { slug: SLUG, title: TITLE, tiers: [], items: [], placement: {} } },
    });

    const element = create();

    // The form opens on its own because there are none.
    await vi.waitFor(() => expect(input(element, "Title")).toBeTruthy());

    const title = input(element, "Title");
    title.value = TITLE;
    title.dispatchEvent(new Event("input", { bubbles: true }));
    const rows = input(element, "Rows");
    rows.value = "S,A,B";
    rows.dispatchEvent(new Event("input", { bubbles: true }));

    title.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(calls.some((c) => c.method === "PUT" && c.url === "templates")).toBe(true);
    });

    const high = calls.find((c) => c.method === "PUT" && c.url === "templates")!;
    const body = high.body as {
      slug: string;
      title: string;
      tiers: Array<Record<string, string>>;
    };

    // The slug was proposed from the title while it was being typed.
    expect(body.slug).toBe(SLUG);
    expect(body.title).toBe(TITLE);
    expect(body.tiers).toHaveLength(3);
    expect(body.tiers[0]).toMatchObject({ id: "s", label: "S" });

    // Each row with its color, computed by POSITION: so it works the same with
    // "S,A,B" as with "Imprescindible, Opcional, No".
    expect(body.tiers[0].color).toMatch(/^#[0-9a-f]{6}$/i);

    // And the new one is left open, not returned to the empty screen.
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url === `templates/${SLUG}`)).toBe(true);
      expect(input(element, "Title"), "the form closes").toBeNull();
      expect(select(element, "Tier list to edit").value).toBe(SLUG);
    });
  });

  test("a server error is shown, not swallowed", async () => {
    routes.templates = () => ({ status: 500, payload: { error: "Database down" } });
    const element = create();

    await vi.waitFor(() => expect(alerts(element).join(" ")).toContain("Database down"));
  });
});
