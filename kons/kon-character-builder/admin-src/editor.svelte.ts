/**
 * The definition being edited and what every section shares: the saved definitions for the
 * picker, the datasets with their schema (the dataset and column dropdowns: without them ids and
 * column names would have to be typed, which is what this screen exists to remove), the state
 * badge and the error/success notices.
 */
import { getContext, setContext } from "svelte";

import { seg, type Api } from "./api";
import type { Dataset, Definition, DefinitionSummary } from "./types";

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

export class Editor {
  definitions = $state<DefinitionSummary[]>([]);
  datasets = $state<Dataset[]>([]);
  /** The definition's URL (slug); empty while it has not been saved. */
  slug = $state("");
  /** Once the URL is typed by hand (or the definition is opened), the name stops rewriting it. */
  slugTouched = $state(false);
  def = $state<Definition>(EMPTY());
  /** The picker's value: the definition last opened or saved. */
  picked = $state("");
  status = $state("");
  error = $state<string | null>(null);
  success = $state<string | null>(null);
  busy = $state(false);

  /** The engine requires an id: a new definition takes its normalized name while nobody set one. */
  private idFollowsName = true;

  constructor(private readonly api: Api) {}

  private say(error: string | null, success: string | null = null) {
    this.error = error;
    this.success = success;
  }

  async load() {
    try {
      this.say(null);
      const { data } = await this.api.get<{ data?: DefinitionSummary[] }>("/builder/definitions");
      this.definitions = data ?? [];

      // A failed dataset list leaves the dropdowns with "by hand" only, as before.
      try {
        const p = await this.api.get<{ docs?: Dataset[]; data?: Dataset[] }>("/data-sets");
        this.datasets = p.docs ?? p.data ?? [];
      } catch {
        this.datasets = [];
      }

      if (this.definitions[0]) await this.open(this.definitions[0].slug);
      else this.newItem();
    } catch (e) {
      this.say(message(e));
    }
  }

  async open(slug: string) {
    if (!slug) return;
    try {
      this.say(null);
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
    } catch (e) {
      this.say(message(e));
    }
  }

  newItem() {
    this.slug = "";
    this.slugTouched = false;
    this.idFollowsName = true;
    this.def = EMPTY();
    this.status = "Unsaved";
    this.say(null);
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
    this.busy = true;
    try {
      this.say(null);
      const r = await this.api.post<{ ok?: boolean; error?: string }>("/builder/definitions/validate", {
        definition: $state.snapshot(this.def),
      });
      if (r.ok) this.say(null, "It compiles. The formulas and the slots are consistent.");
      else this.say(r.error ?? "It does not compile.");
    } catch (e) {
      this.say(message(e));
    } finally {
      this.busy = false;
    }
  }

  async save(published: "draft" | "published") {
    if (!this.slug) return this.say("A URL is needed to save.");
    if (!this.def.name) return this.say("A name is needed.");

    this.busy = true;
    try {
      this.say(null);
      await this.api.put("/builder/definitions", {
        slug: this.slug,
        definition: $state.snapshot(this.def),
        published,
      });

      const { data } = await this.api.get<{ data?: DefinitionSummary[] }>("/builder/definitions");
      this.definitions = data ?? [];
      this.picked = this.slug;
      this.slugTouched = true;

      this.status = published === "published" ? "Published" : "Draft";
      this.say(null, published === "published" ? "Published." : "Saved as a draft.");
    } catch (e) {
      // The server's 422 carries the real reason, which is what should be shown.
      this.say(message(e));
    } finally {
      this.busy = false;
    }
  }

  /** Columns of a dataset, from its schema. */
  columnsOf(datasetId: string): string[] {
    const d = this.datasets.find((x) => x.id === datasetId);
    const fields = Array.isArray(d?.schema) ? (d.schema as Array<{ name?: string; key?: string }>) : [];
    return fields.map((f) => f.name ?? f.key).filter((c): c is string => Boolean(c));
  }
}

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function provideEditor(editor: Editor) {
  setContext(KEY, editor);
}

export function useEditor(): Editor {
  return getContext<Editor>(KEY);
}
