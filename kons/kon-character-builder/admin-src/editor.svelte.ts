/**
 * The definition being edited and what every section shares: the saved definitions for the
 * picker, the datasets with their schema (the dataset and column dropdowns: without them ids and
 * column names would have to be typed, which is what this screen exists to remove), the state
 * badge, whether there are unsaved changes, and what the last check found wrong.
 *
 * Results of actions go to the toast (ui/notify.ts). What is wrong with the definition (the
 * check's answer, the server's 422) stays on screen as `problem`: it is read while fixing it.
 */
import { getContext, setContext } from "svelte";

import { ApiError, seg, type Api } from "./api";
import type { Dataset, Definition, DefinitionSummary } from "./types";
import { createLoad, message } from "./ui/load.svelte";
import { failed, toast } from "./ui/notify";

/** An empty definition, with the shape the engine expects. */
export const EMPTY = (): Definition => ({ id: "", name: "", baseStats: {}, slots: [], budgets: [], derived: [] });

/** Title → slug. Accents are removed BEFORE filtering. */
export function slugOf(text: string): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const KEY = Symbol("builder-definition-editor");

export type Status = "Published" | "Draft" | "New";

export class Editor {
  definitions = $state<DefinitionSummary[]>([]);
  datasets = $state<Dataset[]>([]);
  /** The definition's URL (slug); empty while it has not been saved. */
  slug = $state("");
  /** Once the URL is typed by hand (or the definition is opened), the name stops rewriting it. */
  slugTouched = $state(false);
  def = $state<Definition>(EMPTY());
  /** The picker's value: the definition last opened or saved; empty for a new one. */
  picked = $state("");
  status = $state<Status>("New");
  /** A definition is on screen: one that was opened, or a new one that was started. */
  editing = $state(false);
  /** What is running: the check, or a save as draft or published. */
  busy = $state<"check" | "draft" | "published" | null>(null);
  /** What the check or the server's validation found wrong. */
  problem = $state<string | null>(null);

  /** The engine requires an id: a new definition takes its normalized name while nobody set one. */
  private idFollowsName = true;

  /** What was opened or saved last, to tell unsaved changes and to go back to on Discard. */
  private saved = $state("");
  /** The picker's last good value: where it returns when a definition does not open. */
  private last = "";
  private savedFlags = { slugTouched: false, idFollowsName: true };
  private snapshot = () => JSON.stringify({ slug: this.slug, def: this.def });
  readonly dirty = $derived(this.editing && this.saved !== "" && this.snapshot() !== this.saved);

  /** The first load: the saved definitions, the datasets, and the first definition opened. */
  readonly data = createLoad(async () => {
    const { data } = await this.api.get<{ data?: DefinitionSummary[] }>("/builder/definitions");
    this.definitions = data ?? [];

    // A failed dataset list leaves the dropdowns with "by hand" only, as before.
    try {
      const p = await this.api.get<{ docs?: Dataset[]; data?: Dataset[] }>("/data-sets");
      this.datasets = p.docs ?? p.data ?? [];
    } catch {
      this.datasets = [];
    }

    if (this.definitions[0]) await this.fetch(this.definitions[0].slug);
    else if (!this.editing) this.blank();
  });

  constructor(private readonly api: Api) {}

  load() {
    return this.data.load();
  }

  private mark() {
    this.saved = this.snapshot();
    this.savedFlags = { slugTouched: this.slugTouched, idFollowsName: this.idFollowsName };
  }

  private async fetch(slug: string) {
    const { data } = await this.api.get<{ data: { definition?: Partial<Definition>; published?: string } }>(
      `/builder/definitions/${seg(slug)}`
    );
    const def: Definition = { ...EMPTY(), ...(data.definition ?? {}) } as Definition;
    // Those saved with the old `{stat, expression}` shape are translated on open, so that
    // saving them again passes the engine's validation.
    def.derived = ((def.derived ?? []) as unknown as Array<Record<string, string>>).map((d) => ({
      name: d.name ?? d.stat,
      formula: d.formula ?? d.expression,
    }));
    this.slug = slug;
    this.picked = slug;
    this.slugTouched = true;
    this.idFollowsName = !def.id;
    this.def = def;
    this.status = data.published === "published" ? "Published" : "Draft";
    this.problem = null;
    this.editing = true;
    this.last = slug;
    this.mark();
  }

  /** The picker: opens a saved definition. If it does not open, the one on screen stays. */
  async open(slug: string) {
    if (!slug) return;
    try {
      await this.fetch(slug);
    } catch (e) {
      this.picked = this.last;
      failed("Could not open the definition", e);
    }
  }

  private blank() {
    this.slug = "";
    this.picked = "";
    this.slugTouched = false;
    this.idFollowsName = true;
    this.def = EMPTY();
    this.status = "New";
    this.problem = null;
    this.last = "";
    this.mark();
  }

  newItem() {
    this.blank();
    this.editing = true;
  }

  /** Back to what was opened or saved last. Nothing is asked of the server. */
  discard() {
    if (!this.saved) return;
    const last = JSON.parse(this.saved) as { slug: string; def: Definition };
    this.slug = last.slug;
    this.def = last.def;
    this.slugTouched = this.savedFlags.slugTouched;
    this.idFollowsName = this.savedFlags.idFollowsName;
    this.problem = null;
  }

  setName(name: string) {
    this.def.name = name;
    if (this.idFollowsName) this.def.id = slugOf(name);
    if (!this.slugTouched) this.slug = slugOf(name);
  }

  setSlug(slug: string) {
    this.slugTouched = true;
    this.slug = slug;
  }

  async validate() {
    this.busy = "check";
    try {
      this.problem = null;
      const r = await this.api.post<{ ok?: boolean; error?: string }>("/builder/definitions/validate", {
        definition: $state.snapshot(this.def),
      });
      if (r.ok) toast.success("It compiles", { description: "The formulas and the slots are consistent." });
      else this.problem = r.error ?? "It does not compile.";
    } catch (e) {
      failed("Could not check the definition", e);
    } finally {
      this.busy = null;
    }
  }

  async save(published: "draft" | "published") {
    if (!this.slug) return void toast.error("A URL is needed to save");
    if (!this.def.name) return void toast.error("A name is needed");

    this.busy = published;
    try {
      this.problem = null;
      await this.api.put("/builder/definitions", {
        slug: this.slug,
        definition: $state.snapshot(this.def),
        published,
      });

      const { data } = await this.api.get<{ data?: DefinitionSummary[] }>("/builder/definitions");
      this.definitions = data ?? [];
      this.picked = this.slug;
      this.last = this.slug;
      this.slugTouched = true;

      this.status = published === "published" ? "Published" : "Draft";
      this.mark();
      toast.success(published === "published" ? "Published" : "Saved as a draft");
    } catch (e) {
      // The server's 422 carries the real reason, which is what should be shown and kept.
      if (e instanceof ApiError && e.status === 422) this.problem = message(e);
      failed(published === "published" ? "Could not publish the definition" : "Could not save the draft", e);
    } finally {
      this.busy = null;
    }
  }

  /** Columns of a dataset, from its schema. */
  columnsOf(datasetId: string): string[] {
    const d = this.datasets.find((x) => x.id === datasetId);
    const fields = Array.isArray(d?.schema) ? (d.schema as Array<{ name?: string; key?: string }>) : [];
    return fields.map((f) => f.name ?? f.key).filter((c): c is string => Boolean(c));
  }
}

export function provideEditor(editor: Editor) {
  setContext(KEY, editor);
}

export function useEditor(): Editor {
  return getContext<Editor>(KEY);
}
