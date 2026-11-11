<!--
  One set: its slot, the two sides and, if the server sent its real row, station and stream.
  Reporting the winner is 95% of what is done in an afternoon, so each side is the biggest button
  of the row. A slot with no occupant is still to be decided and has no button.
-->
<script lang="ts">
  import { Badge, Button, Select, Toggle } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import type { BracketSet } from "../types";

  const { set }: { set: BracketSet } = $props();
  const booth = useBooth();

  const row = $derived(set.rowId ? (booth.rowById.get(set.rowId) ?? null) : null);
  const queued = $derived(row?.streamQueuePosition !== null && row?.streamQueuePosition !== undefined);
  const ready = $derived(set.participants.slice(0, 2).every(Boolean) && set.participants.length >= 2);
  const stationOptions = $derived([
    { value: "", label: "No station" },
    ...booth.stations.map((s) => ({ value: s.id, label: s.name })),
  ]);

  let station = $state("");
  $effect(() => {
    station = row?.stationId ?? "";
  });

  let pressed = $state(false);
  $effect(() => {
    pressed = queued;
  });

  async function queue(enter: boolean) {
    await booth.queueStream(set, enter);
    // What the server kept, whether the call worked or not.
    pressed = queued;
  }
</script>

{#snippet side(participantId: string | null | undefined)}
  {@const entry = participantId ? booth.names[participantId] : null}
  {#if participantId}
    <Button
      variant="outline"
      class="side"
      ariaLabel={`${entry?.name ?? booth.name(participantId)} wins ${set.id}`}
      onclick={() => booth.report(set, participantId)}
    >
      {entry?.name ?? booth.name(participantId)} wins
    </Button>
  {:else}
    <span class="tbd">To be decided</span>
  {/if}
{/snippet}

<li class="set" aria-label={`Set ${set.id}`}>
  <div class="slot">
    <span class="id">{set.id}</span>
    <Badge variant={ready ? "success" : "default"} dot>{ready ? "Ready" : "Waiting for a player"}</Badge>
  </div>
  <div class="sides">
    {@render side(set.participants[0])}
    <span class="vs">vs</span>
    {@render side(set.participants[1])}
  </div>
  {#if set.rowId}
    <div class="ops">
      {#if booth.stations.length > 0}
        <Select
          size="sm"
          width="auto"
          aria-label={`Station of ${set.id}`}
          bind:value={station}
          options={stationOptions}
          onchange={(e: Event) => booth.assignStation(set, (e.currentTarget as HTMLSelectElement).value || null)}
        />
      {/if}
      <Toggle size="sm" bind:pressed ariaLabel={`Broadcast queue of ${set.id}`} onchange={queue}>
        Broadcast queue: {queued ? `#${row?.streamQueuePosition}` : "off"}
      </Toggle>
    </div>
  {/if}
</li>

<style>
  .set {
    display: grid;
    grid-template-columns: minmax(8rem, 12rem) minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.5rem 1rem;
    padding: 0.75rem 0;
    border-top: 1px solid rgb(var(--ta-border));
  }

  .set:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .set:last-child {
    padding-bottom: 0;
  }

  .slot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.375rem 0.5rem;
    min-width: 0;
  }

  .id {
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
    color: rgb(var(--ta-text));
    overflow-wrap: anywhere;
  }

  .sides {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .sides :global(.side) {
    width: 100%;
    min-width: 0;
    white-space: normal;
  }

  .tbd {
    font-size: 0.8125rem;
    text-align: center;
    color: rgb(var(--ta-text-dim));
  }

  .vs {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .ops {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  @media (max-width: 760px) {
    .set {
      grid-template-columns: minmax(0, 1fr);
    }

    .ops {
      justify-content: flex-start;
    }
  }
</style>
