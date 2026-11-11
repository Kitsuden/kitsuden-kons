<!-- The project's labels: name, colour and what each is for. -->
<script lang="ts">
  import { Badge, Button, ConfirmDialog, DataTable, Dialog, EmptyState, Field, Input, type DataColumn } from "$lib/components";
  import { untrack } from "svelte";

  import { seg } from "../api";
  import type { Label, List } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";
  import Swatch from "../ui/Swatch.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let labels = $state<Label[]>([]);
  let editing = $state<Label | null>(null);
  let form = $state({ name: "", description: "", color: "" });
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<Label | null>(null);
  let confirmDelete = $state(false);

  const columns: DataColumn<Label>[] = [
    { key: "name", header: "Label", sortable: true, hideable: false },
    { key: "description", header: "Description", value: (l) => l.description || "—" },
  ];

  const data = createLoad(async () => {
    labels = (await ws.api.get<List<Label>>(`/${seg(ws.projectId!)}/labels`)).docs;
  });

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) untrack(data.load);
  });

  function edit(l: Label | null) {
    editing = l;
    form = { name: l?.name ?? "", description: l?.description ?? "", color: l?.color ?? ws.neutralColor() };
    open = true;
  }

  async function save() {
    const body = { name: form.name.trim(), description: form.description.trim(), color: form.color || undefined };
    saving = true;
    try {
      await ws.act(
        () =>
          editing
            ? ws.api.patch(`/labels/${seg(editing.id)}`, body)
            : ws.api.post(`/${seg(ws.projectId!)}/labels`, body),
        editing ? "Label saved" : "Label created",
        editing ? "Could not save the label" : "Could not create the label"
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
    await ws.act(() => ws.api.del(`/labels/${seg(deleting!.id)}`), "Label deleted", "Could not delete the label");
    await data.load();
  }
</script>

<Panel title="Labels">
  {#snippet status()}
    {#if data.ready}<Badge>{labels.length} {labels.length === 1 ? "label" : "labels"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button onclick={() => edit(null)}>New label</Button>
  {/snippet}
  <DataTable
    caption="Labels"
    rows={labels}
    {columns}
    rowKey="id"
    rowLabel={(l) => l.name}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(l, col)}
      {#if col.key === "name"}
        <Swatch color={l.color} name={l.name} />
      {:else}
        {col.value?.(l)}
      {/if}
    {/snippet}
    {#snippet rowActions(l)}
      <RowMenu
        label={`Actions: ${l.name}`}
        items={[
          { label: "Edit", onSelect: () => edit(l) },
          {
            label: "Delete",
            danger: true,
            separated: true,
            onSelect: () => {
              deleting = l;
              confirmDelete = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="No labels yet" actionLabel="New label" onAction={() => edit(null)} />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New label"} closeLabel={CLOSE}>
  <FormGrid label={editing ? `Edit ${editing.name}` : "New label"} onsubmit={() => form.name.trim() && !saving && save()}>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={100} />
    </Field>
    <Field label="Color">
      <Input type="color" bind:value={form.color} />
    </Field>
    <Field label="Description" class="wide">
      <Input bind:value={form.description} maxlength={1000} />
    </Field>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
    <Button loading={saving} disabled={!form.name.trim()} onclick={save}>Save</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.name ?? ""}?`}
  description="It is removed from every issue."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={remove}
/>
