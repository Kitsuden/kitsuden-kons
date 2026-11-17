<!--
  Overview: the whole bot at a glance. Whether it can talk to Discord, how many servers, modules,
  blueprints and members it has, what the last 30 days looked like across every server and which
  servers were busiest. Each figure leads to the tab that manages it.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import { Alert, BarList, Button, ChartCard, DashboardGrid, KpiCard, LineChart, Skeleton } from "$lib/components";

  import { dayLabel, useApi } from "../context";
  import type { Overview, Status } from "../types";
  import Loadable from "../ui/Loadable.svelte";
  import Panel from "../ui/Panel.svelte";
  import { createLoad } from "../ui/load.svelte";

  const { onGo }: { onGo: (tab: string) => void } = $props();
  const api = useApi();

  let overview = $state<Overview | null>(null);
  let status = $state<Status | null>(null);
  const load = createLoad(async () => {
    overview = await api.get<Overview>("/overview");
    status = await api.get<Status>("/status");
  });
  $effect(() => {
    untrack(load.load);
  });

  const missing = $derived(
    status
      ? [
          !status.configured.publicKey && "DISCORD_PUBLIC_KEY",
          !status.configured.applicationId && "DISCORD_APPLICATION_ID",
          !status.configured.botToken && "DISCORD_BOT_TOKEN",
        ].filter((v): v is string => !!v)
      : []
  );
  const days = $derived((overview?.days ?? []).map((d) => ({ ...d, day: dayLabel(d.date) })));
  const messages30 = $derived(days.reduce((s, d) => s + d.messages, 0));
  const voiceHours30 = $derived(Math.round(days.reduce((s, d) => s + d.voiceMinutes, 0) / 60));
  // Week over week: the last 7 days against the 7 before.
  const weekDelta = $derived.by(() => {
    const last = days.slice(-7).reduce((s, d) => s + d.messages, 0);
    const before = days.slice(-14, -7).reduce((s, d) => s + d.messages, 0);
    return before > 0 ? Math.round(((last - before) / before) * 1000) / 10 : null;
  });
  const top = $derived(
    (overview?.topGuilds ?? []).map((g) => ({ label: g.name, value: g.messages, note: `${Math.round(g.voiceMinutes / 60)} h in voice` }))
  );
  const messagesFmt = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
</script>

{#if missing.length}
  <Alert variant="warning" title="The bot cannot talk to Discord yet">
    Missing in the API: {missing.join(", ")}.
    <Button variant="outline" size="sm" onclick={() => onGo("setup")}>Open Setup</Button>
  </Alert>
{/if}

<Panel title="Overview" description="Every server this bot knows, together.">
  {#snippet actions()}
    <Button variant="ghost" size="sm" onclick={load.load}>Refresh</Button>
  {/snippet}
  <Loadable load={load} errorTitle="The overview did not load">
    {#snippet skeleton()}
      <div class="skeletons">
        {#each Array.from({ length: 4 }, (_, i) => i) as i (i)}<Skeleton height="5.5rem" />{/each}
      </div>
    {/snippet}
    {#if overview}
      <DashboardGrid columns={4}>
        <KpiCard label="Servers the bot is in" value={overview.totals.activeGuilds} />
        <KpiCard label="Modules on" value={overview.totals.modulesOn} />
        <KpiCard label="Blueprints published" value={`${overview.totals.publishedBlueprints} / ${overview.totals.blueprints}`} />
        <KpiCard label="Members with a balance" value={overview.totals.members} />
        <KpiCard
          label="Messages, 30 days"
          value={messages30}
          delta={weekDelta}
          deltaLabel="% vs the week before"
          trend={days.map((d) => d.messages)}
        />
        <KpiCard label="Hours in voice, 30 days" value={voiceHours30} trend={days.map((d) => d.voiceMinutes)} />
        <KpiCard label="Premium servers" value={overview.totals.premiumGuilds} />
        <KpiCard label="Catalog items" value={overview.totals.items} />
      </DashboardGrid>
    {/if}
  </Loadable>
</Panel>

{#if overview}
  <div class="charts">
    <ChartCard title="Activity, last 30 days" description="Messages and voice minutes per day (UTC), every server." level={2}>
      <LineChart
        data={days}
        x="day"
        xLabel="Day"
        series={[
          { key: "messages", label: "Messages" },
          { key: "voiceMinutes", label: "Voice minutes" },
        ]}
        title="Activity, last 30 days"
        hideTitle
        area
        emptyText="No activity counted yet: switch on Stats or Levels in a server."
      />
    </ChartCard>
    <ChartCard title="Busiest servers" description="Messages in the last 30 days." level={2}>
      <BarList
        data={top}
        ariaLabel="Busiest servers, by messages"
        ranked
        format={(n) => `${messagesFmt.format(n)} msgs`}
        emptyText="No activity counted yet."
      />
      {#snippet footer()}
        <Button variant="ghost" size="sm" onclick={() => onGo("servers")}>Manage servers</Button>
      {/snippet}
    </ChartCard>
  </div>
{/if}

<style>
  .skeletons {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 1rem;
  }

  .charts {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    gap: 1rem;
  }

  @media (max-width: 47.99rem) {
    .charts {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
