<!-- Where the team answers: the inbox is its own page, outside the admin. -->
<script lang="ts">
  import { Button, CopyButton } from "$lib/components";

  import Panel from "../ui/Panel.svelte";

  const { base }: { base: string } = $props();

  const url = $derived(`${base}/inbox`);
</script>

<Panel title="Inbox" description="Agents answer conversations in the inbox, with live updates and web push.">
  {#snippet actions()}
    <CopyButton text={url} label="Copy link" copyLabel="Copy the inbox link" copiedLabel="Copied" />
    <Button size="sm" href={url} target="_blank" rel="noopener">Open inbox</Button>
  {/snippet}
  <p class="url">{url}</p>
</Panel>

<style>
  .url {
    margin: 0;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
    color: rgb(var(--ta-text-dim));
  }
</style>
