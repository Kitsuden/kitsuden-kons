<svelte:options
  customElement={{
    tag: "crm-setup",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <crm-setup>: presets, capture forms, document templates and portal links.

  This is configuration, not the CRM people work in: the screens for deals, the inbox or invoices
  belong to the app built on top, which calls the same API. Everything here is a call to an
  operation an agent could also make, so nothing is possible only from this screen.

  The admin mounts it with `context` ({ apiBase, theme, locale… }); calls go to the kon's REST routes
  with the browser's cookies. The theme comes from the admin's `--kitsuden-*` variables through
  tallao's ThemeScope (ui/View.svelte), which also holds the Toaster the sections report to.
-->
<script lang="ts">
  import { createApi } from "./api";
  import CaptureForms from "./setup/CaptureForms.svelte";
  import PortalLinks from "./setup/PortalLinks.svelte";
  import Presets from "./setup/Presets.svelte";
  import Templates from "./setup/Templates.svelte";
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

  /** A preset may add forms and templates: their lists load again. */
  let applied = $state(0);
</script>

<View>
  {#key base}
    <Presets {api} onApplied={() => applied++} />
    <CaptureForms {api} reload={applied} />
    <Templates {api} reload={applied} />
    <PortalLinks {api} />
  {/key}
</View>

<style>
  :host {
    display: block;
  }
</style>
