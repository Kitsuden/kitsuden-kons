<!-- One slot: its name, id and capacity, and the dataset its options come from. -->
<script lang="ts">
  import { untrack } from "svelte";

  import { Button, Field, Input, KeyValueEditor, Select, type KeyValueEntry } from "$lib/components";

  import { useEditor } from "../editor.svelte";
  import type { Slot } from "../types";

  const { slot, index }: { slot: Slot; index: number } = $props();

  const editor = useEditor();

  // Mutations go through the editor's own state, not through the prop.
  const own = () => editor.def.slots[index];

  // The capacity's text is kept while typing: writing back `Number(v) || 1` on every key would
  // turn an emptied field into "1" before the new number is typed.
  let capacity = $state(untrack(() => String(slot.capacity ?? 1)));

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

<div class="slot">
  <div class="header">
    <Field label="Name">
      <Input
        value={slot.name ?? ""}
        placeholder={'Name — "Weapon"'}
        autocomplete="off"
        oninput={(e: Event) => (own().name = text(e))}
      />
    </Field>
    <Field label="id">
      <Input
        value={slot.id ?? ""}
        placeholder="id"
        autocomplete="off"
        spellcheck="false"
        oninput={(e: Event) => (own().id = text(e))}
      />
    </Field>
    <Field label="Capacity">
      <Input
        bind:value={capacity}
        type="number"
        placeholder="capacity"
        oninput={(e: Event) => (own().capacity = Number(text(e)) || 1)}
      />
    </Field>
    <Button variant="ghost" size="sm" onclick={() => editor.def.slots.splice(index, 1)}>Remove slot</Button>
  </div>

  <div class="source">
    <Field label="Options from">
      <Select
        value={datasetId}
        options={datasetOptions}
        placeholder="— by hand —"
        onchange={(e: Event) => chooseDataset(text(e))}
      />
    </Field>
  </div>

  {#if slot.optionsFrom?.datasetId}
    {#if columns.length === 0}
      <p class="empty">
        That dataset declares no columns. Without a schema there is nowhere to get the id or the modifiers.
      </p>
    {:else}
      <div class="mapping">
        <Field label="stable id">
          <Select
            value={slot.optionsFrom.idField ?? ""}
            options={columnOptions}
            placeholder="— none —"
            onchange={(e: Event) => setField("idField", text(e))}
          />
        </Field>
        <Field label="cost">
          <Select
            value={slot.optionsFrom.costField ?? ""}
            options={columnOptions}
            placeholder="— none —"
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
</div>

<style>
  .slot {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-bg));
  }

  .header {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) 6rem auto;
    align-items: end;
    gap: 0.5rem 0.75rem;
  }

  .source {
    max-width: 22rem;
  }

  .mapping {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 12rem));
    gap: 0.5rem 0.75rem;
  }

  h4 {
    margin: 0.25rem 0 0;
    font-size: 0.8125rem;
    font-weight: 600;
    color: rgb(var(--ta-text));
  }

  .empty {
    margin: 0;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }

  @media (max-width: 640px) {
    .header,
    .mapping {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
