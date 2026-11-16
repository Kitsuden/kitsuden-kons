<svelte:options
  customElement={{
    tag: "koe-admin",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <koe-admin>: setting koe up and keeping an eye on it. Channels and how to connect each one (the web chat
  embed code, the Meta webhook), who is on the team and in which teams, WhatsApp templates, and the bot and
  copilot each channel uses.

  Configuration and oversight only: people answer conversations in the inbox (GET /api/koe/inbox, the
  <koe-inbox> element), never here.

  The admin mounts it with `context` ({ apiBase, theme, locale, user }); calls go to koe's REST routes with
  the browser's cookies, so what each section may change is what the API lets this person change.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import { createApi } from "./api";
  import Channels from "./setup/Channels.svelte";
  import Copilot from "./setup/Copilot.svelte";
  import InboxLink from "./setup/InboxLink.svelte";
  import Members from "./setup/Members.svelte";
  import Teams from "./setup/Teams.svelte";
  import Templates from "./setup/Templates.svelte";
  import Webhook from "./setup/Webhook.svelte";
  import type { Channel, Member, Team } from "./types";
  import { createLoad } from "./ui/load.svelte";
  import View from "./ui/View.svelte";

  interface ViewContext {
    apiBase?: string;
    theme?: "light" | "dark";
    locale?: string;
    user?: { id?: string };
  }

  let { context, params }: { context?: ViewContext; params?: unknown } = $props();

  // The host may set `context` before or after connecting, and again when the theme changes: the view
  // loads again only when the API base changes.
  const apiBase = $derived(context?.apiBase || "/api");
  const koeBase = $derived(`${apiBase}/koe`);
  const api = createApi(() => koeBase);
  /** The kon-chat bots (a channel's AI bot), when kon-chat is installed. */
  const chatApi = createApi(() => `${apiBase}/chat`);

  /** Absolute: what gets pasted into Meta and into other sites. */
  const absoluteBase = $derived.by(() => {
    try {
      return new URL(koeBase, window.location.href).href.replace(/\/$/, "");
    } catch {
      return koeBase;
    }
  });

  // Shared by the sections: a team or member added in one appears in the others' pickers.
  let channels = $state<Channel[]>([]);
  let members = $state<Member[]>([]);
  let teams = $state<Team[]>([]);

  const channelsLoad = createLoad(async () => {
    channels = (await api.get<{ data?: Channel[] }>("channels")).data ?? [];
  });
  const membersLoad = createLoad(async () => {
    members = (await api.get<{ data?: Member[] }>("members")).data ?? [];
  });
  const teamsLoad = createLoad(async () => {
    teams = (await api.get<{ data?: Team[] }>("teams")).data ?? [];
  });

  $effect(() => {
    void koeBase;
    untrack(() => {
      channelsLoad.load();
      membersLoad.load();
      teamsLoad.load();
    });
  });
</script>

<View>
  {#key koeBase}
    <InboxLink base={absoluteBase} />
    <Channels {api} {chatApi} base={absoluteBase} {channels} {teams} load={channelsLoad} />
    <Webhook {api} base={absoluteBase} />
    <Members {api} {members} {teams} load={membersLoad} reloadTeams={teamsLoad.load} />
    <Teams {api} {teams} {members} load={teamsLoad} reloadMembers={membersLoad.load} />
    <Templates {api} {channels} />
    <Copilot {api} />
  {/key}
</View>

<style>
  :host {
    display: block;
  }
</style>
