<svelte:options
  customElement={{
    tag: "broadcast-scoreboard",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <broadcast-scoreboard>: the operator panel of one set (`params.matchId`). Score of each side,
  the screens on air and the side swap; every change goes to the server, which answers with the
  set as it is now. The theme comes from the admin's `--kitsuden-*` variables through ThemeScope.
-->
<script lang="ts">
  import { Alert, Badge, Button, Card, CardContent, ThemeScope } from "$lib/components";

  import { untrack } from "svelte";

  import { apiBaseOf, createApi, messageOf, seg } from "./api";
  import type { Match, ScreenKey, Side, ViewContext } from "./types";

  let { context, params }: { context?: ViewContext; params?: { matchId?: string } } = $props();

  const api = createApi(() => `${apiBaseOf(context)}/broadcast`);

  let match = $state<Match | null>(null);
  let busy = $state(false);
  let error = $state("");

  const matchId = $derived(params?.matchId ?? null);

  // Once per API base and set: the host sets `context` again when the theme changes.
  let loadedKey: string | null = null;
  $effect(() => {
    const key = `${apiBaseOf(context)}|${matchId ?? ""}`;
    if (key === loadedKey) return;
    loadedKey = key;
    const id = matchId;
    untrack(() => void load(id));
  });

  async function load(id: string | null) {
    if (!id) {
      match = null;
      return;
    }
    try {
      const { data } = await api.get<{ data: Match }>(`/matches/${seg(id)}`);
      match = data;
      error = "";
    } catch (e) {
      error = `Could not load the set: ${messageOf(e)}`;
    }
  }

  async function post(action: string, body?: unknown) {
    if (!matchId || busy) return;
    busy = true;
    try {
      const { data } = await api.post<{ data: Match }>(`/matches/${seg(matchId)}/${action}`, body);
      match = data;
      error = "";
    } catch (e) {
      error = `The operation failed: ${messageOf(e)}`;
    } finally {
      busy = false;
    }
  }

  const screens: { key: ScreenKey; label: string }[] = [
    { key: "versus", label: "Versus" },
    { key: "ko", label: "K.O." },
    { key: "casters", label: "Casters" },
  ];

  const toggle = (key: ScreenKey) => post("screens", { [key]: !(match?.screens?.[key] ?? false) });
</script>

{#snippet side(key: "a" | "b", s: Side | undefined)}
  <Card class={s?.losers ? "side losers" : "side"}>
    <CardContent class="side-body">
      <div class="sponsor">{s?.sponsor ?? ""}</div>
      <div class="name">{s?.name ?? ""}</div>
      <div class="chars">
        {#each s?.chars ?? [] as c, i (i)}
          <Badge>{c}</Badge>
        {/each}
      </div>
      <div class="score">{s?.score ?? 0}</div>
      <div class="controls">
        <Button
          variant="outline"
          ariaLabel={`Subtract from side ${key.toUpperCase()}`}
          disabled={busy}
          onclick={() => post("score", { side: key, delta: -1 })}>−</Button
        >
        <Button
          variant="outline"
          ariaLabel={`Add to side ${key.toUpperCase()}`}
          disabled={busy}
          onclick={() => post("score", { side: key, delta: 1 })}>+</Button
        >
      </div>
    </CardContent>
  </Card>
{/snippet}

<ThemeScope class="broadcast-scoreboard">
  {#if match}
    <div class="row">
      {@render side("a", match.sideA)}
      <div class="vs">{match.round ?? ""} · FT{match.firstTo ?? ""}</div>
      {@render side("b", match.sideB)}
    </div>
    <div class="screens">
      {#each screens as s (s.key)}
        {@const on = Boolean(match.screens?.[s.key])}
        <Button
          variant={on ? "primary" : "outline"}
          aria-pressed={on}
          disabled={busy}
          onclick={() => toggle(s.key)}>{s.label}</Button
        >
      {/each}
      <Button variant="outline" disabled={busy} onclick={() => post("swap")}>Swap sides</Button>
    </div>
  {/if}

  {#if error}
    <Alert variant="error">{error}</Alert>
  {/if}

  {#if !match}
    <p class="empty">Select a set to operate it.</p>
  {/if}
</ThemeScope>

<style>
  :host {
    display: block;
  }

  :global(.broadcast-scoreboard) {
    display: grid;
    gap: 1rem;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    gap: 1rem;
    align-items: center;
  }

  .row :global(.losers) {
    border-color: rgb(var(--ta-warning));
  }

  .row :global(.side-body) {
    display: grid;
    gap: 0.5rem;
  }

  .sponsor {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
    text-transform: uppercase;
    min-height: 1em;
  }

  .name {
    font-weight: 700;
    font-size: 1.125rem;
    letter-spacing: 0.02em;
  }

  .chars {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
  }

  .score {
    font-size: 3rem;
    font-weight: 800;
    line-height: 1;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .controls,
  .screens {
    display: flex;
    gap: 0.5rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  .vs {
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
    text-align: center;
  }

  .empty {
    margin: 0;
    padding: 2rem;
    text-align: center;
    color: rgb(var(--ta-text-dim));
  }

  @media (max-width: 640px) {
    .row {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
