<!--
  Swiss: its own standings (with OMW, the tiebreaker that decides a top 8), pairing the next
  round and the cut.
-->
<script lang="ts">
  import { Alert, Badge, Button, DataTable, EmptyState, type DataColumn } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import type { SwissStanding } from "../types";
  import Panel from "../ui/Panel.svelte";

  const booth = useBooth();

  const pct = (n: number | undefined) => `${Math.round((n ?? 0) * 100)}%`;
  const record = (s: SwissStanding) => `${s.record?.wins ?? 0}-${s.record?.losses ?? 0}-${s.record?.draws ?? 0}`;
  const swiss = $derived(booth.swiss);

  const columns: DataColumn<SwissStanding>[] = [
    { key: "place", header: "Place", sortable: true, align: "right", value: (s) => s.place ?? "" },
    {
      key: "participant",
      header: "Participant",
      sortable: true,
      value: (s) => booth.name(s.participantId),
      hideable: false,
    },
    { key: "record", header: "W-L-D", value: record },
    { key: "points", header: "Points", sortable: true, align: "right", value: (s) => s.record?.points ?? 0 },
    { key: "omw", header: "OMW", sortable: true, align: "right", value: (s) => s.omw ?? 0 },
  ];
</script>

<Panel title="Swiss">
  {#snippet status()}
    {#if swiss}
      <Badge variant={swiss.complete ? "success" : "info"} dot>
        {swiss.complete ? `Finished · ${swiss.totalRounds} rounds` : `Round ${swiss.round} of ${swiss.totalRounds}`}
      </Badge>
    {/if}
  {/snippet}
  {#snippet actions()}
    <Button variant="outline" onclick={() => booth.swissCut()}>See the cut</Button>
    <Button disabled={swiss?.complete ?? false} onclick={() => booth.swissNextRound()}>Pair next round</Button>
  {/snippet}
  {#if booth.notice.swiss}
    {@const notice = booth.notice.swiss}
    <Alert
      variant={notice.variant}
      title={notice.title}
      dismissLabel="Dismiss"
      onDismiss={() => (booth.notice.swiss = null)}>{notice.text}</Alert
    >
  {/if}
  <DataTable
    caption="Swiss standings"
    rows={swiss?.standings ?? []}
    {columns}
    rowKey="participantId"
    rowLabel={(s) => booth.name(s.participantId)}
    pageSize={32}
    loading={booth.loads.swiss.loading}
    error={booth.loads.swiss.error}
    onRetry={booth.loads.swiss.load}
  >
    {#snippet cell(s, col)}
      {#if col.key === "omw"}{pct(s.omw)}{:else}{col.value?.(s)}{/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState
        size="sm"
        level={null}
        title="No results yet"
        description="The standings fill in as the sets of the first round are reported."
      />
    {/snippet}
  </DataTable>
</Panel>
