<!--
  Bracket and phases: generate the bracket (or pair the first Swiss round), plan the FGC template,
  start the selected phase and advance to the next one. A button that cannot act is disabled.
-->
<script lang="ts">
  import { Button } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import Messages from "../ui/Messages.svelte";
  import Row from "../ui/Row.svelte";
  import Section from "../ui/Section.svelte";

  const { off = false }: { off?: boolean } = $props();
  const booth = useBooth();

  const MARK: Record<string, string> = { pending: "", active: " ●", complete: " ✓" };
</script>

<Section title="Bracket and phases" {off}>
  {#snippet meta()}{booth.phases.length ? `${booth.phases.length} phase(s)` : "no phases planned"}{/snippet}
  <Row>
    <Button onclick={() => booth.generate()}>{booth.generateLabel}</Button>
    <Button variant="secondary" disabled={booth.phases.length > 0} onclick={() => booth.planTemplate()}>
      FGC template (pools → top 8)
    </Button>
    <Button
      variant="secondary"
      disabled={!booth.phase || booth.phase.status !== "pending"}
      onclick={() => booth.startPhase()}
    >
      Start phase
    </Button>
    <Button
      variant="secondary"
      disabled={!booth.phase || booth.phase.status === "pending"}
      onclick={() => booth.advancePhase()}
    >
      Advance to the next
    </Button>
  </Row>
  {#if booth.phases.length}
    <div class="phases" role="group" aria-label="Phases">
      {#each booth.phases as p (p.id)}
        <button
          type="button"
          class="phase"
          aria-pressed={p.id === booth.activePhase}
          onclick={() => booth.selectPhase(p.id)}
        >
          {p.name}{(p.groups ?? 0) > 1 ? ` (${p.groups} pools)` : ""}{MARK[p.status] ?? ""}
        </button>
      {/each}
    </div>
  {/if}
  <Messages scope="phase" />
</Section>

<style>
  .phases {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .phase {
    font: inherit;
    font-size: 0.75rem;
    padding: 0.3rem 0.75rem;
    border-radius: var(--ta-radius);
    cursor: pointer;
    border: 1px solid rgb(var(--ta-border));
    background: transparent;
    color: rgb(var(--ta-text-dim));
  }

  .phase:hover,
  .phase:focus-visible {
    color: rgb(var(--ta-text));
    outline: none;
    border-color: rgb(var(--ta-accent) / 0.6);
  }

  .phase[aria-pressed="true"] {
    border-color: rgb(var(--ta-accent));
    color: rgb(var(--ta-text));
  }
</style>
