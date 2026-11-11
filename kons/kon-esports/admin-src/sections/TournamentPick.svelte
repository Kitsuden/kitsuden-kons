<!-- Chooses the tournament the booth operates: nobody passes it one. -->
<script lang="ts">
  import { Badge, Button, Field, Select } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import Loadable from "../ui/Loadable.svelte";
  import Panel from "../ui/Panel.svelte";

  const booth = useBooth();

  const options = $derived(
    booth.tournaments.map((t) => ({
      value: t.id,
      label: `${t.title}${t.status && t.status !== "Published" ? ` · ${t.status}` : ""}`,
    }))
  );

  let selected = $state("");
  $effect(() => {
    selected = booth.tid ?? "";
  });
</script>

<Panel title="Tournament">
  {#snippet status()}
    {#if booth.tournamentState}<Badge>{booth.tournamentState}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button variant="outline" onclick={() => booth.boot()}>Reload</Button>
  {/snippet}
  <!-- An empty dropdown does not tell "there are no tournaments" from "it did not load". -->
  <Loadable
    load={booth.picker}
    lines={2}
    errorTitle="The tournaments did not load"
    empty={booth.tournaments.length === 0}
    emptyTitle="No tournaments yet"
    emptyDescription="Create one in the Tournaments tab and come back here. This booth operates a tournament that already exists; it does not create it."
  >
    <div class="pick">
      <Field label="Tournament to run">
        <Select
          bind:value={selected}
          {options}
          onchange={(e: Event) => booth.choose((e.currentTarget as HTMLSelectElement).value || null)}
        />
      </Field>
    </div>
  </Loadable>
</Panel>

<style>
  .pick :global(.ta-field) {
    max-width: 26rem;
  }
</style>
