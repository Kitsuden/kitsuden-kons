<!-- Where the options the reader chooses come from. -->
<script lang="ts">
  import { Button } from "$lib/components";

  import { useEditor } from "../editor.svelte";
  import Panel from "../ui/Panel.svelte";
  import SlotCard from "./SlotCard.svelte";

  const editor = useEditor();

  function add() {
    editor.def.slots.push({
      id: `slot-${editor.def.slots.length + 1}`,
      name: "",
      capacity: 1,
      options: [],
    });
  }
</script>

<Panel title="Slots">
  {#snippet actions()}
    <Button size="sm" variant="secondary" onclick={add}>Add slot</Button>
  {/snippet}

  {#if editor.def.slots.length}
    <div class="slots">
      {#each editor.def.slots as slot, index (slot)}
        <SlotCard {slot} {index} />
      {/each}
    </div>
  {:else}
    <p class="empty">No slots. The reader would have nothing to choose.</p>
  {/if}
</Panel>

<style>
  .slots {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .empty {
    margin: 0;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
