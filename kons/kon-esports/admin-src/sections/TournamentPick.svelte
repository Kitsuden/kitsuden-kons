<!-- Chooses the tournament the booth operates: nobody passes it one. -->
<script lang="ts">
  import { Button, Select } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import Messages from "../ui/Messages.svelte";
  import Row from "../ui/Row.svelte";
  import Section from "../ui/Section.svelte";

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

<Section title="Tournament">
  {#snippet meta()}{booth.tournamentState}{/snippet}
  <Row>
    <div class="pick">
      <Select
        aria-label="Tournament"
        bind:value={selected}
        {options}
        placeholder={booth.tournaments.length ? undefined : "There is no tournament"}
        disabled={!booth.tournaments.length}
        onchange={(e: Event) => booth.choose((e.currentTarget as HTMLSelectElement).value || null)}
      />
    </div>
    <Button variant="secondary" onclick={() => booth.boot()}>Reload</Button>
  </Row>
  <Messages scope="pick" />
  {#if booth.tournaments.length === 0}
    <!-- An empty dropdown does not tell "there are no tournaments" from "it did not load". -->
    <p class="hint">
      Create one in the Tournaments tab and come back here. This booth operates a tournament that
      already exists; it does not create it.
    </p>
  {/if}
</Section>

<style>
  .pick {
    flex: 0 1 22rem;
    min-width: 16rem;
  }

  .pick :global(.ta-select) {
    width: 100%;
  }

  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
