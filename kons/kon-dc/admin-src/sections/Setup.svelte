<!--
  Setup: is this installation connected to Discord, and is the bot doing anything. Booleans only:
  the view never sees a token, a key or a URL with credentials.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import { Badge, Button, DescriptionList, type DescriptionItem } from "$lib/components";

  import { useApi, when } from "../context";
  import type { Status } from "../types";
  import Loadable from "../ui/Loadable.svelte";
  import Panel from "../ui/Panel.svelte";
  import { createLoad } from "../ui/load.svelte";

  const api = useApi();
  let status = $state<Status | null>(null);
  const data = createLoad(async () => {
    status = await api.get<Status>("/status");
  });
  $effect(() => {
    untrack(data.load);
  });

  const checks = $derived(
    status
      ? [
          { label: "Interactions", env: "DISCORD_PUBLIC_KEY", ok: status.configured.publicKey },
          { label: "Application", env: "DISCORD_APPLICATION_ID", ok: status.configured.applicationId },
          { label: "Bot token", env: "DISCORD_BOT_TOKEN", ok: status.configured.botToken },
          { label: "Other kons", env: "DISCORD_KITSUDEN_API_URL + _TOKEN", ok: status.configured.kitsudenApi },
        ]
      : []
  );

  const links = $derived<DescriptionItem[]>(
    status
      ? [
          { label: "Interactions Endpoint URL", value: status.interactionsUrl, copy: true, mono: true },
          { label: "Invite link", value: status.inviteUrl, href: status.inviteUrl ?? undefined, copy: !!status.inviteUrl },
        ]
      : []
  );

  const activity = $derived<DescriptionItem[]>(
    status
      ? [
          { label: "Interactions", value: status.stats.interactions ?? 0 },
          { label: "Gateway events", value: status.stats.gatewayEvents ?? 0 },
          { label: "Last batch from the gateway worker", value: when(status.stats.lastGatewayBatchAt) },
          { label: "Kon events received", value: status.stats.konEvents ?? 0 },
          { label: "Dropped (queue full)", value: status.stats.dropped ?? 0 },
          { label: "Queued now", value: status.stats.queued ?? 0 },
          { label: "Listening to", value: (status.stats.subscribedEvents ?? []).join(", ") || null, mono: true },
          { label: "Switched off for the installation", value: status.disabledModules.join(", ") || null, mono: true },
        ]
      : []
  );
</script>

<Panel title="Connection">
  {#snippet actions()}
    <Button variant="ghost" size="sm" onclick={() => data.load()}>Refresh</Button>
  {/snippet}
  <Loadable load={data} errorTitle="The status did not load">
    <ul class="checks" aria-label="Settings in the API">
      {#each checks as c (c.env)}
        <li>
          <Badge variant={c.ok ? "success" : "warning"} dot>{c.ok ? "Set" : "Missing"}</Badge>
          <span class="label">{c.label}</span>
          <code>{c.env}</code>
        </li>
      {/each}
    </ul>
    <DescriptionList items={links} />
  </Loadable>
</Panel>

<Panel title="Activity since the API started">
  <Loadable load={data} errorTitle="The status did not load">
    <DescriptionList items={activity} columns={2} />
  </Loadable>
</Panel>

<style>
  .checks {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .checks li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .label {
    font-weight: 500;
  }

  code {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
