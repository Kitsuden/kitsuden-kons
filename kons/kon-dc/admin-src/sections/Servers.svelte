<!--
  Servers: per Discord server, which modules are on and with what settings, the slash commands
  Discord should have (and the push to Discord), and the live panels the bot keeps.

  A module's settings are drawn as a form when tallao's SchemaForm can draw its schema, and as JSON
  otherwise (a list of ids, a list of rules); the server validates both with the module's own zod
  schema and answers with the problems.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import {
    Alert,
    Badge,
    Button,
    DataTable,
    Dialog,
    Field,
    Input,
    SchemaForm,
    Select,
    Switch,
    Tabs,
    Textarea,
    type DataColumn,
    type TabItem,
  } from "$lib/components";

  import { useApi, when } from "../context";
  import type { Guild, ModuleState, Panel as PanelRow, SlashCommand } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Loadable from "../ui/Loadable.svelte";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";
  import { createLoad, message } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import { remembered } from "../ui/remember.svelte";
  import { formable, fromJson, toJson } from "../ui/settings";
  import Activity from "./server/Activity.svelte";
  import Economy from "./server/Economy.svelte";
  import Plan from "./server/Plan.svelte";
  import Schedules from "./server/Schedules.svelte";

  const api = useApi();
  const SNOWFLAKE = /^\d{15,20}$/;

  // ── Servers ────────────────────────────────────────────────────────────────
  let guilds = $state<Guild[]>([]);
  // The server picked survives switching to another tab and back.
  let guildId = $state(remembered.guildId);
  $effect(() => {
    remembered.guildId = guildId;
  });
  const guildsLoad = createLoad(async () => {
    guilds = (await api.get<{ docs: Guild[] }>("/guilds")).docs;
    if (!guildId || !guilds.some((g) => g.id === guildId)) guildId = guilds.find((g) => !g.leftAt)?.id ?? guilds[0]?.id ?? "";
  });
  $effect(() => {
    untrack(guildsLoad.load);
  });
  const guildOptions = $derived(guilds.map((g) => ({ value: g.id, label: g.leftAt ? `${g.name} (bot left)` : g.name })));
  const current = $derived(guilds.find((g) => g.id === guildId) ?? null);

  let newGuild = $state({ id: "", name: "" });
  let registering = $state(false);
  async function register() {
    registering = true;
    try {
      await api.put(`/guilds/${newGuild.id}`, { name: newGuild.name.trim() });
      toast.success("Server registered");
      guildId = newGuild.id;
      newGuild = { id: "", name: "" };
      await guildsLoad.load();
    } catch (e) {
      failed("Could not register the server", e);
    } finally {
      registering = false;
    }
  }

  // ── The chosen server's tabs ───────────────────────────────────────────────
  const serverTabs: TabItem[] = [
    { id: "modules", label: "Modules & commands" },
    { id: "economy", label: "Economy" },
    { id: "activity", label: "Activity" },
    { id: "schedules", label: "Scheduled" },
    { id: "plan", label: "Plan & member page" },
  ];


  // ── Modules, commands and panels of the chosen server ──────────────────────
  let modules = $state<ModuleState[]>([]);
  let commands = $state<SlashCommand[]>([]);
  let commandsError = $state<string | null>(null);
  let panels = $state<PanelRow[]>([]);

  const modulesLoad = createLoad(async () => {
    if (!guildId) return;
    modules = (await api.get<{ docs: ModuleState[] }>(`/guilds/${guildId}/modules`)).docs;
  });
  const panelsLoad = createLoad(async () => {
    if (!guildId) return;
    panels = (await api.get<{ docs: PanelRow[] }>(`/guilds/${guildId}/panels`)).docs;
  });
  async function loadCommands() {
    if (!guildId) return;
    try {
      commands = (await api.get<{ docs: SlashCommand[] }>(`/guilds/${guildId}/commands`)).docs;
      commandsError = null;
    } catch (e) {
      commands = [];
      commandsError = message(e);
    }
  }
  $effect(() => {
    if (!guildId) return;
    untrack(() => {
      void modulesLoad.load();
      void panelsLoad.load();
      void loadCommands();
    });
  });

  const moduleColumns: DataColumn<ModuleState>[] = [
    { key: "enabled", header: "On", width: "4.5rem" },
    { key: "name", header: "Module", sortable: true },
    { key: "kind", header: "Kind", value: (m) => (m.id.startsWith("blueprint-") ? "Blueprint" : "Built-in") },
    { key: "panels", header: "Panels", value: (m) => m.panels.join(", ") || "—" },
  ];

  let toggling = $state<string | null>(null);
  async function toggle(m: ModuleState, enabled: boolean) {
    toggling = m.id;
    try {
      await api.put(`/guilds/${guildId}/modules/${m.id}`, { enabled, config: m.config });
      toast.success(`${m.name} ${enabled ? "on" : "off"}`, { description: "Sync the commands for Discord to see the change." });
      await modulesLoad.load();
      await loadCommands();
    } catch (e) {
      // Usually: it has required settings nobody gave yet.
      failed(`Could not switch ${m.name} ${enabled ? "on" : "off"}`, e);
      if (enabled) openSettings(m, true);
      await modulesLoad.load();
    } finally {
      toggling = null;
    }
  }

  // Settings dialog.
  let settingsOpen = $state(false);
  let editing = $state<ModuleState | null>(null);
  let enableOnSave = $state(false);
  let formValue = $state<Record<string, unknown>>({});
  let jsonText = $state("{}");
  let settingsError = $state<string | null>(null);
  let saving = $state(false);
  const asForm = $derived(editing ? formable(editing.configSchema) : false);

  function openSettings(m: ModuleState, enable = false) {
    editing = m;
    enableOnSave = enable || m.enabled;
    formValue = structuredClone($state.snapshot(m.config)) as Record<string, unknown>;
    jsonText = toJson(m.config);
    settingsError = null;
    settingsOpen = true;
  }

  async function saveSettings(config: unknown) {
    if (!editing) return;
    saving = true;
    settingsError = null;
    try {
      await api.put(`/guilds/${guildId}/modules/${editing.id}`, { enabled: enableOnSave, config });
      toast.success(`${editing.name} saved`);
      settingsOpen = false;
      await modulesLoad.load();
      await loadCommands();
    } catch (e) {
      settingsError = message(e);
    } finally {
      saving = false;
    }
  }

  function saveJson() {
    const parsed = fromJson(jsonText);
    if (!parsed.ok) settingsError = parsed.error;
    else void saveSettings(parsed.value);
  }

  // Commands.
  let syncing = $state(false);
  async function sync() {
    syncing = true;
    try {
      const r = await api.post<{ synced: SlashCommand[] }>(`/guilds/${guildId}/commands/sync`);
      toast.success(`Discord has ${r.synced.length} command${r.synced.length === 1 ? "" : "s"} for this server`);
      commands = r.synced;
    } catch (e) {
      failed("Discord did not take the commands", e);
    } finally {
      syncing = false;
    }
  }

  const commandLabel = (c: SlashCommand) => {
    const subs = (c.options ?? []).filter((o) => o.type === 1).map((o) => o.name);
    return subs.length ? `/${c.name} ${subs.join(" | ")}` : `/${c.name}`;
  };

  // Panels.
  const panelColumns: DataColumn<PanelRow>[] = [
    { key: "panel", header: "Panel", value: (p) => `${moduleName(p.moduleId)} · ${p.panelId}` },
    { key: "channelId", header: "Channel" },
    { key: "refreshedAt", header: "Last redraw", value: (p) => when(p.refreshedAt) },
  ];
  const moduleName = (id: string) => modules.find((m) => m.id === id)?.name ?? id;
  const withPanels = $derived(modules.filter((m) => m.enabled && m.panels.length));

  let postOpen = $state(false);
  let post = $state({ moduleId: "", panelId: "", channelId: "" });
  let posting = $state(false);
  const postPanels = $derived(withPanels.find((m) => m.id === post.moduleId)?.panels ?? []);
  function openPost() {
    const first = withPanels[0];
    post = { moduleId: first?.id ?? "", panelId: first?.panels[0] ?? "", channelId: "" };
    postOpen = true;
  }
  async function postPanel() {
    posting = true;
    try {
      await api.post(`/guilds/${guildId}/panels`, post);
      toast.success("Panel posted");
      postOpen = false;
      await panelsLoad.load();
    } catch (e) {
      failed("Could not post the panel", e);
    } finally {
      posting = false;
    }
  }
  let redrawing = $state(false);
  async function redraw() {
    redrawing = true;
    try {
      const r = await api.post<{ panels: number }>(`/guilds/${guildId}/panels/refresh`, {});
      toast.success(`${r.panels} panel${r.panels === 1 ? "" : "s"} redrawn`);
      await panelsLoad.load();
    } catch (e) {
      failed("Could not redraw the panels", e);
    } finally {
      redrawing = false;
    }
  }
</script>

<Panel title="Server">
  <Loadable
    load={guildsLoad}
    empty={guilds.length === 0}
    emptyTitle="No servers yet"
    emptyDescription="A server appears when the bot joins it (with the gateway worker), or register it by its id below."
    errorTitle="The servers did not load"
  >
    <Field label="Server">
      <Select bind:value={guildId} options={guildOptions} />
    </Field>
    {#if current?.leftAt}
      <Alert variant="warning">The bot left this server on {when(current.leftAt)}. Its settings are kept.</Alert>
    {/if}
  </Loadable>
  <FormGrid label="Register a server" onsubmit={() => SNOWFLAKE.test(newGuild.id) && newGuild.name.trim() && register()}>
    <Field label="Server id">
      <Input bind:value={newGuild.id} inputmode="numeric" placeholder="123456789012345678" />
    </Field>
    <Field label="Name">
      <Input bind:value={newGuild.name} maxlength={100} />
    </Field>
    {#snippet actions()}
      <Button variant="secondary" type="submit" loading={registering} disabled={!SNOWFLAKE.test(newGuild.id) || !newGuild.name.trim()}>
        Register
      </Button>
    {/snippet}
  </FormGrid>
</Panel>

{#if guildId}
  <Tabs items={serverTabs} bind:value={remembered.serverTab} ariaLabel={current ? `Server: ${current.name}` : "Server"} variant="pills" wrap>
    {#snippet children(id)}
      <div class="server-tab">
      {#if id === "economy"}
        <Economy {guildId} />
      {:else if id === "activity"}
        <Activity {guildId} />
      {:else if id === "schedules"}
        <Schedules {guildId} {moduleName} />
      {:else if id === "plan"}
        <Plan {guildId} {modules} onGoModules={() => (remembered.serverTab = "modules")} />
      {:else}
  <Panel title="Modules">
    <DataTable
      caption="Modules of this server"
      rows={modules}
      columns={moduleColumns}
      rowKey="id"
      rowLabel={(m) => m.name}
      loading={modulesLoad.loading}
      error={modulesLoad.error}
      onRetry={modulesLoad.load}
    >
      {#snippet cell(m, col)}
        {#if col.key === "enabled"}
          <Switch
            checked={m.enabled}
            ariaLabel={`${m.name} on`}
            disabled={toggling === m.id}
            onchange={(on) => void toggle(m, on)}
          />
        {:else if col.key === "name"}
          <div class="module">
            <span class="name">{m.name}</span>
            <span class="description">{m.description}</span>
          </div>
        {:else}
          {col.value?.(m)}
        {/if}
      {/snippet}
      {#snippet rowActions(m)}
        <RowMenu label={`Actions: ${m.name}`} items={[{ label: "Settings", onSelect: () => openSettings(m) }]} />
      {/snippet}
    </DataTable>
  </Panel>

  <Panel title="Slash commands">
    {#snippet status()}
      <Badge>{commands.length}</Badge>
    {/snippet}
    {#snippet actions()}
      <Button size="sm" loading={syncing} disabled={!!commandsError} onclick={sync}>Sync to Discord</Button>
    {/snippet}
    {#if commandsError}
      <Alert variant="error" title="These commands cannot be synced">{commandsError}</Alert>
    {:else if commands.length === 0}
      <p class="quiet">No module that is on has commands.</p>
    {:else}
      <ul class="commands">
        {#each commands as c (c.name)}
          <li><code>{commandLabel(c)}</code> <span class="quiet">{c.description}</span></li>
        {/each}
      </ul>
    {/if}
  </Panel>

  <Panel title="Live panels">
    {#snippet actions()}
      <Button variant="ghost" size="sm" loading={redrawing} disabled={panels.length === 0} onclick={redraw}>Redraw all</Button>
      <Button size="sm" disabled={withPanels.length === 0} onclick={openPost}>Post a panel</Button>
    {/snippet}
    <DataTable
      caption="Live panels of this server"
      rows={panels}
      columns={panelColumns}
      rowKey="messageId"
      rowLabel={(p) => p.panelId}
      loading={panelsLoad.loading}
      error={panelsLoad.error}
      onRetry={panelsLoad.load}
      emptyText="No panels in this server"
    >
      {#snippet cell(p, col)}
        {#if col.key === "channelId"}<code>{p.channelId}</code>{:else}{col.value?.(p)}{/if}
      {/snippet}
    </DataTable>
  </Panel>
      {/if}
      </div>
    {/snippet}
  </Tabs>
{/if}

<Dialog bind:open={settingsOpen} title={editing ? `${editing.name}: settings` : "Settings"} closeLabel={CLOSE} size="lg">
  <div class="dialog-stack">
  {#if editing}
    <p class="quiet">{editing.description}</p>
    <Switch bind:checked={enableOnSave} label="On in this server" />
    {#if settingsError}<Alert variant="error" title="Not saved">{settingsError}</Alert>{/if}
    {#if asForm}
      <SchemaForm schema={editing.configSchema} bind:value={formValue} submitLabel="Save" onsubmit={(v) => void saveSettings(v)} />
    {:else}
      <Field label="Settings (JSON)">
        <Textarea bind:value={jsonText} rows={12} mono spellcheck="false" />
      </Field>
    {/if}
  {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (settingsOpen = false)}>{CANCEL}</Button>
    {#if !asForm}<Button loading={saving} onclick={saveJson}>Save</Button>{/if}
  {/snippet}
</Dialog>

<Dialog bind:open={postOpen} title="Post a live panel" closeLabel={CLOSE}>
  <FormGrid label="Post a live panel" onsubmit={() => SNOWFLAKE.test(post.channelId) && post.panelId && postPanel()}>
    <Field label="Module">
      <Select
        bind:value={post.moduleId}
        options={withPanels.map((m) => ({ value: m.id, label: m.name }))}
        onchange={() => (post.panelId = postPanels[0] ?? "")}
      />
    </Field>
    <Field label="Panel">
      <Select bind:value={post.panelId} options={postPanels.map((p) => ({ value: p, label: p }))} />
    </Field>
    <Field label="Channel id">
      <Input bind:value={post.channelId} inputmode="numeric" placeholder="123456789012345678" />
    </Field>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (postOpen = false)}>{CANCEL}</Button>
    <Button loading={posting} disabled={!SNOWFLAKE.test(post.channelId) || !post.panelId} onclick={postPanel}>Post</Button>
  {/snippet}
</Dialog>

<style>
  .server-tab {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding-top: 0.5rem;
  }

  .dialog-stack {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .module {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 12rem;
  }

  .name {
    font-weight: 500;
  }

  .description,
  .quiet {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .commands {
    display: grid;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  code {
    font-size: 0.8125rem;
  }
</style>
