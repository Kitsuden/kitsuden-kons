<!-- Modules (epics): status, lead, dates and the initiative they serve. -->
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
  import { dateInput, day, nullable, options, statusVariant, words } from "../format";
  import { MODULE_STATUSES, type Initiative, type List, type Module } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";
  import Swatch from "../ui/Swatch.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let modules = $state<Module[]>([]);
  let initiatives = $state<Initiative[]>([]);
  let editing = $state<Module | null>(null);
  let form = $state({
    name: "",
    description: "",
    color: "",
    status: "backlog",
    leadId: "",
    startDate: "",
    targetDate: "",
    initiativeId: "",
  });
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<Module | null>(null);
  let confirmDelete = $state(false);

  const initiativeName = (id: string | null | undefined) => initiatives.find((i) => i.id === id)?.name ?? "—";

  const columns: DataColumn<Module>[] = [
    { key: "name", header: "Module", sortable: true, hideable: false },
    { key: "status", header: "Status", sortable: true, value: (m) => words(m.status) },
    { key: "leadId", header: "Lead", sortable: true, value: (m) => ws.memberLabel(m.leadId) },
    { key: "startDate", header: "Starts", sortable: true, value: (m) => day(m.startDate) },
    { key: "targetDate", header: "Target", sortable: true, value: (m) => day(m.targetDate) },
    { key: "initiativeId", header: "Initiative", sortable: true, value: (m) => initiativeName(m.initiativeId) },
  ];

  const data = createLoad(async () => {
    const id = seg(ws.projectId!);
    const [m, i] = await Promise.all([
      ws.api.get<List<Module>>(`/${id}/modules`),
      ws.api.get<List<Initiative>>(`/${id}/initiatives`),
    ]);
    modules = m.docs;
    initiatives = i.docs;
  });

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) untrack(data.load);
  });

  function edit(m: Module | null) {
    editing = m;
    form = {
      name: m?.name ?? "",
      description: m?.description ?? "",
      color: m?.color ?? ws.neutralColor(),
      status: m?.status ?? "backlog",
      leadId: m?.leadId ?? "",
      startDate: dateInput(m?.startDate),
      targetDate: dateInput(m?.targetDate),
      initiativeId: m?.initiativeId ?? "",
    };
    open = true;
  }

  async function save() {
    saving = true;
    try {
      if (editing) {
        await ws.act(
          () =>
            ws.api.patch(`/modules/${seg(editing!.id)}`, {
              name: form.name.trim(),
              description: nullable(form.description),
              color: form.color || undefined,
              status: form.status,
              leadId: nullable(form.leadId),
              startDate: nullable(form.startDate),
              targetDate: nullable(form.targetDate),
              initiativeId: nullable(form.initiativeId),
            }),
          "Module saved",
          "Could not save the module"
        );
      } else {
        await ws.act(
          () =>
            ws.api.post(`/${seg(ws.projectId!)}/modules`, {
              name: form.name.trim(),
              description: form.description.trim() || undefined,
              color: form.color || undefined,
            }),
          "Module created",
          "Could not create the module"
        );
      }
      open = false;
      await data.load();
    } catch {
      // Shown in the toast.
    } finally {
      saving = false;
    }
  }

  async function remove() {
    await ws.act(() => ws.api.del(`/modules/${seg(deleting!.id)}`), "Module deleted", "Could not delete the module");
    await data.load();
  }
</script>

<Panel title="Modules">
  {#snippet status()}
    {#if data.ready}<Badge>{modules.length} {modules.length === 1 ? "module" : "modules"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button onclick={() => edit(null)}>New module</Button>
  {/snippet}
  <DataTable
    caption="Modules"
    rows={modules}
    {columns}
    rowKey="id"
    rowLabel={(m) => m.name}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(m, col)}
      {#if col.key === "name"}
        <Swatch color={m.color} name={m.name} />
      {:else if col.key === "status"}
        <Badge variant={statusVariant(m.status)}>{words(m.status)}</Badge>
      {:else}
        <span class="nowrap">{col.value?.(m)}</span>
      {/if}
    {/snippet}
    {#snippet rowActions(m)}
      <RowMenu
        label={`Actions: ${m.name}`}
        items={[
          { label: "Edit", onSelect: () => edit(m) },
          {
            label: "Delete",
            danger: true,
            separated: true,
            onSelect: () => {
              deleting = m;
              confirmDelete = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="No modules yet" actionLabel="New module" onAction={() => edit(null)} />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New module"} closeLabel={CLOSE} size="lg">
  <FormGrid label={editing ? `Edit ${editing.name}` : "New module"} onsubmit={() => form.name.trim() && !saving && save()}>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={200} />
    </Field>
    <Field label="Color">
      <Input type="color" bind:value={form.color} />
    </Field>
    {#if editing}
      <Field label="Status">
        <Select bind:value={form.status} options={options(MODULE_STATUSES)} />
      </Field>
      <Field label="Lead">
        <Select bind:value={form.leadId} options={ws.memberOptions} placeholder="None" />
      </Field>
      <Field label="Starts">
        <Input type="date" bind:value={form.startDate} />
      </Field>
      <Field label="Target">
        <Input type="date" bind:value={form.targetDate} />
      </Field>
      <Field label="Initiative" class="wide">
        <Select bind:value={form.initiativeId} options={initiatives.map((i) => ({ value: i.id, label: i.name }))} placeholder="None" />
      </Field>
    {/if}
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
  description="Its issues stay, without a module."
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
