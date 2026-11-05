<!-- Initiatives: goals with a target date, their issue counts and pace. -->
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
  import { dateInput, day, nullable, optional, options, statusVariant, words } from "../format";
  import { INITIATIVE_STATUSES, type Initiative, type List } from "../types";
  import Actions from "../ui/Actions.svelte";
  import Dot from "../ui/Dot.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let initiatives = $state<Initiative[]>([]);
  let editing = $state<Initiative | null>(null);
  let form = $state({ name: "", description: "", status: "planned", leadId: "", color: "#64748b", startDate: "", targetDate: "" });
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<Initiative | null>(null);
  let confirmDelete = $state(false);

  async function load() {
    initiatives = (await ws.api.get<List<Initiative>>(`/${seg(ws.projectId!)}/initiatives`)).docs;
  }

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) ws.run(load);
  });

  function edit(i: Initiative | null) {
    editing = i;
    form = {
      name: i?.name ?? "",
      description: i?.description ?? "",
      status: i?.status ?? "planned",
      leadId: i?.leadId ?? "",
      color: i?.color ?? "#64748b",
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
                color: form.color,
                startDate: nullable(form.startDate),
                targetDate: nullable(form.targetDate),
              })
            : ws.api.post(`/${seg(ws.projectId!)}/initiatives`, {
                name: form.name.trim(),
                description: optional(form.description),
                status: form.status,
                leadId: optional(form.leadId),
                color: form.color,
                startDate: optional(form.startDate),
                targetDate: optional(form.targetDate),
              }),
        editing ? "Initiative saved" : "Initiative created"
      );
      open = false;
      await load();
    } catch {
      // Shown in the notice.
    } finally {
      saving = false;
    }
  }

  async function remove() {
    await ws.act(() => ws.api.del(`/initiatives/${seg(deleting!.id)}`), "Initiative deleted");
    await load();
  }

  const paceOf = (i: Initiative) => (typeof i.pace === "string" ? i.pace : (i.pace?.status ?? "no_dates"));
  const paceVariant = (p: string) =>
    ({ on_track: "success", at_risk: "warning", off_track: "error", done: "success" })[p] as
      | "success"
      | "warning"
      | "error"
      | undefined;
</script>

<Panel title="Initiatives">
  {#snippet actions()}
    <Button size="sm" onclick={() => edit(null)}>New initiative</Button>
  {/snippet}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Initiative</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Lead</TableHead>
        <TableHead>Target</TableHead>
        <TableHead>Issues</TableHead>
        <TableHead>Pace</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each initiatives as i (i.id)}
        <TableRow>
          <TableCell><Dot color={i.color} />{i.name}</TableCell>
          <TableCell><Badge variant={statusVariant(i.status)}>{words(i.status)}</Badge></TableCell>
          <TableCell>{ws.memberLabel(i.leadId)}</TableCell>
          <TableCell>{day(i.targetDate)}</TableCell>
          <TableCell>{i.issues ? `${i.issues.completed}/${i.issues.total}` : "—"}</TableCell>
          <TableCell><Badge variant={paceVariant(paceOf(i))}>{words(paceOf(i))}</Badge></TableCell>
          <TableCell>
            <Actions>
              <Button size="sm" variant="ghost" onclick={() => edit(i)}>Edit</Button>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  deleting = i;
                  confirmDelete = true;
                }}>Delete</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={7} text="No initiatives" />
      {/each}
    </TableBody>
  </Table>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New initiative"} closeLabel={CLOSE} size="lg">
  <FormGrid>
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
  description="Its modules and issues stay, without an initiative."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={remove}
/>
