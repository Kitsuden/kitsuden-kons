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

  The tournament stays on top and each step is a tab, in the order of the afternoon. The tabs of
  the sets and of the mismatched reports carry their count, so a report that arrives while the TO
  is elsewhere is seen without scrolling.

  The admin mounts it with `context` ({ apiBase, theme, locale… }); calls go to the kon's REST
  routes with the browser's cookies. The theme comes from the admin's `--kitsuden-*` variables
  through tallao's ThemeScope (ui/View.svelte), which also holds the Toaster the booth reports to.
-->
<script lang="ts">
  import { onDestroy, untrack } from "svelte";

  import { ConfirmDialog, EmptyState, Tabs, type TabItem } from "$lib/components";

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
  import { CANCEL, CLOSE } from "./ui/labels";
  import View from "./ui/View.svelte";

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

  const tabs = $derived.by((): TabItem[] => {
    const list: TabItem[] = [
      { id: "checkin", label: "Check-in" },
      { id: "bracket", label: "Bracket" },
      { id: "sets", label: "Sets", count: booth.loads.sets.ready ? booth.openSets.length : undefined },
      { id: "reports", label: "Reports", count: booth.loads.disputes.ready ? booth.disputes.length : undefined },
    ];
    if (booth.format === "swiss") list.push({ id: "swiss", label: "Swiss" });
    if (booth.bracketOnly) list.push({ id: "participants", label: "Participants" });
    list.push({ id: "stations", label: "Stations" });
    return list;
  });

  // Another tournament may not have the tab that was open (Swiss, Participants).
  $effect(() => {
    if (!tabs.some((t) => t.id === booth.tab)) booth.tab = "checkin";
  });
</script>

<View>
  <TournamentPick />

  {#if booth.tid}
    {#if booth.loads.record.error !== null}
      <EmptyState
        variant="error"
        level={2}
        title="The tournament did not load"
        description={booth.loads.record.error}
        onRetry={() => void booth.load()}
        retrying={booth.loads.record.retrying}
      />
    {:else}
      <Tabs items={tabs} bind:value={booth.tab} ariaLabel="Steps of the tournament" wrap>
        {#snippet children(tab)}
          {#if tab === "checkin"}
            <CheckIn />
          {:else if tab === "bracket"}
            <Bracket />
          {:else if tab === "sets"}
            <Sets />
          {:else if tab === "reports"}
            <Disputes />
          {:else if tab === "swiss"}
            <Swiss />
          {:else if tab === "participants"}
            <Standings />
          {:else if tab === "stations"}
            <Stations />
          {/if}
        {/snippet}
      </Tabs>
    {/if}
  {/if}

  <ConfirmDialog
    bind:open={askOpen}
    title={shown.title}
    description={shown.description}
    confirmLabel={shown.confirmLabel ?? "Confirm"}
    cancelLabel={CANCEL}
    closeLabel={CLOSE}
    variant={shown.variant ?? "primary"}
    onConfirm={() => booth.answer(true)}
  />
</View>

<style>
  :host {
    display: block;
  }
</style>
