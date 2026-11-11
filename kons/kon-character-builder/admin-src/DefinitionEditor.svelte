<svelte:options
  customElement={{
    tag: "builder-definition-editor",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <builder-definition-editor>: where a builder is DEFINED (its slots, the dataset its options come
  from, which column feeds which stat, the formulas derived from that). Putting a build together
  belongs to the public frontend (the `character-builder` block), not here.

  Everything that can be chosen is chosen: datasets and their columns come from `/api/data-sets`
  with their schema, so a mistyped id or column cannot ship an empty slot. The deliberate
  exception is the stat name of the column → stat map: it is the vocabulary of the formulas and is
  nowhere it could be taken from, and guessing it would give plausible but wrong numbers.

  The view is one form: its sections one under another and one SaveBar at the end, which knows
  whether there are unsaved changes.

  The admin mounts it with `context` ({ apiBase, theme, locale… }); calls go to the kon's REST
  routes with the browser's cookies. The theme comes from the admin's `--kitsuden-*` variables
  through tallao's ThemeScope (ui/View.svelte), which also holds the Toaster.
-->
<script lang="ts">
  import { Alert, Badge, Button, Field, Input, SaveBar, Select } from "$lib/components";

  import { createApi } from "./api";
  import { Editor, provideEditor } from "./editor.svelte";
  import BaseStats from "./sections/BaseStats.svelte";
  import Budgets from "./sections/Budgets.svelte";
  import Derived from "./sections/Derived.svelte";
  import Slots from "./sections/Slots.svelte";
  import Loadable from "./ui/Loadable.svelte";
  import Panel from "./ui/Panel.svelte";
  import View from "./ui/View.svelte";

  interface ViewContext {
    apiBase?: string;
    theme?: "light" | "dark";
    locale?: string;
  }

  let { context, params }: { context?: ViewContext; params?: unknown } = $props();

  const editor = new Editor(createApi(() => context?.apiBase || "/api"));
  provideEditor(editor);

  // The host may set `context` before or after connecting, and again when the theme changes:
  // load once per API base.
  let loadedBase: string | null = null;
  $effect(() => {
    const base = context?.apiBase || "/api";
    if (base === loadedBase) return;
    loadedBase = base;
    void editor.load();
  });

  const pickerOptions = $derived(
    editor.definitions.map((d) => ({
      value: d.slug,
      label: d.published === "published" ? d.name : `${d.name} (draft)`,
    }))
  );

  const ready = $derived(editor.data.ready && editor.editing);
  const saving = $derived(editor.busy === "draft" || editor.busy === "published");

  function pick(slug: string) {
    if (slug) void editor.open(slug);
    else editor.newItem();
  }
</script>

<View>
  <Panel title="Definition" description="One builder: its slots, their options and its stats.">
    {#snippet status()}
      {#if ready}
        <Badge variant={editor.status === "Published" ? "success" : editor.status === "Draft" ? "default" : "warning"} dot>
          {editor.status === "New" ? "Not saved yet" : editor.status}
        </Badge>
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if ready}<Button size="sm" variant="outline" onclick={() => editor.newItem()}>New definition</Button>{/if}
    {/snippet}

    <Loadable
      load={editor.data}
      empty={!editor.editing}
      emptyTitle="No definitions yet"
      emptyDescription="A definition says what a builder lets the reader choose and what it calculates."
      actionLabel="New definition"
      onAction={() => editor.newItem()}
      errorTitle="The definitions did not load"
    >
      <div class="fields">
        {#if editor.definitions.length}
          <Field label="Definition to edit" class="wide">
            <Select
              bind:value={editor.picked}
              options={pickerOptions}
              placeholder="New definition"
              onchange={(e: Event) => pick((e.currentTarget as HTMLSelectElement).value)}
            />
          </Field>
        {/if}
        <Field label="Name" required>
          <Input
            value={editor.def.name ?? ""}
            placeholder="Weapon builder"
            autocomplete="off"
            oninput={(e: Event) => editor.setName((e.currentTarget as HTMLInputElement).value)}
          />
        </Field>
        <Field label="URL" required>
          <Input
            value={editor.slug}
            placeholder="weapon-builder"
            pattern="[a-z0-9\-]+"
            autocomplete="off"
            spellcheck="false"
            oninput={(e: Event) => editor.setSlug((e.currentTarget as HTMLInputElement).value)}
          />
        </Field>
      </div>
    </Loadable>
  </Panel>

  {#if ready}
    <BaseStats />
    <Slots />
    <Derived />
    <Budgets />

    {#if editor.problem}
      <Alert variant="error" title="The definition does not compile">{editor.problem}</Alert>
    {/if}

    <SaveBar
      savedText="No unsaved changes"
      dirty={editor.dirty}
      {saving}
      saveLabel="Publish"
      cancelLabel="Discard"
      ariaLabel="Save the definition"
      secondaryActions={[{ id: "draft", label: "Save draft", onSelect: () => void editor.save("draft") }]}
      onSave={() => void editor.save("published")}
      onCancel={editor.dirty ? () => editor.discard() : undefined}
    >
      <Button size="sm" variant="ghost" loading={editor.busy === "check"} disabled={saving} onclick={() => void editor.validate()}>
        Check
      </Button>
    </SaveBar>
  {/if}
</View>

<style>
  :host {
    display: block;
  }

  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
    gap: 0.75rem;
  }

  .fields > :global(.wide) {
    grid-column: 1 / -1;
  }
</style>
