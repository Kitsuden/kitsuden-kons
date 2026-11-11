<!--
  Estimate scales. Points are written as a list: "1, 2, 3, 5, 8", or "1=XS, 2=S, 3=M" when the
  label is not the number.
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
  import { ESTIMATE_TYPES, type Estimate, type EstimatePoint, type List } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let estimates = $state<Estimate[]>([]);
  let editing = $state<Estimate | null>(null);
  let form = $state({ name: "", type: "fibonacci", points: "", isDefault: false });
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<Estimate | null>(null);
  let confirmDelete = $state(false);

  const showPoints = (points: EstimatePoint[] | null | undefined) =>
    (points ?? []).map((p) => (String(p.value) === p.label ? p.label : `${p.value}=${p.label}`)).join(", ");

  const columns: DataColumn<Estimate>[] = [
    { key: "name", header: "Estimate", sortable: true, hideable: false },
    { key: "type", header: "Type", sortable: true, value: (e) => words(e.type) },
    { key: "points", header: "Points", value: (e) => showPoints(e.customPoints) || "—" },
  ];

  const data = createLoad(async () => {
    estimates = (await ws.api.get<List<Estimate>>(`/${seg(ws.projectId!)}/estimates`)).docs;
  });

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) untrack(data.load);
  });

  /** "1, 2=S" → points; null when a value is not a number. */
  function parsePoints(text: string): EstimatePoint[] | null {
    const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
    const points: EstimatePoint[] = [];
    for (const part of parts) {
      const [v, label] = part.split("=").map((s) => s.trim());
      const value = Number(v);
      if (!v || Number.isNaN(value)) return null;
      points.push({ value, label: label || v });
    }
    return points;
  }

  const pointsError = $derived(form.points.trim() && parsePoints(form.points) === null ? "Each point is a number, or number=label" : undefined);
  const valid = $derived(!!form.name.trim() && !pointsError);

  function edit(e: Estimate | null) {
    editing = e;
    form = { name: e?.name ?? "", type: e?.type ?? "fibonacci", points: showPoints(e?.customPoints), isDefault: !!e?.isDefault };
    open = true;
  }

  async function save() {
    const points = parsePoints(form.points) ?? [];
    const body = {
      name: form.name.trim(),
      type: form.type,
      customPoints: points,
      ...(form.isDefault ? { isDefault: true } : {}),
    };
    saving = true;
    try {
      await ws.act(
        () =>
          editing
            ? ws.api.patch(`/estimates/${seg(editing.id)}`, body)
            : ws.api.post(`/${seg(ws.projectId!)}/estimates`, body),
        editing ? "Estimate saved" : "Estimate created",
        editing ? "Could not save the estimate" : "Could not create the estimate"
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
    await ws.act(() => ws.api.del(`/estimates/${seg(deleting!.id)}`), "Estimate deleted", "Could not delete the estimate");
    await data.load();
  }
</script>

<Panel title="Estimates">
  {#snippet status()}
    {#if data.ready}<Badge>{estimates.length} {estimates.length === 1 ? "scale" : "scales"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button onclick={() => edit(null)}>New estimate</Button>
  {/snippet}
  <DataTable
    caption="Estimate scales"
    rows={estimates}
    {columns}
    rowKey="id"
    rowLabel={(e) => e.name}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(e, col)}
      {#if col.key === "name"}
        <span class="name">
          {e.name}
          {#if e.isDefault}<Badge variant="purple">Default</Badge>{/if}
        </span>
      {:else}
        {col.value?.(e)}
      {/if}
    {/snippet}
    {#snippet rowActions(e)}
      <RowMenu
        label={`Actions: ${e.name}`}
        items={[
          { label: "Edit", onSelect: () => edit(e) },
          {
            label: "Delete",
            danger: true,
            separated: true,
            onSelect: () => {
              deleting = e;
              confirmDelete = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="No estimate scales yet" actionLabel="New estimate" onAction={() => edit(null)} />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New estimate"} closeLabel={CLOSE}>
  <FormGrid label={editing ? `Edit ${editing.name}` : "New estimate"} onsubmit={() => valid && !saving && save()}>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={100} />
    </Field>
    <Field label="Type">
      <Select bind:value={form.type} options={options(ESTIMATE_TYPES)} />
    </Field>
    <Field label="Points" error={pointsError} class="wide">
      <Input bind:value={form.points} placeholder="1, 2, 3, 5, 8" />
    </Field>
    <div class="wide">
      <Checkbox bind:checked={form.isDefault} label="Default for the project" />
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
</style>
