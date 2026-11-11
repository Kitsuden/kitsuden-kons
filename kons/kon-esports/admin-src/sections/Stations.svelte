<!-- Stations: where each set is played. -->
<script lang="ts">
  import { Badge, Button, DataTable, EmptyState, Field, Input, Select, type DataColumn } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import type { Station } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import Panel from "../ui/Panel.svelte";

  const booth = useBooth();

  const KINDS = [
    { value: "physical", label: "In person" },
    { value: "lobby", label: "Online lobby" },
  ];
  const kindOf = (s: Station) => KINDS.find((k) => k.value === s.kind)?.label ?? s.kind;

  const columns: DataColumn<Station>[] = [
    { key: "name", header: "Station", sortable: true, hideable: false },
    { key: "kind", header: "Kind", sortable: true, value: kindOf },
    { key: "accessDetails", header: "Access", value: (s) => s.accessDetails || "—" },
  ];

  let name = $state("");
  let kind = $state("physical");
  let access = $state("");
  let saving = $state(false);

  async function add() {
    saving = true;
    try {
      if (await booth.addStation(name, kind, access)) {
        name = "";
        access = "";
      }
    } finally {
      saving = false;
    }
  }
</script>

<Panel title="Stations" description="Where each set is played.">
  {#snippet status()}
    {#if booth.loads.stations.ready}
      <Badge>{booth.stations.length === 1 ? "1 station" : `${booth.stations.length} stations`}</Badge>
    {/if}
  {/snippet}
  <DataTable
    caption="Stations"
    rows={booth.stations}
    {columns}
    rowKey="id"
    rowLabel={(s) => s.name}
    loading={booth.loads.stations.loading}
    error={booth.loads.stations.error}
    onRetry={booth.loads.stations.load}
  >
    {#snippet empty()}
      <EmptyState
        size="sm"
        level={null}
        title="No stations yet"
        description="Add the first one with the form below, then assign it to a set."
      />
    {/snippet}
  </DataTable>

  <h3 class="sub">Add a station</h3>
  <FormGrid label="Add a station" onsubmit={add}>
    <Field label="Name" required>
      <Input placeholder="Setup 1, Lobby A…" bind:value={name} />
    </Field>
    <Field label="Kind">
      <Select bind:value={kind} options={KINDS} />
    </Field>
    <Field label="Code or access (optional)">
      <Input bind:value={access} />
    </Field>
    {#snippet actions()}
      <Button type="submit" variant="secondary" loading={saving}>Add station</Button>
    {/snippet}
  </FormGrid>
</Panel>

<style>
  .sub {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
  }
</style>
