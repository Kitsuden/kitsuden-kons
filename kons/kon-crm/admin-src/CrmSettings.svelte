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
  tallao's ThemeScope.
-->
<script lang="ts">
  import { ThemeScope } from "$lib/components";

  import { createApi } from "./api";
  import AccessGrants from "./settings/AccessGrants.svelte";
  import EvidencePolicy from "./settings/EvidencePolicy.svelte";
  import ScoreModel from "./settings/ScoreModel.svelte";

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

<ThemeScope class="crm-admin">
  {#key base}
    <ScoreModel {api} />
    <EvidencePolicy {api} />
    <AccessGrants {api} />
  {/key}
</ThemeScope>

<style>
  :host {
    display: block;
  }

  :global(.crm-admin) {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
</style>
