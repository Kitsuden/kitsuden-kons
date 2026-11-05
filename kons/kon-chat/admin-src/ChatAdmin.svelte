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

  The admin mounts it with `context` ({ apiBase, theme, locale… }); calls go to the kon's REST routes
  with the browser's cookies. The theme comes from the admin's `--kitsuden-*` variables through
  tallao's ThemeScope.
-->
<script lang="ts">
  import { ThemeScope } from "$lib/components";

  import { createApi } from "./api";
  import BotDetail from "./sections/BotDetail.svelte";
  import Bots from "./sections/Bots.svelte";
  import type { Bot } from "./types";

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

<ThemeScope class="chat-admin">
  {#key base}
    <Bots {api} onOpen={open} onDeleted={(bot) => current?.id === bot.id && (current = null)} />
    {#if current}
      {#key opened}
        <BotDetail {api} bot={current} apiBase={base} {visitorId} />
      {/key}
    {/if}
  {/key}
</ThemeScope>

<style>
  :host {
    display: block;
  }

  :global(.chat-admin) {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
</style>
