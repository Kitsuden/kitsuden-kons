<svelte:options
  customElement={{
    tag: "to-panel",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <to-panel>: the tournament booth.

  What a TO does, in this order: choose the tournament, open check-in, see who is missing,
  resolve absentees, generate the bracket, start the phase, press who won each set, and arbitrate
  the reports that do not match. The table grids are for debugging; this is for running a
  tournament with people waiting.

  The admin mounts it with `context` ({ apiBase, theme, locale… }); calls go to the kon's REST
  routes with the browser's cookies. The theme comes from the admin's `--kitsuden-*` variables
  through tallao's ThemeScope.
-->
<script lang="ts">
  import { onDestroy, untrack } from "svelte";

  import { ConfirmDialog, ThemeScope } from "$lib/components";

  import { createApi } from "./api";
  import Bracket from "./sections/Bracket.svelte";
  import CheckIn from "./sections/CheckIn.svelte";
  import Disputes from "./sections/Disputes.svelte";
  import Sets from "./sections/Sets.svelte";
  import Standings from "./sections/Standings.svelte";
  import Stations from "./sections/Stations.svelte";
  import Swiss from "./sections/Swiss.svelte";
  import TournamentPick from "./sections/TournamentPick.svelte";
  import { Booth, provideBooth, type Ask } from "./store.svelte";

  interface ViewContext {
    apiBase?: string;
    theme?: "light" | "dark";
    locale?: string;
  }

  let { context, params }: { context?: ViewContext; params?: { tournamentId?: string } | null } = $props();

  const booth = new Booth(createApi(() => `${context?.apiBase || "/api"}/esports`));
  provideBooth(booth);

  // The host may set `context` before or after connecting, and again when the theme changes:
  // load once per API base.
  let loadedBase: string | null = null;
  $effect(() => {
    const base = context?.apiBase || "/api";
    if (base === loadedBase) return;
    loadedBase = base;
    untrack(() => booth.boot());
  });

  // Opened from a record, the host may pass the tournament: it wins over the selector.
  $effect(() => {
    const id = params?.tournamentId;
    untrack(() => booth.fromParams(id));
  });

  // Without this the polling stays alive after closing the view.
  onDestroy(() => booth.stop());

  // The confirmation: open when the booth asks; closing it without confirming answers no.
  let askOpen = $state(false);
  let shown = $state<Ask>({ title: "" });
  $effect(() => {
    const ask = booth.ask;
    if (!ask) return;
    untrack(() => {
      shown = ask;
      askOpen = true;
    });
  });
  $effect(() => {
    if (askOpen) return;
    untrack(() => {
      if (booth.ask) booth.answer(false);
    });
  });

  const off = $derived(!booth.tid);
</script>

<ThemeScope class="to-panel">
  <TournamentPick />
  <CheckIn {off} />
  <Bracket {off} />
  <Sets {off} />
  <Disputes {off} />
  {#if booth.format === "swiss"}
    <Swiss {off} />
  {/if}
  {#if booth.bracketOnly}
    <Standings {off} />
  {/if}
  <Stations {off} />

  <ConfirmDialog
    bind:open={askOpen}
    title={shown.title}
    description={shown.description}
    confirmLabel={shown.confirmLabel ?? "Confirm"}
    cancelLabel="Cancel"
    closeLabel="Close"
    variant={shown.variant ?? "primary"}
    onConfirm={() => booth.answer(true)}
  />
</ThemeScope>

<style>
  :host {
    display: block;
  }

  :global(.to-panel) {
    display: grid;
    gap: 1rem;
  }
</style>
