<svelte:options
  customElement={{
    tag: "crm-settings",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <crm-settings>: CRM maintenance, the score model and who reaches how much.

  The score rules are a table anyone can read and the guide is plain Markdown. Saving makes a new
  version, and "Try on a contact" shows the result of the rules on screen before anything is saved:
  nobody should learn what a rule does from the whole base changing order.

  The admin mounts it with `context` ({ apiBase, theme, locale… }); calls go to the kon's REST routes
  with the browser's cookies. The theme comes from the admin's `--kitsuden-*` variables through
  tallao's ThemeScope (ui/View.svelte), which also holds the Toaster the sections report to.
-->
<script lang="ts">
  import { createApi } from "./api";
  import AccessGrants from "./settings/AccessGrants.svelte";
  import EvidencePolicy from "./settings/EvidencePolicy.svelte";
  import ScoreModel from "./settings/ScoreModel.svelte";
  import View from "./ui/View.svelte";

  interface ViewContext {
    apiBase?: string;
    theme?: "light" | "dark";
    locale?: string;
  }

  let { context, params }: { context?: ViewContext; params?: unknown } = $props();

  // The host may set `context` before or after connecting, and again when the theme changes: the
  // sections load again only when the API base changes.
  const base = $derived(context?.apiBase || "/api");
  const api = createApi(() => `${base}/crm`);
</script>

<View>
  {#key base}
    <ScoreModel {api} />
    <EvidencePolicy {api} />
    <AccessGrants {api} />
  {/key}
</View>

<style>
  :host {
    display: block;
  }
</style>
