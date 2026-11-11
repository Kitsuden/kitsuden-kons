<!--
  Check-in: how many are in, who is absent and who is present (each one a button that marks them
  from the table: at an in-person event half the room does not use a phone), resolving absentees,
  and the window.
-->
<script lang="ts">
  import { Badge, Button, EmptyState, Field, Gauge, Icon, Input, Stat } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import Loadable from "../ui/Loadable.svelte";
  import Panel from "../ui/Panel.svelte";

  const booth = useBooth();

  const STATE: Record<string, { label: string; variant: "default" | "info" | "success" | "warning" }> = {
    disabled: { label: "Not scheduled", variant: "default" },
    scheduled: { label: "Scheduled", variant: "info" },
    open: { label: "Open", variant: "success" },
    closed: { label: "Closed", variant: "warning" },
  };

  let opens = $state("");
  let closes = $state("");

  const data = $derived(booth.checkIn);
  const phase = $derived(data ? (STATE[data.state] ?? { label: data.state, variant: "default" as const }) : null);
  const missing = $derived(data?.summary.missingIds ?? []);
  const present = $derived(data?.summary.checkedInIds ?? []);
  const minutes = $derived(data && data.countdown !== null ? Math.ceil(data.countdown / 60) : null);
</script>

<Panel title="Check-in">
  {#snippet status()}
    {#if phase}<Badge variant={phase.variant} dot>{phase.label}</Badge>{/if}
  {/snippet}
  <Loadable load={booth.loads.checkIn} errorTitle="Check-in did not load" lines={6}>
    {#if data}
      <div class="figures">
        <Gauge label="Checked in" value={data.summary.checkedIn} max={data.summary.total} size={150} />
        <div class="stats">
          <Stat label="Registered" value={data.summary.total} />
          {#if minutes !== null}
            <Stat label={data.state === "scheduled" ? "Opens in" : "Closes in"} value={`${minutes} min`} />
          {/if}
        </div>
      </div>

      {#if missing.length || present.length}
        <section class="group" aria-labelledby="checkin-absent">
          <h3 class="sub" id="checkin-absent">Absent <Badge variant="warning">{missing.length}</Badge></h3>
          {#if missing.length}
            <ul class="people">
              {#each missing as id (id)}
                <li>
                  <Button
                    size="sm"
                    variant="outline"
                    ariaLabel={`Mark ${booth.name(id)} present`}
                    title={`Mark ${booth.name(id)} present`}
                    onclick={() => booth.markCheckIn(id, true)}>{booth.name(id)}</Button
                  >
                </li>
              {/each}
            </ul>
          {:else}
            <p class="quiet">Nobody is absent.</p>
          {/if}
        </section>

        <section class="group" aria-labelledby="checkin-present">
          <h3 class="sub" id="checkin-present">Present <Badge variant="success">{present.length}</Badge></h3>
          {#if present.length}
            <ul class="people">
              {#each present as id (id)}
                <li>
                  <Button
                    size="sm"
                    variant="secondary"
                    ariaLabel={`Mark ${booth.name(id)} absent`}
                    title={`Mark ${booth.name(id)} absent`}
                    onclick={() => booth.markCheckIn(id, false)}
                  >
                    <Icon name="check" size={14} />{booth.name(id)}
                  </Button>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="quiet">Nobody has checked in yet.</p>
          {/if}
        </section>
      {:else}
        <EmptyState
          size="sm"
          level={3}
          title="No participants yet"
          description="Whoever registers for the tournament appears here to be checked in."
        />
      {/if}

      <section class="group" aria-labelledby="checkin-absentees">
        <h3 class="sub" id="checkin-absentees">Absentees</h3>
        <p class="quiet">
          <strong>Remove</strong> before generating the bracket (byes fall where they should).
          <strong>Disqualify</strong> afterward (removing would redo the bracket and move people who already
          have their pairing).
        </p>
        <div class="buttons">
          <Button variant="danger-ghost" onclick={() => booth.resolveAbsentees("dq")}>Disqualify absentees</Button>
          <Button variant="danger-ghost" onclick={() => booth.resolveAbsentees("drop")}>Remove absentees</Button>
        </div>
      </section>

      <section class="group" aria-labelledby="checkin-window">
        <h3 class="sub" id="checkin-window">Window</h3>
        <FormGrid label="Check-in window" onsubmit={() => booth.setWindow(opens, closes)}>
          <Field label="Opens">
            <Input type="datetime-local" bind:value={opens} />
          </Field>
          <Field label="Closes">
            <Input type="datetime-local" bind:value={closes} />
          </Field>
          {#snippet actions()}
            <Button type="submit" variant="secondary">Schedule</Button>
          {/snippet}
        </FormGrid>
      </section>
    {/if}
  </Loadable>
</Panel>

<style>
  .figures {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem 1.5rem;
  }

  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .sub {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .people {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .people :global(.ta-icon) {
    margin-right: 0.25rem;
  }

  .quiet {
    margin: 0;
    max-width: 72ch;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .quiet strong {
    color: rgb(var(--ta-text));
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
