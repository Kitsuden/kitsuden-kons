<!--
  Custom fields of the project's issues. The key and the type are fixed once created (values on
  issues depend on them); deleting a field strips its values from every issue.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    Checkbox,
    ConfirmDialog,
    DataTable,
    Dialog,
    EmptyState,
    Field,
    Input,
    Select,
    type DataColumn,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg } from "../api";
  import { options, words } from "../format";
  import { FIELD_TYPES, type CustomField, type List } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let fields = $state<CustomField[]>([]);
  let editing = $state<CustomField | null>(null);
  let form = $state({ key: "", name: "", type: "text", options: "", isRequired: false, sortOrder: "0" });
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<CustomField | null>(null);
  let confirmDelete = $state(false);

  const withOptions = $derived(form.type === "select" || form.type === "multi_select");
  const keyError = $derived(
    !editing && form.key && !/^[a-z][a-z0-9_]{0,49}$/.test(form.key) ? "Lower-case letters, digits and _, starting with a letter" : undefined
  );
  const valid = $derived(!!form.name.trim() && (!!editing || (!!form.key && !keyError)));

  const columns: DataColumn<CustomField>[] = [
    { key: "name", header: "Field", sortable: true, hideable: false },
    { key: "key", header: "Key", sortable: true },
    { key: "type", header: "Type", sortable: true, value: (f) => words(f.type) },
    { key: "options", header: "Options", value: (f) => (f.options ?? []).join(", ") || "—" },
    { key: "sortOrder", header: "Order", sortable: true, align: "right" },
  ];

  const data = createLoad(async () => {
    fields = (await ws.api.get<List<CustomField>>(`/${seg(ws.projectId!)}/fields`)).docs;
  });

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) untrack(data.load);
  });

  function edit(f: CustomField | null) {
    editing = f;
    form = {
      key: f?.key ?? "",
      name: f?.name ?? "",
      type: f?.type ?? "text",
      options: (f?.options ?? []).join(", "),
      isRequired: !!f?.isRequired,
      sortOrder: String(f?.sortOrder ?? fields.length),
    };
    open = true;
  }

  async function save() {
    const opts = form.options.split(",").map((s) => s.trim()).filter(Boolean);
    const common = {
      name: form.name.trim(),
      isRequired: form.isRequired,
      sortOrder: Number(form.sortOrder) || 0,
      ...(withOptions ? { options: opts } : {}),
    };
    saving = true;
    try {
      await ws.act(
        () =>
          editing
            ? ws.api.patch(`/fields/${seg(editing.id)}`, common)
            : ws.api.post(`/${seg(ws.projectId!)}/fields`, { ...common, key: form.key, type: form.type }),
        editing ? "Field saved" : "Field created",
        editing ? "Could not save the field" : "Could not create the field"
      );
      open = false;
      await data.load();
    } catch {
      // Shown in the toast.
    } finally {
      saving = false;
    }
  }

  async function remove() {
    await ws.act(() => ws.api.del(`/fields/${seg(deleting!.id)}`), "Field deleted", "Could not delete the field");
    await data.load();
  }
</script>

<Panel title="Custom fields">
  {#snippet status()}
    {#if data.ready}<Badge>{fields.length} {fields.length === 1 ? "field" : "fields"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button onclick={() => edit(null)}>New field</Button>
  {/snippet}
  <DataTable
    caption="Custom fields"
    rows={fields}
    {columns}
    rowKey="id"
    rowLabel={(f) => f.name}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(f, col)}
      {#if col.key === "name"}
        <span class="name">
          {f.name}
          {#if f.isRequired}<Badge variant="warning">Required</Badge>{/if}
        </span>
      {:else if col.key === "key"}
        <code>{f.key}</code>
      {:else if col.key === "sortOrder"}
        {f.sortOrder}
      {:else}
        {col.value?.(f)}
      {/if}
    {/snippet}
    {#snippet rowActions(f)}
      <RowMenu
        label={`Actions: ${f.name}`}
        items={[
          { label: "Edit", onSelect: () => edit(f) },
          {
            label: "Delete",
            danger: true,
            separated: true,
            onSelect: () => {
              deleting = f;
              confirmDelete = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="No custom fields yet" actionLabel="New field" onAction={() => edit(null)} />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New field"} closeLabel={CLOSE} size="lg">
  <FormGrid label={editing ? `Edit ${editing.name}` : "New field"} onsubmit={() => valid && !saving && save()}>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={100} />
    </Field>
    <Field label="Key" required error={keyError}>
      <Input bind:value={form.key} maxlength={50} disabled={!!editing} placeholder="customer_id" />
    </Field>
    <Field label="Type">
      <Select bind:value={form.type} options={options(FIELD_TYPES)} disabled={!!editing} />
    </Field>
    <Field label="Order">
      <Input type="number" min="0" max="10000" bind:value={form.sortOrder} />
    </Field>
    {#if withOptions}
      <Field label="Options" class="wide">
        <Input bind:value={form.options} placeholder="Small, Medium, Large" />
      </Field>
    {/if}
    <div class="wide">
      <Checkbox bind:checked={form.isRequired} label="Required" />
    </div>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
    <Button loading={saving} disabled={!valid} onclick={save}>Save</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.name ?? ""}?`}
  description="Its values are removed from every issue."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={remove}
/>

<style>
  .name {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  code {
    white-space: nowrap;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }
</style>
