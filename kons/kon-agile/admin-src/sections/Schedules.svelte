<!-- Agent schedules: every N minutes the kon queues a piece of work for an agent member. -->
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
    Textarea,
    type DataColumn,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg } from "../api";
  import { moment } from "../format";
  import type { List, Schedule } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";
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
  const valid = $derived(!!form.name.trim() && !!form.prompt.trim() && !!form.agentId && !intervalError);

  const every = (minutes: number) =>
    minutes % 1440 === 0 ? `${minutes / 1440} d` : minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;

  const columns: DataColumn<Schedule>[] = [
    { key: "isActive", header: "On", sortable: true, value: (s) => (s.isActive ? "On" : "Off") },
    { key: "name", header: "Schedule", sortable: true, hideable: false },
    { key: "agentId", header: "Agent", sortable: true },
    { key: "intervalMinutes", header: "Every", sortable: true },
    { key: "lastRunAt", header: "Last run", sortable: true, value: (s) => moment(s.lastRunAt) },
    { key: "nextRunAt", header: "Next run", sortable: true, value: (s) => (s.isActive ? moment(s.nextRunAt) : "—") },
  ];

  const data = createLoad(async () => {
    schedules = (await ws.api.get<List<Schedule>>(`/${seg(ws.projectId!)}/schedules`)).docs;
  });

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) untrack(data.load);
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
        editing ? "Schedule saved" : "Schedule created",
        editing ? "Could not save the schedule" : "Could not create the schedule"
      );
      open = false;
      await data.load();
    } catch {
      // Shown in the toast.
    } finally {
      saving = false;
    }
  }

  async function toggle(s: Schedule, isActive: boolean) {
    await ws.run(
      () => ws.api.patch(`/schedules/${seg(s.id)}`, { isActive }),
      isActive ? "Schedule on" : "Schedule off",
      isActive ? "Could not turn the schedule on" : "Could not turn the schedule off"
    );
    await data.load();
  }

  async function remove() {
    await ws.act(() => ws.api.del(`/schedules/${seg(deleting!.id)}`), "Schedule deleted", "Could not delete the schedule");
    await data.load();
  }
</script>

<Panel title="Agent schedules">
  {#snippet status()}
    {#if data.ready}<Badge>{schedules.filter((s) => s.isActive).length} on</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button disabled={!ws.agentOptions.length} onclick={() => edit(null)}>New schedule</Button>
  {/snippet}
  <DataTable
    caption="Agent schedules"
    rows={schedules}
    {columns}
    rowKey="id"
    rowLabel={(s) => s.name}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(s, col)}
      {#if col.key === "isActive"}
        <!-- Keyed by the row: a change the API refused goes back to what the reloaded row says. -->
        {#key s}
          <Checkbox
            ariaLabel={`${s.name} is on`}
            checked={s.isActive}
            onchange={(e: Event) => toggle(s, (e.currentTarget as HTMLInputElement).checked)}
          />
        {/key}
      {:else if col.key === "name"}
        {s.name}
      {:else if col.key === "agentId"}
        <code>{s.agentId}</code>
      {:else if col.key === "intervalMinutes"}
        {every(s.intervalMinutes)}
      {:else}
        <span class="nowrap">{col.value?.(s)}</span>
      {/if}
    {/snippet}
    {#snippet rowActions(s)}
      <RowMenu
        label={`Actions: ${s.name}`}
        items={[
          { label: "Edit", onSelect: () => edit(s) },
          {
            label: "Delete",
            danger: true,
            separated: true,
            onSelect: () => {
              deleting = s;
              confirmDelete = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      {#if ws.agentOptions.length}
        <EmptyState size="sm" level={null} title="No schedules yet" actionLabel="New schedule" onAction={() => edit(null)} />
      {:else}
        <EmptyState size="sm" level={null} title="No agent members" description="A schedule runs for an agent: add one in the Members tab." />
      {/if}
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New schedule"} closeLabel={CLOSE} size="lg">
  <FormGrid label={editing ? `Edit ${editing.name}` : "New schedule"} onsubmit={() => valid && !saving && save()}>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={100} />
    </Field>
    <Field label="Agent" required>
      <Select bind:value={form.agentId} options={ws.agentOptions} disabled={!!editing} />
    </Field>
    <Field label="Every (minutes)" required error={intervalError}>
      <Input type="number" min="15" max="43200" bind:value={form.intervalMinutes} />
    </Field>
    <div>
      <Checkbox bind:checked={form.isActive} label="On" />
    </div>
    <Field label="Prompt" required class="wide">
      <Textarea bind:value={form.prompt} rows={4} maxlength={10000} />
    </Field>
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
  .nowrap {
    white-space: nowrap;
  }

  code {
    white-space: nowrap;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }
</style>
