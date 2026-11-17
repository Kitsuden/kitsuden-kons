<svelte:options
  customElement={{
    tag: "dc-bot-admin",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <dc-bot-admin>: the Discord bot's administration.

  Configuration and oversight only (the bot's daily face is Discord itself): an overview of every
  server, whether the installation is connected, and per server the modules on and their settings,
  the slash commands, the live panels, its economy (rankings, a member's file, give and take), its
  activity, the work scheduled for later, its plan and member page; then the blueprints, the item
  catalog and the portable export. Each part is a tab.

  The admin mounts it with `context` ({ apiBase, theme, locale… }); calls go to the kon's REST routes
  with the browser's cookies. The theme comes from the admin's `--kitsuden-*` variables through
  tallao's ThemeScope (ui/View.svelte), which also holds the Toaster every action reports to.
-->
<script lang="ts">
  import { Tabs, type TabItem } from "$lib/components";

  import { createApi } from "./api";
  import { provideApi } from "./context";
  import Blueprints from "./sections/Blueprints.svelte";
  import Items from "./sections/Items.svelte";
  import Overview from "./sections/Overview.svelte";
  import Servers from "./sections/Servers.svelte";
  import Setup from "./sections/Setup.svelte";
  import Transfer from "./sections/Transfer.svelte";
  import type { ViewContext } from "./types";
  import View from "./ui/View.svelte";
  import { remembered } from "./ui/remember.svelte";

  let { context }: { context?: ViewContext; params?: Record<string, unknown> | null } = $props();

  provideApi(createApi(() => `${context?.apiBase || "/api"}/dc`));

  const tabs: TabItem[] = [
    { id: "overview", label: "Overview" },
    { id: "setup", label: "Setup" },
    { id: "servers", label: "Servers" },
    { id: "blueprints", label: "Blueprints" },
    { id: "items", label: "Items" },
    { id: "transfer", label: "Export / import" },
  ];
</script>

<View>
  <Tabs items={tabs} bind:value={remembered.tab} ariaLabel="Discord bot" wrap>
    {#snippet children(id)}
      {#if id === "overview"}
        <Overview onGo={(t) => (remembered.tab = t)} />
      {:else if id === "setup"}
        <Setup />
      {:else if id === "servers"}
        <Servers />
      {:else if id === "blueprints"}
        <Blueprints />
      {:else if id === "items"}
        <Items />
      {:else if id === "transfer"}
        <Transfer />
      {/if}
    {/snippet}
  </Tabs>
</View>

<style>
  :host {
    display: block;
  }
</style>
