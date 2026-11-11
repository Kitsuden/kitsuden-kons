<!-- Initiatives: goals with a target date, their issue counts and pace. -->
<script lang="ts">
  import {
    Badge,
    Button,
    ConfirmDialog,
    DataTable,
    Dialog,
    EmptyState,
    Field,
    Input,
    Select,
    Textarea,
    type DataColumn,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg } from "../api";
  import { dateInput, day, nullable, optional, options, statusVariant, words } from "../format";
  import { INITIATIVE_STATUSES, type Initiative, type List } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";
  import Swatch from "../ui/Swatch.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let initiatives = $state<Initiative[]>([]);
  let editing = $state<Initiative | null>(null);
  let form = $state({ name: "", description: "", status: "planned", leadId: "", color: "", startDate: "", targetDate: "" });
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<Initiative | null>(null);
  let confirmDelete = $state(false);

  const paceOf = (i: Initiative) => (typeof i.pace === "string" ? i.pace : (i.pace?.status ?? "no_dates"));
  const paceVariant = (p: string) =>
    ({ on_track: "success", at_risk: "warning", off_track: "error", done: "success" })[p] as
      | "success"
      | "warning"
      | "error"
      | undefined;

  const columns: DataColumn<Initiative>[] = [
    { key: "name", header: "Initiative", sortable: true, hideable: false },
    { key: "status", header: "Status", sortable: true, value: (i) => words(i.status) },
    { key: "leadId", header: "Lead", sortable: true, value: (i) => ws.memberLabel(i.leadId) },
    { key: "targetDate", header: "Target", sortable: true, value: (i) => day(i.targetDate) },
    { key: "issues", header: "Issues done", align: "right", value: (i) => (i.issues ? `${i.issues.completed}/${i.issues.total}` : "—") },
    { key: "pace", header: "Pace", sortable: true, value: (i) => words(paceOf(i)) },
  ];

  const data = createLoad(async () => {
    initiatives = (await ws.api.get<List<Initiative>>(`/${seg(ws.projectId!)}/initiatives`)).docs;
  });

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) untrack(data.load);
  });

  function edit(i: Initiative | null) {
    editing = i;
    form = {
      name: i?.name ?? "",
      description: i?.description ?? "",
      status: i?.status ?? "planned",
      leadId: i?.leadId ?? "",
      color: i?.color ?? ws.neutralColor(),
      startDate: dateInput(i?.startDate),
      targetDate: dateInput(i?.targetDate),
    };
    open = true;
  }

  async function save() {
    saving = true;
    try {
      await ws.act(
        () =>
          editing
            ? ws.api.patch(`/initiatives/${seg(editing.id)}`, {
                name: form.name.trim(),
                description: nullable(form.description),
                status: form.status,
                leadId: nullable(form.leadId),
                color: form.color || undefined,
                startDate: nullable(form.startDate),
                targetDate: nullable(form.targetDate),
              })
            : ws.api.post(`/${seg(ws.projectId!)}/initiatives`, {
                name: form.name.trim(),
                description: optional(form.description),
                status: form.status,
                leadId: optional(form.leadId),
                color: form.color || undefined,
                startDate: optional(form.startDate),
                targetDate: optional(form.targetDate),
              }),
        editing ? "Initiative saved" : "Initiative created",
        editing ? "Could not save the initiative" : "Could not create the initiative"
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
    await ws.act(() => ws.api.del(`/initiatives/${seg(deleting!.id)}`), "Initiative deleted", "Could not delete the initiative");
    await data.load();
  }
</script>

<Panel title="Initiatives">
  {#snippet status()}
    {#if data.ready}<Badge>{initiatives.length} {initiatives.length === 1 ? "initiative" : "initiatives"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button onclick={() => edit(null)}>New initiative</Button>
  {/snippet}
  <DataTable
    caption="Initiatives"
    rows={initiatives}
    {columns}
    rowKey="id"
    rowLabel={(i) => i.name}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(i, col)}
      {#if col.key === "name"}
        <Swatch color={i.color} name={i.name} />
      {:else if col.key === "status"}
        <Badge variant={statusVariant(i.status)}>{words(i.status)}</Badge>
      {:else if col.key === "pace"}
        <Badge variant={paceVariant(paceOf(i))} dot>{words(paceOf(i))}</Badge>
      {:else}
        <span class="nowrap">{col.value?.(i)}</span>
      {/if}
    {/snippet}
    {#snippet rowActions(i)}
      <RowMenu
        label={`Actions: ${i.name}`}
        items={[
          { label: "Edit", onSelect: () => edit(i) },
          {
            label: "Delete",
            danger: true,
            separated: true,
            onSelect: () => {
              deleting = i;
              confirmDelete = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="No initiatives yet" actionLabel="New initiative" onAction={() => edit(null)} />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New initiative"} closeLabel={CLOSE} size="lg">
  <FormGrid label={editing ? `Edit ${editing.name}` : "New initiative"} onsubmit={() => form.name.trim() && !saving && save()}>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={200} />
    </Field>
    <Field label="Status">
      <Select bind:value={form.status} options={options(INITIATIVE_STATUSES)} />
    </Field>
    <Field label="Lead">
      <Select bind:value={form.leadId} options={ws.memberOptions} placeholder="None" />
    </Field>
    <Field label="Color">
      <Input type="color" bind:value={form.color} />
    </Field>
    <Field label="Starts">
      <Input type="date" bind:value={form.startDate} />
    </Field>
    <Field label="Target">
      <Input type="date" bind:value={form.targetDate} />
    </Field>
    <Field label="Description" class="wide">
      <Textarea bind:value={form.description} rows={2} maxlength={5000} />
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
  description="Its modules and issues stay, without an initiative."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={remove}
/>

<style>
  .nowrap {
    white-space: nowrap;
  }
</style>
