<!--
  Check-in: the counter, the window, resolving absentees, and every participant as a chip that
  marks them present (or undoes it) from the table: at an in-person event half the room does not
  use a phone.
-->
<script lang="ts">
  import { Button, Input } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import Empty from "../ui/Empty.svelte";
  import Messages from "../ui/Messages.svelte";
  import Row from "../ui/Row.svelte";
  import Section from "../ui/Section.svelte";

  const { off = false }: { off?: boolean } = $props();
  const booth = useBooth();

  const STATE: Record<string, string> = {
    disabled: "unused",
    scheduled: "scheduled",
    open: "OPEN",
    closed: "closed",
  };

  let opens = $state("");
  let closes = $state("");

  const data = $derived(booth.checkIn);
  const missing = $derived(data?.summary.missingIds ?? []);
  const present = $derived(data?.summary.checkedInIds ?? []);
</script>

<Section title="Check-in" {off}>
  {#snippet meta()}{data ? (STATE[data.state] ?? "") : ""}{/snippet}
  <div class="counter">
    <span class="big">{data ? data.summary.checkedIn : "—"}<small>/{data ? data.summary.total : "—"}</small></span>
    {#if data && data.countdown !== null}
      <span class="countdown">{Math.ceil(data.countdown / 60)} min</span>
    {/if}
  </div>
  <Row>
    <Input type="datetime-local" aria-label="Check-in opens" bind:value={opens} />
    <Input type="datetime-local" aria-label="Check-in closes" bind:value={closes} />
    <Button variant="secondary" onclick={() => booth.setWindow(opens, closes)}>Schedule</Button>
  </Row>
  <Row>
    <Button variant="danger" onclick={() => booth.resolveAbsentees("drop")}>Remove absentees</Button>
    <Button variant="secondary" onclick={() => booth.resolveAbsentees("dq")}>DQ absentees</Button>
  </Row>
  <p class="muted">
    <strong>Remove</strong> before generating the bracket (byes fall where they should).
    <strong>DQ</strong> afterward (removing would redo the bracket and move people who already have
    their pairing).
  </p>
  {#if missing.length || present.length}
    <ul class="chips" aria-label="Absent">
      {#each missing as id (id)}
        <li>
          <button type="button" class="chip" title="Mark as present" onclick={() => booth.markCheckIn(id, true)}>
            {booth.name(id)}
          </button>
        </li>
      {/each}
    </ul>
    <ul class="chips" aria-label="Present">
      {#each present as id (id)}
        <li>
          <button type="button" class="chip in" title="Undo check-in" onclick={() => booth.markCheckIn(id, false)}>
            {booth.name(id)}
          </button>
        </li>
      {/each}
    </ul>
    <p class="legend">Click an absentee to mark them present, or a present one to undo it.</p>
  {:else}
    <Empty text="No participants" />
  {/if}
  <Messages scope="checkin" />
</Section>

<style>
  .counter {
    display: flex;
    gap: 1.25rem;
    align-items: baseline;
  }

  .big {
    font-size: 1.875rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: rgb(var(--ta-text));
  }

  .big small {
    font-size: 0.8125rem;
    font-weight: 400;
    color: rgb(var(--ta-text-dim));
  }

  .countdown,
  .muted,
  .legend {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .muted,
  .legend {
    margin: 0;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chips:empty {
    display: none;
  }

  .chip {
    font: inherit;
    font-size: 0.6875rem;
    padding: 0.2rem 0.55rem;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
    background: rgb(var(--ta-surface));
    color: rgb(var(--ta-text-dim));
    border: 1px solid transparent;
  }

  .chip:hover,
  .chip:focus-visible {
    border-color: rgb(var(--ta-accent));
    outline: none;
  }

  .chip.in {
    color: rgb(var(--ta-accent-hover));
  }
</style>
