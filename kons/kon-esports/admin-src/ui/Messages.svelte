<!-- A section's note (amber) and error, each dismissable. -->
<script lang="ts">
  import { Alert } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import type { Scope } from "../types";

  const { scope }: { scope: Scope } = $props();
  const booth = useBooth();
  const msg = $derived(booth.msg[scope]);
</script>

{#if msg.note}
  <Alert variant="warning" dismissLabel="Dismiss" onDismiss={() => booth.note(scope, null)}>{msg.note}</Alert>
{/if}
{#if msg.err}
  <Alert variant="error" dismissLabel="Dismiss" onDismiss={() => booth.error(scope, null)}>{msg.err}</Alert>
{/if}
