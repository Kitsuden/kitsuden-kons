<!-- Agent schedules: every N minutes the kon queues a piece of work for an agent member. -->
<script lang="ts">
  import {
    Button,
    Checkbox,
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
  import { moment } from "../format";
  import type { List, Schedule } from "../types";
  import Actions from "../ui/Actions.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let schedules = $state<Schedule[]>([]);
  let editing = $state<Schedule | null>(null);
  let form = $state({ agentId: "", name: "", prompt: "", intervalMinutes: "60", isActive: true });
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<Schedule | null>(null);
  let confirmDelete = $state(false);

  const interval = $derived(Number(form.intervalMinutes));
  const intervalError = $derived(
    Number.isInteger(interval) && interval >= 15 && interval <= 43200 ? undefined : "From 15 to 43200 minutes"
  );

  async function load() {
    schedules = (await ws.api.get<List<Schedule>>(`/${seg(ws.projectId!)}/schedules`)).docs;
  }

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) ws.run(load);
  });

  function edit(s: Schedule | null) {
    editing = s;
    form = {
      agentId: s?.agentId ?? ws.agentOptions[0]?.value ?? "",
      name: s?.name ?? "",
      prompt: s?.prompt ?? "",
      intervalMinutes: String(s?.intervalMinutes ?? 60),
      isActive: s?.isActive ?? true,
    };
    open = true;
  }

  async function save() {
    // The agent of a schedule is fixed: the kon's update leaves it out.
    const body = {
      ...(editing ? {} : { agentId: form.agentId }),
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      intervalMinutes: interval,
      isActive: form.isActive,
    };
    saving = true;
    try {
      await ws.act(
        () =>
          editing
            ? ws.api.patch(`/schedules/${seg(editing.id)}`, body)
            : ws.api.post(`/${seg(ws.projectId!)}/schedules`, body),
        editing ? "Schedule saved" : "Schedule created"
      );
      open = false;
      await load();
    } catch {
      // Shown in the notice.
    } finally {
      saving = false;
    }
  }

  async function toggle(s: Schedule, isActive: boolean) {
    await ws.run(() => ws.api.patch(`/schedules/${seg(s.id)}`, { isActive }), isActive ? "Schedule on" : "Schedule off");
    await load();
  }

  async function remove() {
    await ws.act(() => ws.api.del(`/schedules/${seg(deleting!.id)}`), "Schedule deleted");
    await load();
  }

  const every = (minutes: number) =>
    minutes % 1440 === 0 ? `${minutes / 1440} d` : minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
</script>

<Panel title="Agent schedules">
  {#snippet actions()}
    <Button size="sm" disabled={!ws.agentOptions.length} onclick={() => edit(null)}>New schedule</Button>
  {/snippet}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>On</TableHead>
        <TableHead>Schedule</TableHead>
        <TableHead>Agent</TableHead>
        <TableHead>Every</TableHead>
        <TableHead>Last run</TableHead>
        <TableHead>Next run</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each schedules as s (s.id)}
        <TableRow>
          <TableCell>
            <Checkbox
              ariaLabel={`${s.name} is on`}
              checked={s.isActive}
              onchange={(e: Event) => toggle(s, (e.currentTarget as HTMLInputElement).checked)}
            />
          </TableCell>
          <TableCell>{s.name}</TableCell>
          <TableCell><code>{s.agentId}</code></TableCell>
          <TableCell>{every(s.intervalMinutes)}</TableCell>
          <TableCell>{moment(s.lastRunAt)}</TableCell>
          <TableCell>{s.isActive ? moment(s.nextRunAt) : "—"}</TableCell>
          <TableCell>
            <Actions>
              <Button size="sm" variant="ghost" onclick={() => edit(s)}>Edit</Button>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  deleting = s;
                  confirmDelete = true;
                }}>Delete</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={7} text={ws.agentOptions.length ? "No schedules" : "No agent members"} />
      {/each}
    </TableBody>
  </Table>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New schedule"} closeLabel={CLOSE} size="lg">
  <FormGrid>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={100} />
    </Field>
    <Field label="Agent" required>
      <Select bind:value={form.agentId} options={ws.agentOptions} disabled={!!editing} />
    </Field>
    <Field label="Every (minutes)" required error={intervalError}>
      <Input type="number" min="15" max="43200" bind:value={form.intervalMinutes} />
    </Field>
    <div class="check"><Checkbox bind:checked={form.isActive} label="On" /></div>
    <div class="wide">
      <Field label="Prompt" required>
        <Textarea bind:value={form.prompt} rows={4} maxlength={10000} />
      </Field>
    </div>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
    <Button
      loading={saving}
      disabled={!form.name.trim() || !form.prompt.trim() || !form.agentId || !!intervalError}
      onclick={save}>Save</Button
    >
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.name ?? ""}?`}
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={remove}
/>

<style>
  code {
    white-space: nowrap;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }

  .check {
    padding-top: 1.6rem;
  }
</style>
