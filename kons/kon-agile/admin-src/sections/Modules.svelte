<!-- Modules (epics): status, lead, dates and the initiative they serve. -->
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
  import { MODULE_STATUSES, type Initiative, type List, type Module } from "../types";
  import Actions from "../ui/Actions.svelte";
  import Dot from "../ui/Dot.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let modules = $state<Module[]>([]);
  let initiatives = $state<Initiative[]>([]);
  let editing = $state<Module | null>(null);
  let form = $state({
    name: "",
    description: "",
    color: "#64748b",
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

  async function load() {
    const id = seg(ws.projectId!);
    const [m, i] = await Promise.all([
      ws.api.get<List<Module>>(`/${id}/modules`),
      ws.api.get<List<Initiative>>(`/${id}/initiatives`),
    ]);
    modules = m.docs;
    initiatives = i.docs;
  }

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) ws.run(load);
  });

  function edit(m: Module | null) {
    editing = m;
    form = {
      name: m?.name ?? "",
      description: m?.description ?? "",
      color: m?.color ?? "#64748b",
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
              color: form.color,
              status: form.status,
              leadId: nullable(form.leadId),
              startDate: nullable(form.startDate),
              targetDate: nullable(form.targetDate),
              initiativeId: nullable(form.initiativeId),
            }),
          "Module saved"
        );
      } else {
        await ws.act(
          () =>
            ws.api.post(`/${seg(ws.projectId!)}/modules`, {
              name: form.name.trim(),
              description: form.description.trim() || undefined,
              color: form.color,
            }),
          "Module created"
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

  async function remove() {
    await ws.act(() => ws.api.del(`/modules/${seg(deleting!.id)}`), "Module deleted");
    await load();
  }

  const initiativeName = (id: string | null | undefined) => initiatives.find((i) => i.id === id)?.name ?? "—";
</script>

<Panel title="Modules">
  {#snippet actions()}
    <Button size="sm" onclick={() => edit(null)}>New module</Button>
  {/snippet}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Module</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Lead</TableHead>
        <TableHead>Dates</TableHead>
        <TableHead>Initiative</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each modules as m (m.id)}
        <TableRow>
          <TableCell><Dot color={m.color} />{m.name}</TableCell>
          <TableCell><Badge variant={statusVariant(m.status)}>{words(m.status)}</Badge></TableCell>
          <TableCell>{ws.memberLabel(m.leadId)}</TableCell>
          <TableCell>{day(m.startDate)} → {day(m.targetDate)}</TableCell>
          <TableCell>{initiativeName(m.initiativeId)}</TableCell>
          <TableCell>
            <Actions>
              <Button size="sm" variant="ghost" onclick={() => edit(m)}>Edit</Button>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  deleting = m;
                  confirmDelete = true;
                }}>Delete</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={6} text="No modules" />
      {/each}
    </TableBody>
  </Table>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New module"} closeLabel={CLOSE} size="lg">
  <FormGrid>
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
      <div class="wide">
        <Field label="Initiative">
          <Select bind:value={form.initiativeId} options={initiatives.map((i) => ({ value: i.id, label: i.name }))} placeholder="None" />
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
  onConfirm={remove}
/>
