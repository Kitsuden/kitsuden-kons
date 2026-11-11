<svelte:options
  customElement={{
    tag: "chat-admin",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <chat-admin>: chatbots. Set them up, teach them, try them, read what people asked.

  Configuration and oversight only; the chat people use is the widget on a website, or the app built
  on top for team bots.

  The list of bots, and one bot once it is opened ("Back to bots" returns to the list, which stays
  loaded behind it).

  The admin mounts it with `context` ({ apiBase, theme, locale… }); calls go to the kon's REST routes
  with the browser's cookies. The theme comes from the admin's `--kitsuden-*` variables through
  tallao's ThemeScope (ui/View.svelte), which also holds the Toaster the sections report to.
-->
<script lang="ts">
  import { createApi } from "./api";
  import BotDetail from "./sections/BotDetail.svelte";
  import Bots from "./sections/Bots.svelte";
  import type { Bot } from "./types";
  import View from "./ui/View.svelte";

  interface ViewContext {
    apiBase?: string;
    theme?: "light" | "dark";
    locale?: string;
    user?: { id?: string };
  }

  let { context, params }: { context?: ViewContext; params?: unknown } = $props();

  // The host may set `context` before or after connecting, and again when the theme changes: the
  // panel loads again only when the API base changes.
  const base = $derived(context?.apiBase || "/api");
  const api = createApi(() => `${base}/chat`);

  /** A public bot needs a visitor id to answer a try from the panel. */
  const visitorId = $derived(`admin-try-${context?.user?.id ?? "panel"}-xxxxxxxxxxxx`);

  let current = $state<Bot | null>(null);
  /** Opening a bot again starts it over: a new conversation, the lists loaded again. */
  let opened = $state(0);

  function open(bot: Bot) {
    current = bot;
    opened++;
  }
</script>

<View>
  {#key base}
    <Bots {api} hidden={current !== null} onOpen={open} onDeleted={(bot) => current?.id === bot.id && (current = null)} />
    {#if current}
      {#key opened}
        <BotDetail {api} bot={current} apiBase={base} {visitorId} onBack={() => (current = null)} />
      {/key}
    {/if}
  {/key}
</View>

<style>
  :host {
    display: block;
  }
</style>
