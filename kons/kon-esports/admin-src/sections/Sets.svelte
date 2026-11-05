<!-- The sets still open, whatever the format keeps them in. -->
<script lang="ts">
  import { useBooth } from "../store.svelte";
  import Empty from "../ui/Empty.svelte";
  import Messages from "../ui/Messages.svelte";
  import Section from "../ui/Section.svelte";
  import SetRow from "./SetRow.svelte";

  const { off = false }: { off?: boolean } = $props();
  const booth = useBooth();
</script>

<Section title="Sets" {off}>
  {#snippet meta()}Press the winner's name{/snippet}
  {#if booth.openSets.length}
    <ul class="sets">
      {#each booth.openSets as set (set.rowId ?? set.id)}
        <SetRow {set} />
      {/each}
    </ul>
  {:else if booth.setsEmpty}
    <Empty text={booth.setsEmpty} />
  {/if}
  <Messages scope="sets" />
</Section>

<style>
  .sets {
    display: grid;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
</style>
