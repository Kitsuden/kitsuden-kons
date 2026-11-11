<!-- Where the options the reader chooses come from. -->
<script lang="ts">
  import { Badge, Button, EmptyState } from "$lib/components";

  import { useEditor } from "../editor.svelte";
  import Panel from "../ui/Panel.svelte";
  import SlotCard from "./SlotCard.svelte";

  const editor = useEditor();

  const count = $derived(editor.def.slots.length);

  function add() {
    editor.def.slots.push({
      id: `slot-${editor.def.slots.length + 1}`,
      name: "",
      capacity: 1,
      options: [],
    });
  }
</script>

<Panel title="Slots" description="What the reader chooses, and the dataset each choice comes from.">
  {#snippet status()}
    <Badge>{count} {count === 1 ? "slot" : "slots"}</Badge>
  {/snippet}
  {#snippet actions()}
    {#if count}<Button size="sm" variant="outline" onclick={add}>Add slot</Button>{/if}
  {/snippet}

  {#if count}
    <div class="slots">
      {#each editor.def.slots as slot, index (slot)}
        <SlotCard {slot} {index} />
      {/each}
    </div>
  {:else}
    <EmptyState
      size="sm"
      level={3}
      title="No slots yet"
      description="Without slots the reader has nothing to choose."
      actionLabel="Add slot"
      onAction={add}
    />
  {/if}
</Panel>

<style>
  .slots {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
</style>
