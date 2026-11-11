<!--
  One set: its slot, the two sides and, if the server sent its real row, station and stream.
  Pressing a NAME reports the winner: it is 95% of what is done in an afternoon, so it is the
  biggest action. A slot with no occupant is TBD and cannot be pressed.
-->
<script lang="ts">
  import { Button, Select } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import type { BracketSet } from "../types";

  const { set }: { set: BracketSet } = $props();
  const booth = useBooth();

  const row = $derived(set.rowId ? (booth.rowById.get(set.rowId) ?? null) : null);
  const queued = $derived(row?.streamQueuePosition !== null && row?.streamQueuePosition !== undefined);
  const stationOptions = $derived([
    { value: "", label: "—" },
    ...booth.stations.map((s) => ({ value: s.id, label: s.name })),
  ]);

  let station = $state("");
  $effect(() => {
    station = row?.stationId ?? "";
  });
</script>

{#snippet side(participantId: string | null | undefined)}
  {@const entry = participantId ? booth.names[participantId] : null}
  <button
    type="button"
    class="pick"
    class:tbd={!entry}
    class:won={!!participantId && set.winnerId === participantId}
    disabled={!participantId}
    onclick={() => booth.report(set, participantId)}
  >
    {entry?.name || "TBD"}
  </button>
{/snippet}

<li class="set">
  <span class="id">{set.id}</span>
  {@render side(set.participants[0])}
  <span class="vs">vs</span>
  {@render side(set.participants[1])}
  <div class="ops">
    {#if set.rowId}
      {#if booth.stations.length > 0}
        <Select
          size="sm"
          aria-label="Station where it is played"
          title="Station where it is played"
          bind:value={station}
          options={stationOptions}
          onchange={(e: Event) => booth.assignStation(set, (e.currentTarget as HTMLSelectElement).value || null)}
        />
      {/if}
      <Button
        size="sm"
        variant={queued ? "outline" : "secondary"}
        class={queued ? "queued" : ""}
        title={queued ? "Take this set out of the broadcast queue" : "Put this set in the broadcast queue"}
        aria-pressed={queued}
        onclick={() => booth.queueStream(set, !queued)}
      >
        {queued ? `Stream #${row?.streamQueuePosition}` : "Stream"}
      </Button>
    {/if}
  </div>
</li>

<style>
  .set {
    display: grid;
    grid-template-columns: 4rem 1fr auto 1fr auto;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.75rem;
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-surface));
  }

  .id {
    font-family: var(--ta-font-mono);
    font-size: 0.6875rem;
    color: rgb(var(--ta-text-dim));
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pick {
    font: inherit;
    font-size: 0.875rem;
    padding: 0.45rem 0.7rem;
    text-align: left;
    width: 100%;
    cursor: pointer;
    border-radius: var(--ta-radius);
    background: transparent;
    border: 1px solid transparent;
    color: rgb(var(--ta-text));
  }

  .pick:not(:disabled):hover,
  .pick:focus-visible {
    background: rgb(var(--ta-bg));
    border-color: rgb(var(--ta-accent));
    outline: none;
  }

  .pick:disabled {
    cursor: not-allowed;
  }

  .pick.won {
    color: rgb(var(--ta-accent-hover));
    font-weight: 700;
    background: rgb(var(--ta-accent) / 0.08);
  }

  .pick.tbd {
    color: rgb(var(--ta-text-dim));
    font-style: italic;
  }

  .vs {
    font-size: 0.625rem;
    color: rgb(var(--ta-text-dim));
  }

  /* A fixed width keeps the names of every set in the same columns. */
  .ops {
    display: flex;
    gap: 0.375rem;
    align-items: center;
    justify-content: flex-end;
    min-width: 13rem;
  }

  .ops :global(.ta-select) {
    width: auto;
  }

  .ops :global(.queued) {
    border-color: rgb(var(--ta-accent));
    color: rgb(var(--ta-accent-hover));
  }

  @media (max-width: 640px) {
    .set {
      grid-template-columns: 1fr auto 1fr;
    }

    .id,
    .ops {
      grid-column: 1 / -1;
    }
  }
</style>
