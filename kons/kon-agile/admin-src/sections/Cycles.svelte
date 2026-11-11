<!--
  Cycles (sprints): create, edit, start, close with carry-over of unfinished issues (to the next
  cycle by start date, to a chosen one, or back to the backlog) and delete.
-->
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
  import { CYCLE_STATUSES, type Cycle, type List } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import Panel from "../ui/Panel.svelte";
  import RowMenu, { type RowAction } from "../ui/RowMenu.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();
  const NEXT = "__next";
  const BACKLOG = "__backlog";

  let cycles = $state<Cycle[]>([]);
  let editing = $state<Cycle | null>(null);
  let form = $state({ name: "", description: "", goal: "", capacity: "", startDate: "", endDate: "", status: "draft" });
  let open = $state(false);
  let saving = $state(false);
  let target = $state<Cycle | null>(null);
  let carryOver = $state(NEXT);
  let confirmComplete = $state(false);
  let confirmDelete = $state(false);

  const columns: DataColumn<Cycle>[] = [
    { key: "name", header: "Cycle", sortable: true, hideable: false },
    { key: "startDate", header: "Starts", sortable: true, value: (c) => day(c.startDate) },
    { key: "endDate", header: "Ends", sortable: true, value: (c) => day(c.endDate) },
    { key: "status", header: "Status", sortable: true, value: (c) => words(c.status) },
    { key: "capacity", header: "Capacity", sortable: true, align: "right", value: (c) => c.capacity ?? null },
  ];

  const data = createLoad(async () => {
    cycles = (await ws.api.get<List<Cycle>>(`/${seg(ws.projectId!)}/cycles`)).docs;
  });

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) untrack(data.load);
  });

  function edit(c: Cycle | null) {
    editing = c;
    form = {
      name: c?.name ?? "",
      description: c?.description ?? "",
      goal: c?.goal ?? "",
      capacity: c?.capacity != null ? String(c.capacity) : "",
      startDate: dateInput(c?.startDate),
      endDate: dateInput(c?.endDate),
      status: c?.status ?? "draft",
    };
    open = true;
  }

  const datesError = $derived(form.startDate && form.endDate && form.endDate < form.startDate ? "Ends before it starts" : undefined);
  const valid = $derived(!!form.name.trim() && !!form.startDate && !!form.endDate && !datesError);

  async function save() {
    saving = true;
    try {
      if (editing) {
        await ws.act(
          () =>
            ws.api.patch(`/cycles/${seg(editing!.id)}`, {
              name: form.name.trim(),
              description: nullable(form.description),
              goal: nullable(form.goal),
              // bind:value on a number input gives a number, or null when empty.
              capacity: String(form.capacity ?? "").trim() ? Number(form.capacity) : null,
              startDate: form.startDate,
              endDate: form.endDate,
              status: form.status,
            }),
          "Cycle saved",
          "Could not save the cycle"
        );
      } else {
        await ws.act(
          () =>
            ws.api.post(`/${seg(ws.projectId!)}/cycles`, {
              name: form.name.trim(),
              description: form.description.trim() || undefined,
              startDate: form.startDate,
              endDate: form.endDate,
            }),
          "Cycle created",
          "Could not create the cycle"
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

  async function start(c: Cycle) {
    await ws.run(() => ws.api.patch(`/cycles/${seg(c.id)}`, { isActive: true, status: "started" }), "Cycle started", "Could not start the cycle");
    await data.load();
  }

  async function complete() {
    const body = carryOver === NEXT ? {} : { carryOverTo: carryOver === BACKLOG ? null : carryOver };
    await ws.act(() => ws.api.post(`/cycles/${seg(target!.id)}/complete`, body), "Cycle closed", "Could not close the cycle");
    await data.load();
  }

  async function remove() {
    await ws.act(() => ws.api.del(`/cycles/${seg(target!.id)}`), "Cycle deleted", "Could not delete the cycle");
    await data.load();
  }

  const open_ = (c: Cycle) => c.status !== "completed" && c.status !== "cancelled";
  const carryOptions = $derived([
    { value: NEXT, label: "Next cycle by start date" },
    ...cycles.filter((c) => c.id !== target?.id && open_(c)).map((c) => ({ value: c.id, label: c.name })),
    { value: BACKLOG, label: "Backlog (no cycle)" },
  ]);

  const menu = (c: Cycle): RowAction[] => [
    { label: "Edit", onSelect: () => edit(c) },
    ...(open_(c) && !c.isActive ? [{ label: "Start", onSelect: () => void start(c) }] : []),
    ...(open_(c)
      ? [
          {
            label: "Close",
            onSelect: () => {
              target = c;
              carryOver = NEXT;
              confirmComplete = true;
            },
          },
        ]
      : []),
    {
      label: "Delete",
      danger: true,
      separated: true,
      onSelect: () => {
        target = c;
        confirmDelete = true;
      },
    },
  ];
</script>

<Panel title="Cycles">
  {#snippet status()}
    {#if data.ready}<Badge>{cycles.length} {cycles.length === 1 ? "cycle" : "cycles"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button onclick={() => edit(null)}>New cycle</Button>
  {/snippet}
  <DataTable
    caption="Cycles"
    rows={cycles}
    {columns}
    rowKey="id"
    rowLabel={(c) => c.name}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(c, col)}
      {#if col.key === "name"}
        <span class="name">
          {c.name}
          {#if c.isActive}<Badge variant="info" dot>Active</Badge>{/if}
        </span>
      {:else if col.key === "status"}
        <Badge variant={statusVariant(c.status)}>{words(c.status)}</Badge>
      {:else if col.key === "capacity"}
        {c.capacity ?? "—"}
      {:else}
        <span class="nowrap">{col.value?.(c)}</span>
      {/if}
    {/snippet}
    {#snippet rowActions(c)}
      <RowMenu label={`Actions: ${c.name}`} items={menu(c)} />
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="No cycles yet" actionLabel="New cycle" onAction={() => edit(null)} />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New cycle"} closeLabel={CLOSE} size="lg">
  <FormGrid label={editing ? `Edit ${editing.name}` : "New cycle"} onsubmit={() => valid && !saving && save()}>
    <Field label="Name" required class="wide">
      <Input bind:value={form.name} maxlength={200} />
    </Field>
    <Field label="Starts" required>
      <Input type="date" bind:value={form.startDate} />
    </Field>
    <Field label="Ends" required error={datesError}>
      <Input type="date" bind:value={form.endDate} />
    </Field>
    {#if editing}
      <Field label="Status">
        <Select bind:value={form.status} options={options(CYCLE_STATUSES)} />
      </Field>
      <Field label="Capacity (points)">
        <Input type="number" min="0" bind:value={form.capacity} />
      </Field>
      <Field label="Goal" class="wide">
        <Textarea bind:value={form.goal} rows={2} maxlength={5000} />
      </Field>
    {/if}
    <Field label="Description" class="wide">
      <Textarea bind:value={form.description} rows={2} maxlength={5000} />
    </Field>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
    <Button loading={saving} disabled={!valid} onclick={save}>Save</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmComplete}
  title={`Close ${target?.name ?? ""}?`}
  confirmLabel="Close cycle"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="primary"
  onConfirm={complete}
>
  <Field label="Unfinished issues go to">
    <Select bind:value={carryOver} options={carryOptions} />
  </Field>
</ConfirmDialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${target?.name ?? ""}?`}
  description="Its issues stay, without a cycle."
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

  .name {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
</style>
