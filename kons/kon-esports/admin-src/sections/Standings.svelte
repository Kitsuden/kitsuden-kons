<!--
  Who is still alive, from the bracket response. It is NOT a ranking (there is no placement):
  it arrives sorted by status and losses, and any column can sort it.
-->
<script lang="ts">
  import { Badge, DataTable, EmptyState, type DataColumn } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import type { AliveRow } from "../types";
  import Panel from "../ui/Panel.svelte";

  const booth = useBooth();

  const ORDER: Record<string, number> = { champion: 0, active: 1, eliminated: 2 };
  const TAG: Record<string, { label: string; variant: "accent" | "success" | "default" }> = {
    champion: { label: "Champion", variant: "accent" },
    active: { label: "Still alive", variant: "success" },
    eliminated: { label: "Eliminated", variant: "default" },
  };

  const nameOf = (s: AliveRow) => s.name || booth.name(s.participantId);

  const rows = $derived(
    [...booth.alive].sort((a, b) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3) || a.losses - b.losses)
  );
  const alive = $derived(booth.alive.filter((s) => s.status !== "eliminated").length);

  const columns: DataColumn<AliveRow>[] = [
    { key: "participant", header: "Participant", sortable: true, value: nameOf, hideable: false },
    { key: "losses", header: "Losses", sortable: true, align: "right" },
    { key: "status", header: "Status", sortable: true, value: (s) => ORDER[s.status] ?? 3 },
  ];
</script>

<Panel title="Participants" description="Who is still alive in the bracket.">
  {#snippet status()}
    {#if booth.loads.sets.ready}<Badge>{alive} alive</Badge>{/if}
  {/snippet}
  <DataTable
    caption="Participants of the bracket"
    {rows}
    {columns}
    rowKey="participantId"
    rowLabel={nameOf}
    pageSize={32}
    loading={booth.loads.sets.loading}
    error={booth.loads.sets.error}
    onRetry={booth.loads.sets.load}
  >
    {#snippet cell(s, col)}
      {#if col.key === "status"}
        {@const tag = TAG[s.status] ?? { label: s.status, variant: "default" as const }}
        <Badge variant={tag.variant} dot>{tag.label}</Badge>
      {:else if col.key === "participant"}
        {nameOf(s)}
      {:else}
        {s.losses}
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState
        size="sm"
        level={null}
        title="No participants in the bracket yet"
        description="They appear here once the bracket is generated."
      />
    {/snippet}
  </DataTable>
</Panel>
