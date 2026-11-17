<!--
  Work the bot will do later in one server: giveaway draws, reminders, scheduled messages, birthday
  checks, a blueprint's `later` steps. Soonest first; one can be cancelled. A recurring job a module
  declares comes back while that module stays on, so the dialog says so.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import { Badge, Button, ConfirmDialog, DataTable, Dialog, type DataColumn } from "$lib/components";

  import { useApi, when } from "../../context";
  import type { ScheduleRow } from "../../types";
  import { CANCEL, CLOSE } from "../../ui/labels";
  import Panel from "../../ui/Panel.svelte";
  import RowMenu from "../../ui/RowMenu.svelte";
  import { createLoad } from "../../ui/load.svelte";
  import { failed, toast } from "../../ui/notify";
  import { toJson } from "../../ui/settings";

  const { guildId, moduleName }: { guildId: string; moduleName: (id: string) => string } = $props();
  const api = useApi();

  let rows = $state<ScheduleRow[]>([]);
  const load = createLoad(async () => {
    rows = (await api.get<{ docs: ScheduleRow[] }>(`/guilds/${guildId}/schedules`)).docs;
  });
  $effect(() => {
    void guildId;
    untrack(load.load);
  });

  const columns: DataColumn<ScheduleRow>[] = [
    { key: "runAt", header: "Runs", sortable: true, value: (r) => when(r.runAt) },
    { key: "module", header: "Module", value: (r) => moduleName(r.moduleId) },
    { key: "key", header: "Job" },
    { key: "recurring", header: "Repeats", width: "6rem" },
  ];

  let viewing = $state<ScheduleRow | null>(null);
  let viewOpen = $state(false);
  let cancelling = $state<ScheduleRow | null>(null);
  let confirmOpen = $state(false);

  async function cancel() {
    if (!cancelling) return;
    try {
      await api.del(`/guilds/${guildId}/schedules/${cancelling.id}`);
      toast.success("Cancelled");
      await load.load();
    } catch (e) {
      failed("Could not cancel it", e);
    }
  }
</script>

<Panel title="Scheduled work" description="What the bot will do later in this server, soonest first.">
  {#snippet status()}
    <Badge>{rows.length}</Badge>
  {/snippet}
  {#snippet actions()}
    <Button variant="ghost" size="sm" onclick={load.load}>Refresh</Button>
  {/snippet}
  <DataTable
    caption="Scheduled work"
    {rows}
    {columns}
    rowKey="id"
    rowLabel={(r) => r.key}
    loading={load.loading}
    error={load.error}
    onRetry={load.load}
    emptyText="Nothing scheduled."
  >
    {#snippet cell(r, col)}
      {#if col.key === "key"}
        <code>{r.key}</code>
      {:else if col.key === "recurring"}
        {#if r.recurring}<Badge variant="info">Recurring</Badge>{:else}<span class="quiet">Once</span>{/if}
      {:else}
        {col.value?.(r)}
      {/if}
    {/snippet}
    {#snippet rowActions(r)}
      <RowMenu
        label={`Actions: ${r.key}`}
        items={[
          { label: "Details", onSelect: () => ((viewing = r), (viewOpen = true)) },
          { label: "Cancel", danger: true, separated: true, onSelect: () => ((cancelling = r), (confirmOpen = true)) },
        ]}
      />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open={viewOpen} title={viewing ? viewing.key : "Job"} closeLabel={CLOSE}>
  {#if viewing}
    <p class="quiet">{moduleName(viewing.moduleId)} · {when(viewing.runAt)}</p>
    {#if viewing.spec}
      <h3>Repeats</h3>
      <pre>{toJson(viewing.spec)}</pre>
    {/if}
    <h3>Data</h3>
    <pre>{toJson(viewing.payload)}</pre>
  {/if}
</Dialog>

<ConfirmDialog
  bind:open={confirmOpen}
  title={cancelling ? `Cancel ${cancelling.key}?` : "Cancel?"}
  description={cancelling?.recurring
    ? "It repeats: while its module stays on it is planned again. Switch the module off, or change its settings, to stop it for good."
    : "The bot will not do it. This cannot be undone."}
  confirmLabel="Cancel the job"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={cancel}
/>

<style>
  .quiet {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  h3 {
    margin: 1rem 0 0.375rem;
    font-size: 0.875rem;
    font-weight: 600;
  }

  pre {
    margin: 0;
    padding: 0.75rem;
    overflow: auto;
    max-height: 16rem;
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-muted));
    font-size: 0.75rem;
  }
</style>
