<!-- One slot: its name, id and capacity, and the dataset its options come from. -->
<script lang="ts">
  import { untrack } from "svelte";

  import { Alert, Button, Field, Input, KeyValueEditor, Select, type KeyValueEntry } from "$lib/components";

  import { useEditor } from "../editor.svelte";
  import type { Slot } from "../types";

  const { slot, index }: { slot: Slot; index: number } = $props();

  const editor = useEditor();

  // Mutations go through the editor's own state, not through the prop.
  const own = () => editor.def.slots[index];

  // The capacity's text is kept while typing: writing back `Number(v) || 1` on every key would
  // turn an emptied field into "1" before the new number is typed.
  let capacity = $state(untrack(() => String(slot.capacity ?? 1)));

  const title = $derived(slot.name || slot.id || `Slot ${index + 1}`);

  const datasetOptions = $derived(
    editor.datasets.map((d) => ({ value: d.id, label: d.name ?? d.slug ?? d.id }))
  );
  const datasetId = $derived(slot.optionsFrom?.datasetId ?? "");
  const columns = $derived(datasetId ? editor.columnsOf(datasetId) : []);
  const columnOptions = $derived(columns.map((c) => ({ value: c, label: c })));
  const statEntries = $derived(
    Object.entries(slot.optionsFrom?.statFields ?? {}).map(([key, value]) => ({ key, value }))
  );

  const text = (e: Event) => (e.currentTarget as HTMLInputElement | HTMLSelectElement).value;

  function chooseDataset(value: string) {
    const s = own();
    if (!value) delete s.optionsFrom;
    else
      s.optionsFrom = {
        ...(s.optionsFrom ?? {}),
        datasetId: value,
        statFields: s.optionsFrom?.statFields ?? {},
      };
  }

  function setField(field: "idField" | "costField", value: string) {
    const from = own().optionsFrom;
    if (from) from[field] = value || null;
  }

  function changeStats(next: KeyValueEntry[]) {
    const from = own().optionsFrom;
    if (from) from.statFields = Object.fromEntries(next.map((e) => [e.key, e.value]));
  }
</script>

<section class="slot" aria-label={`Slot ${title}`}>
  <div class="head">
    <h3 class="sub">{title}</h3>
    <Button variant="ghost" size="sm" ariaLabel={`Remove slot ${title}`} onclick={() => editor.def.slots.splice(index, 1)}>
      Remove
    </Button>
  </div>

  <div class="fields">
    <Field label="Name">
      <Input
        value={slot.name ?? ""}
        placeholder="Weapon"
        autocomplete="off"
        oninput={(e: Event) => (own().name = text(e))}
      />
    </Field>
    <Field label="Id">
      <Input
        value={slot.id ?? ""}
        autocomplete="off"
        spellcheck="false"
        oninput={(e: Event) => (own().id = text(e))}
      />
    </Field>
    <Field label="Capacity">
      <Input
        bind:value={capacity}
        type="number"
        oninput={(e: Event) => (own().capacity = Number(text(e)) || 1)}
      />
    </Field>
    <Field label="Options from">
      <Select
        value={datasetId}
        options={datasetOptions}
        placeholder="By hand"
        onchange={(e: Event) => chooseDataset(text(e))}
      />
    </Field>
  </div>

  {#if slot.optionsFrom?.datasetId}
    {#if columns.length === 0}
      <Alert variant="warning" title="That dataset declares no columns">
        Without a schema there is nowhere to get the id or the modifiers.
      </Alert>
    {:else}
      <div class="fields">
        <Field label="Stable id column">
          <Select
            value={slot.optionsFrom.idField ?? ""}
            options={columnOptions}
            placeholder="None"
            onchange={(e: Event) => setField("idField", text(e))}
          />
        </Field>
        <Field label="Cost column">
          <Select
            value={slot.optionsFrom.costField ?? ""}
            options={columnOptions}
            placeholder="None"
            onchange={(e: Event) => setField("costField", text(e))}
          />
        </Field>
      </div>

      <h4>Which column feeds which stat</h4>
      <KeyValueEditor
        entries={statEntries}
        onchange={changeStats}
        keyOptions={columns}
        separator="→"
        valuePlaceholder="atk_flat"
        keyLabel="Column"
        valueLabel="Stat"
        addLabel="Add"
        emptyText="No column feeds a stat."
      />
    {/if}
  {/if}
</section>

<style>
  /* One slot of the list, not a card of its own: a rule between slots. */
  .slot {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }

  .slot:not(:first-child) {
    padding-top: 1rem;
    border-top: 1px solid rgb(var(--ta-border));
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .sub {
    margin: 0;
    min-width: 0;
    font-size: 0.875rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
    gap: 0.75rem;
  }

  h4 {
    margin: 0.25rem 0 0;
    font-size: 0.8125rem;
    font-weight: 600;
    color: rgb(var(--ta-text));
  }
</style>
