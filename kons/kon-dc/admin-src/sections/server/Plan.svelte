<!--
  Plan and member page of one server. The plan (free or premium, until when, where it came from)
  decides which modules the server can switch on; a shop kon can set it too. The member page is
  the server's public web page (rankings, the store, a Discord login), shown while its module is on.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import { Alert, Badge, Button, CopyButton, DescriptionList, Field, Input, Switch, ToggleGroup } from "$lib/components";

  import { useApi, when } from "../../context";
  import type { ModuleState, Plan } from "../../types";
  import FormGrid from "../../ui/FormGrid.svelte";
  import Loadable from "../../ui/Loadable.svelte";
  import Panel from "../../ui/Panel.svelte";
  import { createLoad } from "../../ui/load.svelte";
  import { failed, toast } from "../../ui/notify";

  const {
    guildId,
    modules,
    onGoModules,
  }: { guildId: string; modules: ModuleState[]; onGoModules: () => void } = $props();
  const api = useApi();

  let plan = $state<Plan | null>(null);
  let draft = $state<{ plan: string; noEnd: boolean; until: string; source: string }>({ plan: "free", noEnd: true, until: "", source: "" });
  const load = createLoad(async () => {
    plan = await api.get<Plan>(`/guilds/${guildId}/plan`);
    draft = {
      plan: plan.plan,
      noEnd: !plan.until,
      until: plan.until ? plan.until.slice(0, 10) : "",
      source: plan.source ?? "",
    };
  });
  $effect(() => {
    void guildId;
    untrack(load.load);
  });

  let saving = $state(false);
  const validUntil = $derived(draft.plan === "free" || draft.noEnd || /^\d{4}-\d{2}-\d{2}$/.test(draft.until));
  async function save() {
    if (!validUntil) return;
    saving = true;
    try {
      plan = await api.put<Plan>(`/guilds/${guildId}/plan`, {
        plan: draft.plan,
        until: draft.plan === "premium" && !draft.noEnd ? new Date(`${draft.until}T23:59:59Z`).toISOString() : null,
        ...(draft.source.trim() ? { source: draft.source.trim() } : {}),
      });
      toast.success(draft.plan === "premium" ? "The server is premium" : "The server is on the free plan");
    } catch (e) {
      failed("The plan did not change", e);
    } finally {
      saving = false;
    }
  }

  const memberPage = $derived(modules.find((m) => m.id === "member-page"));
  const pageUrl = $derived(api.url(`/member/page/${guildId}`));
  const premiumNames = $derived((plan?.premiumModules ?? []).map((id) => modules.find((m) => m.id === id)?.name ?? id));
</script>

<Panel title="Plan" description="Premium unlocks the modules this installation keeps for premium servers.">
  {#snippet status()}
    {#if plan}
      <Badge variant={plan.active ? "success" : "default"}>{plan.active ? "Premium" : "Free"}</Badge>
    {/if}
  {/snippet}
  <Loadable load={load} errorTitle="The plan did not load">
    {#if plan}
      <DescriptionList
        ariaLabel="Plan"
        columns={2}
        items={[
          { label: "Plan", value: plan.plan === "premium" ? "Premium" : "Free" },
          { label: "Until", value: plan.plan === "premium" ? (plan.until ? when(plan.until) : "No end") : null },
          { label: "Came from", value: plan.source },
          { label: "Premium modules", value: premiumNames.join(", ") || "None: every module is free" },
          { label: "Blueprints on a free server", value: plan.freeBlueprints ?? "No limit" },
        ]}
      />
      {#if plan.plan === "premium" && !plan.active}
        <Alert variant="warning">The premium plan ended: its modules stopped by themselves, their settings are kept.</Alert>
      {/if}
      <FormGrid label="Change the plan" onsubmit={save}>
        <ToggleGroup
          label="Plan"
          variant="segmented"
          bind:value={draft.plan}
          options={[
            { value: "free", label: "Free" },
            { value: "premium", label: "Premium" },
          ]}
        />
        {#if draft.plan === "premium"}
          <Switch bind:checked={draft.noEnd} label="No end date" />
          {#if !draft.noEnd}
            <Field label="Until (inclusive)">
              <Input type="date" bind:value={draft.until} />
            </Field>
          {/if}
          <Field label="Came from (an order id, a gift…)">
            <Input bind:value={draft.source} maxlength={100} />
          </Field>
        {/if}
        {#snippet actions()}
          <Button type="submit" loading={saving} disabled={!validUntil}>Save plan</Button>
        {/snippet}
      </FormGrid>
    {/if}
  </Loadable>
</Panel>

<Panel title="Member page" description="The server's web page: rankings, the store and each member's stats, with a Discord login.">
  {#snippet status()}
    <Badge variant={memberPage?.enabled ? "success" : "default"}>{memberPage?.enabled ? "On" : "Off"}</Badge>
  {/snippet}
  {#if memberPage?.enabled}
    <div class="link">
      <code>{pageUrl}</code>
      <CopyButton text={pageUrl} label="Copy the link" />
      <Button variant="outline" size="sm" href={pageUrl} target="_blank" rel="noopener">Open</Button>
    </div>
    <p class="quiet">What it shows (rankings, store, stats) is in the Member page module's settings.</p>
  {:else}
    <p class="quiet">Switch on the Member page module to publish it. Logging in needs DISCORD_CLIENT_SECRET, DISCORD_OAUTH_REDIRECT_URL and DISCORD_MEMBER_SECRET in the API.</p>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={onGoModules}>Go to modules</Button>
  {/snippet}
</Panel>

<style>
  .link {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .link code {
    overflow-wrap: anywhere;
  }

  .quiet {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
