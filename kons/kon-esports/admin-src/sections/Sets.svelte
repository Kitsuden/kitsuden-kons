<!-- The sets still open, whatever the format keeps them in. -->
<script lang="ts">
  import { Badge } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import Loadable from "../ui/Loadable.svelte";
  import Panel from "../ui/Panel.svelte";
  import SetRow from "./SetRow.svelte";

  const booth = useBooth();
  const nothing = $derived(booth.setsEmpty);
</script>

<Panel title="Sets">
  {#snippet status()}
    {#if booth.loads.sets.ready}<Badge>{booth.openSets.length} open</Badge>{/if}
  {/snippet}
  <Loadable
    load={booth.loads.sets}
    errorTitle="The sets did not load"
    lines={5}
    empty={booth.openSets.length === 0}
    emptyTitle={nothing.title}
    emptyDescription={nothing.description}
    actionLabel={nothing.goTo?.label}
    onAction={nothing.goTo ? () => (booth.tab = nothing.goTo!.tab) : undefined}
  >
    <ul class="sets" aria-label="Open sets">
      {#each booth.openSets as set (set.rowId ?? set.id)}
        <SetRow {set} />
      {/each}
    </ul>
  </Loadable>
</Panel>

<style>
  .sets {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
</style>
