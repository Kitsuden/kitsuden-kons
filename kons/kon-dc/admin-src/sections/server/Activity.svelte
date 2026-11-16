<!--
  Activity of one server: messages and voice minutes per day over a window, the totals and the
  members who wrote and talked most. Counted while Stats or Levels is on in the server.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import { BarList, ChartCard, DashboardGrid, KpiCard, LineChart, ToggleGroup } from "$lib/components";

  import { useApi } from "../../context";
  import type { Activity } from "../../types";
  import Loadable from "../../ui/Loadable.svelte";
  import Panel from "../../ui/Panel.svelte";
  import { createLoad } from "../../ui/load.svelte";

  const { guildId }: { guildId: string } = $props();
  const api = useApi();

  let windowDays = $state("30");
  let activity = $state<Activity | null>(null);
  const load = createLoad(async () => {
    activity = await api.get<Activity>(`/guilds/${guildId}/activity?days=${windowDays}`);
  });
  $effect(() => {
    void guildId;
    void windowDays;
    untrack(load.load);
  });

  const days = $derived((activity?.days ?? []).map((d) => ({ ...d, day: d.date.slice(5) })));
  const busiest = $derived(days.reduce<{ day: string; messages: number } | null>((b, d) => (!b || d.messages > b.messages ? d : b), null));
  const ranked = (rows: Activity["topMessages"], unit: (n: number) => string) =>
    rows.map((r) => ({ label: r.name ?? r.userId, value: r.value, note: unit(r.value) }));
</script>

<Panel title="Activity" description="Messages and voice per day (UTC), counted while Stats or Levels is on.">
  {#snippet actions()}
    <ToggleGroup
      label="Window"
      variant="segmented"
      bind:value={windowDays}
      options={[
        { value: "7", label: "7 days" },
        { value: "30", label: "30 days" },
        { value: "90", label: "90 days" },
      ]}
    />
  {/snippet}
  <Loadable load={load} errorTitle="The activity did not load">
    {#if activity}
      <DashboardGrid columns={4}>
        <KpiCard label="Messages" value={activity.totals.messages} trend={days.map((d) => d.messages)} />
        <KpiCard label="Hours in voice" value={Math.round(activity.totals.voiceMinutes / 60)} trend={days.map((d) => d.voiceMinutes)} />
        <KpiCard label="Active members" value={activity.totals.members} />
        <KpiCard label="Busiest day" value={busiest && busiest.messages > 0 ? busiest.day : "—"} />
      </DashboardGrid>
    {/if}
  </Loadable>
</Panel>

{#if activity}
  <ChartCard title="Per day" level={2}>
    <LineChart
      data={days}
      x="day"
      xLabel="Day"
      series={[
        { key: "messages", label: "Messages" },
        { key: "voiceMinutes", label: "Voice minutes" },
      ]}
      title="Per day"
      hideTitle
      area
      emptyText="Nothing counted in this window."
    />
  </ChartCard>
  <div class="tops">
    <ChartCard title="Most messages" level={2}>
      <BarList data={ranked(activity.topMessages, (n) => `${n} messages`)} ariaLabel="Most messages" ranked emptyText="Nobody wrote in this window." />
    </ChartCard>
    <ChartCard title="Most time in voice" level={2}>
      <BarList
        data={ranked(activity.topVoice, (n) => `${Math.round((n / 60) * 10) / 10} h`)}
        ariaLabel="Most time in voice"
        ranked
        emptyText="Nobody talked in this window."
      />
    </ChartCard>
  </div>
{/if}

<style>
  .tops {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }

  @media (max-width: 47.99rem) {
    .tops {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
