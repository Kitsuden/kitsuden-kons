<!-- Stations: where each set is played. -->
<script lang="ts">
  import { Button, Input, Select } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import Empty from "../ui/Empty.svelte";
  import Messages from "../ui/Messages.svelte";
  import Row from "../ui/Row.svelte";
  import Section from "../ui/Section.svelte";

  const { off = false }: { off?: boolean } = $props();
  const booth = useBooth();

  const KINDS = [
    { value: "physical", label: "In person" },
    { value: "lobby", label: "Online lobby" },
  ];

  let name = $state("");
  let kind = $state("physical");
  let access = $state("");
  let saving = $state(false);

  async function add() {
    saving = true;
    try {
      if (await booth.addStation(name, kind, access)) {
        name = "";
        access = "";
      }
    } finally {
      saving = false;
    }
  }
</script>

<Section title="Stations" {off}>
  {#snippet meta()}Where each set is played{/snippet}
  <Row>
    <Input aria-label="Station name" placeholder="Setup 1, Lobby A…" bind:value={name} />
    <Select aria-label="Station kind" bind:value={kind} options={KINDS} />
    <Input aria-label="Access" placeholder="Code or access (optional)" bind:value={access} />
    <Button variant="secondary" loading={saving} onclick={add}>Add</Button>
  </Row>
  {#if booth.stations.length}
    <ul class="chips" aria-label="Stations">
      {#each booth.stations as s (s.id)}
        <li class="chip" title={s.accessDetails || undefined}>
          {s.kind === "lobby" ? `${s.name} (lobby)` : s.name}
        </li>
      {/each}
    </ul>
  {:else}
    <Empty text="No stations" />
  {/if}
  <Messages scope="stations" />
</Section>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chip {
    font-size: 0.6875rem;
    padding: 0.2rem 0.55rem;
    border-radius: var(--ta-radius-sm);
    background: rgb(var(--ta-surface));
    color: rgb(var(--ta-text-dim));
  }
</style>
