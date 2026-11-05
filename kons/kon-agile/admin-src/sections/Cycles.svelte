<!--
  Cycles (sprints): create, edit, start, close with carry-over of unfinished issues (to the next
  cycle by start date, to a chosen one, or back to the backlog) and delete.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    ConfirmDialog,
    Dialog,
    Field,
    Input,
    Select,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Textarea,
  } from "$lib/components";

  import { seg } from "../api";
  import { dateInput, day, nullable, options, statusVariant, words } from "../format";
  import { CYCLE_STATUSES, type Cycle, type List } from "../types";
  import Actions from "../ui/Actions.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
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

  async function load() {
    cycles = (await ws.api.get<List<Cycle>>(`/${seg(ws.projectId!)}/cycles`)).docs;
  }

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) ws.run(load);
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
          "Cycle saved"
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
          "Cycle created"
        );
      }
      open = false;
      await load();
    } catch {
      // Shown in the notice.
    } finally {
      saving = false;
    }
  }

  async function start(c: Cycle) {
    await ws.run(() => ws.api.patch(`/cycles/${seg(c.id)}`, { isActive: true, status: "started" }), "Cycle started");
    await load();
  }

  async function complete() {
    const body = carryOver === NEXT ? {} : { carryOverTo: carryOver === BACKLOG ? null : carryOver };
    await ws.act(() => ws.api.post(`/cycles/${seg(target!.id)}/complete`, body), "Cycle closed");
    await load();
  }

  async function remove() {
    await ws.act(() => ws.api.del(`/cycles/${seg(target!.id)}`), "Cycle deleted");
    await load();
  }

  const open_ = (c: Cycle) => c.status !== "completed" && c.status !== "cancelled";
  const carryOptions = $derived([
    { value: NEXT, label: "Next cycle by start date" },
    ...cycles.filter((c) => c.id !== target?.id && open_(c)).map((c) => ({ value: c.id, label: c.name })),
    { value: BACKLOG, label: "Backlog (no cycle)" },
  ]);
</script>

<Panel title="Cycles">
  {#snippet actions()}
    <Button size="sm" onclick={() => edit(null)}>New cycle</Button>
  {/snippet}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Cycle</TableHead>
        <TableHead>Dates</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Capacity</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each cycles as c (c.id)}
        <TableRow>
          <TableCell>
            {c.name}
            {#if c.isActive}<Badge variant="info">active</Badge>{/if}
          </TableCell>
          <TableCell>{day(c.startDate)} → {day(c.endDate)}</TableCell>
          <TableCell><Badge variant={statusVariant(c.status)}>{words(c.status)}</Badge></TableCell>
          <TableCell>{c.capacity ?? "—"}</TableCell>
          <TableCell>
            <Actions>
              <Button size="sm" variant="ghost" onclick={() => edit(c)}>Edit</Button>
              {#if open_(c) && !c.isActive}
                <Button size="sm" variant="ghost" onclick={() => start(c)}>Start</Button>
              {/if}
              {#if open_(c)}
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => {
                    target = c;
                    carryOver = NEXT;
                    confirmComplete = true;
                  }}>Close</Button
                >
              {/if}
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  target = c;
                  confirmDelete = true;
                }}>Delete</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={5} text="No cycles" />
      {/each}
    </TableBody>
  </Table>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New cycle"} closeLabel={CLOSE} size="lg">
  <FormGrid>
    <div class="wide">
      <Field label="Name" required>
        <Input bind:value={form.name} maxlength={200} />
      </Field>
    </div>
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
      <div class="wide">
        <Field label="Goal">
          <Textarea bind:value={form.goal} rows={2} maxlength={5000} />
        </Field>
      </div>
    {/if}
    <div class="wide">
      <Field label="Description">
        <Textarea bind:value={form.description} rows={2} maxlength={5000} />
      </Field>
    </div>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
    <Button
      loading={saving}
      disabled={!form.name.trim() || !form.startDate || !form.endDate || !!datesError}
      onclick={save}>Save</Button
    >
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
  onConfirm={remove}
/>
