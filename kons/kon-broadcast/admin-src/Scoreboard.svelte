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
  set as it is now. The theme comes from the admin's `--kitsuden-*` variables through ThemeScope
  (ui/View.svelte), which also holds the Toaster the results go to.
-->
<script lang="ts">
  import { Badge, Button, EmptyState, Icon, Toggle } from "$lib/components";

  import { untrack } from "svelte";

  import { apiBaseOf, createApi, seg } from "./api";
  import type { Match, ScreenKey, Side, ViewContext } from "./types";
  import { createLoad } from "./ui/load.svelte";
  import Loadable from "./ui/Loadable.svelte";
  import { failed, toast } from "./ui/notify";
  import Panel from "./ui/Panel.svelte";
  import View from "./ui/View.svelte";

  let { context, params }: { context?: ViewContext; params?: { matchId?: string } } = $props();

  const api = createApi(() => `${apiBaseOf(context)}/broadcast`);

  let match = $state<Match | null>(null);
  let busy = $state(false);
  /** Bumped when a change fails: the toggles are drawn again from what the server keeps. */
  let rev = $state(0);

  const matchId = $derived(params?.matchId ?? null);

  const data = createLoad(async () => {
    const id = matchId;
    if (!id) {
      match = null;
      return;
    }
    match = (await api.get<{ data: Match }>(`/matches/${seg(id)}`)).data;
  });

  // Once per API base and set: the host sets `context` again when the theme changes.
  let loadedKey: string | null = null;
  $effect(() => {
    const key = `${apiBaseOf(context)}|${matchId ?? ""}`;
    if (key === loadedKey) return;
    loadedKey = key;
    untrack(() => void data.load());
  });

  /** One change of the set; the server answers with the set as it is now. */
  async function post(action: string, body: unknown, what: string, done: (m: Match) => string) {
    if (!matchId || busy) return;
    busy = true;
    try {
      const { data: next } = await api.post<{ data: Match }>(`/matches/${seg(matchId)}/${action}`, body);
      match = next;
      toast.success(done(next));
    } catch (e) {
      failed(what, e);
      rev++;
    } finally {
      busy = false;
    }
  }

  const screens: { key: ScreenKey; label: string }[] = [
    { key: "versus", label: "Versus" },
    { key: "ko", label: "K.O." },
    { key: "casters", label: "Casters" },
  ];

  const scoreline = (m: Match) => `${m.sideA.name} ${m.sideA.score} — ${m.sideB.score} ${m.sideB.name}`;

  const score = (key: "a" | "b", delta: number) =>
    post("score", { side: key, delta }, "Could not change the score", scoreline);

  const toggle = (s: { key: ScreenKey; label: string }) =>
    post(
      "screens",
      { [s.key]: !(match?.screens?.[s.key] ?? false) },
      `Could not change the ${s.label} screen`,
      (m) => `${s.label} is ${m.screens?.[s.key] ? "on air" : "off air"}`
    );

  const swap = () => post("swap", undefined, "Could not swap the sides", () => "Sides swapped");

  const onAir = $derived(screens.filter((s) => match?.screens?.[s.key]).map((s) => s.label));
</script>

{#snippet side(key: "a" | "b", s: Side | undefined)}
  {@const name = s?.name || `Side ${key.toUpperCase()}`}
  <section class="side" aria-labelledby={`side-${key}`}>
    <div class="who">
      <span class="sponsor">{s?.sponsor ?? ""}</span>
      <h3 class="name" id={`side-${key}`}>{name}</h3>
    </div>
    <div class="points">
      <Button
        variant="outline"
        size="icon"
        ariaLabel={`${name}: remove a point`}
        title={`${name}: remove a point`}
        disabled={busy}
        onclick={() => score(key, -1)}><Icon name="minus" /></Button
      >
      <span class="figure">{s?.score ?? 0}</span>
      <Button
        variant="outline"
        size="icon"
        ariaLabel={`${name}: add a point`}
        title={`${name}: add a point`}
        disabled={busy}
        onclick={() => score(key, 1)}><Icon name="plus" /></Button
      >
    </div>
    <span class="label">Score</span>
    {#if s?.losers || s?.chars?.length}
      <ul class="chars" aria-label={`About ${name}`}>
        {#if s?.losers}<li><Badge variant="warning" dot>Losers side</Badge></li>{/if}
        {#each s?.chars ?? [] as c, i (i)}
          <li><Badge>{c}</Badge></li>
        {/each}
      </ul>
    {/if}
  </section>
{/snippet}

<View>
  {#if !matchId}
    <Panel title="Score">
      <EmptyState
        size="sm"
        level={3}
        title="No set to operate"
        description="This scoreboard operates one set, and none was given to it. Open it from the set you are broadcasting."
      />
    </Panel>
  {:else}
    <Panel title="Score">
      {#snippet status()}
        {#if match}
          <Badge>{[match.round, `First to ${match.firstTo ?? ""}`].filter(Boolean).join(" · ")}</Badge>
        {/if}
      {/snippet}
      {#snippet actions()}
        <Button variant="outline" disabled={busy || !match} onclick={swap}>Swap sides</Button>
      {/snippet}
      <Loadable load={data} errorTitle="The set did not load" lines={5}>
        {#if match}
          <div class="sides">
            {@render side("a", match.sideA)}
            {@render side("b", match.sideB)}
          </div>
        {/if}
      </Loadable>
    </Panel>

    {#if match}
      <Panel title="Screens">
        {#snippet status()}
          <Badge variant={onAir.length ? "success" : "default"} dot>
            {onAir.length ? `On air: ${onAir.join(", ")}` : "Nothing on air"}
          </Badge>
        {/snippet}
        <div class="screens" role="group" aria-label="Screens on air">
          {#key rev}
          {#each screens as s (s.key)}
            {@const on = Boolean(match.screens?.[s.key])}
            <Toggle pressed={on} ariaLabel={`${s.label} on air`} disabled={busy} onchange={() => toggle(s)}>
              {s.label}: {on ? "on air" : "off air"}
            </Toggle>
          {/each}
          {/key}
        </div>
      </Panel>
    {/if}
  {/if}
</View>

<style>
  :host {
    display: block;
  }

  .sides {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
    gap: 1.5rem;
  }

  .side {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.625rem;
    min-width: 0;
    text-align: center;
  }

  .who {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
  }

  .sponsor {
    min-height: 1.2em;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: rgb(var(--ta-text-dim));
  }

  .name {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .chars {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .points {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .label {
    margin-top: -0.375rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .figure {
    min-width: 4rem;
    font-size: 3rem;
    font-weight: 800;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .screens {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
