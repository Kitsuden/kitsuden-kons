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

  The admin mounts it with `context` ({ apiBase, theme, locale… }); calls go to the kon's REST
  routes with the browser's cookies.
-->
<script lang="ts">
  import { Alert, Badge, Button, Field, Input, Select, ThemeScope } from "$lib/components";

  import { createApi } from "./api";
  import { Editor, provideEditor } from "./editor.svelte";
  import BaseStats from "./sections/BaseStats.svelte";
  import Budgets from "./sections/Budgets.svelte";
  import Derived from "./sections/Derived.svelte";
  import Slots from "./sections/Slots.svelte";
  import Panel from "./ui/Panel.svelte";

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
    editor.load();
  });

  const pickerOptions = $derived(
    editor.definitions.map((d) => ({
      value: d.slug,
      label: d.published === "published" ? d.name : `${d.name} (draft)`,
    }))
  );
</script>

<ThemeScope class="builder-admin">
  <Panel title="Definition">
    {#snippet actions()}
      {#if editor.status}
        <Badge variant={editor.status === "Published" ? "success" : "secondary"}>{editor.status}</Badge>
      {/if}
    {/snippet}

    <div class="toolbar">
      <div class="picker">
        <Select
          aria-label="Definition to edit"
          bind:value={editor.picked}
          options={pickerOptions}
          placeholder={editor.definitions.length ? undefined : "— none yet —"}
          onchange={(e: Event) => editor.open((e.currentTarget as HTMLSelectElement).value)}
        />
      </div>
      <Button variant="secondary" onclick={() => editor.newItem()}>New</Button>
      <Button variant="secondary" disabled={editor.busy} onclick={() => editor.validate()}>Check</Button>
      <Button variant="secondary" disabled={editor.busy} onclick={() => editor.save("draft")}>Save draft</Button>
      <Button disabled={editor.busy} onclick={() => editor.save("published")}>Publish</Button>
    </div>

    <div class="fields">
      <Field label="Name">
        <Input
          value={editor.def.name ?? ""}
          placeholder="Weapon builder"
          autocomplete="off"
          oninput={(e: Event) => editor.setName((e.currentTarget as HTMLInputElement).value)}
        />
      </Field>
      <Field label="URL">
        <Input
          value={editor.slug}
          placeholder="builder-armas"
          pattern="[a-z0-9\-]+"
          autocomplete="off"
          spellcheck="false"
          oninput={(e: Event) => editor.setSlug((e.currentTarget as HTMLInputElement).value)}
        />
      </Field>
    </div>

    {#if editor.error || editor.success}
      <div class="notices">
        {#if editor.error}
          <Alert variant="error" dismissLabel="Dismiss" onDismiss={() => (editor.error = null)}>
            {editor.error}
          </Alert>
        {/if}
        {#if editor.success}
          <Alert variant="success" dismissLabel="Dismiss" onDismiss={() => (editor.success = null)}>
            {editor.success}
          </Alert>
        {/if}
      </div>
    {/if}
  </Panel>

  <BaseStats />
  <Slots />
  <Derived />
  <Budgets />
</ThemeScope>

<style>
  :host {
    display: block;
  }

  :global(.builder-admin) {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .picker {
    flex: 1 1 16rem;
    max-width: 28rem;
  }

  .fields {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    gap: 0.75rem 1rem;
    margin-top: 1rem;
  }

  .notices {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  @media (max-width: 640px) {
    .fields {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
