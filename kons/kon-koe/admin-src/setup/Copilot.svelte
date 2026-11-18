<!--
  The copilot: the core agent that writes drafts, summaries and translations for people in the inbox. It runs
  with no tools and only reads the conversation it is asked about. Empty turns it off.
-->
<script lang="ts">
  import { Badge, Field, Input, SaveBar } from "$lib/components";
  import { untrack } from "svelte";

  import type { Api } from "../api";
  import Loadable from "../ui/Loadable.svelte";
  import { createLoad } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";

  const { api }: { api: Api } = $props();

  interface CopilotConfig {
    enabled: boolean;
    agentId: string | null;
    agentEngine: boolean;
  }

  let config = $state<CopilotConfig | null>(null);
  let agentId = $state("");
  let saving = $state(false);

  const data = createLoad(async () => {
    config = (await api.get<{ data: CopilotConfig }>("config/copilot")).data;
    agentId = config.agentId ?? "";
  });
  $effect(() => {
    untrack(data.load);
  });

  const dirty = $derived(!!config && agentId.trim() !== (config.agentId ?? ""));

  async function save() {
    saving = true;
    try {
      const value = agentId.trim() || null;
      await api.put("config/copilot", { agentId: value });
      toast.success(value ? "Copilot agent saved" : "Copilot turned off");
      await data.load();
    } catch (e) {
      failed("Could not save the copilot", e);
    } finally {
      saving = false;
    }
  }
</script>

<Panel title="Copilot" description="The core agent that suggests replies, summarizes and translates for people in the inbox. It never sends anything.">
  {#snippet status()}
    {#if config}
      <Badge variant={config.enabled ? "success" : "default"} dot>{config.enabled ? "On" : "Off"}</Badge>
    {/if}
  {/snippet}
  <Loadable load={data} errorTitle="Could not read the copilot setting" lines={2}>
    {#if config && !config.agentEngine}
      <p class="warn">This installation has no agent engine: the copilot cannot run until it has one.</p>
    {/if}
    <Field label="Core agent id (empty: off)">
      <Input bind:value={agentId} autocomplete="off" spellcheck="false" maxlength={100} />
    </Field>
    <SaveBar
      sticky={false}
      {dirty}
      {saving}
      disableWhenClean
      saveLabel={agentId.trim() ? "Save" : "Turn off"}
      savedText="No unsaved changes"
      onSave={save}
      onCancel={dirty ? () => (agentId = config?.agentId ?? "") : undefined}
      cancelLabel="Discard"
      ariaLabel="Save the copilot agent"
    />
  </Loadable>
</Panel>

<style>
  .warn {
    margin: 0;
    color: rgb(var(--ta-warning));
    font-size: 0.8125rem;
  }
</style>
