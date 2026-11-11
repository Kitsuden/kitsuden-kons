<!-- The bots: the list, what each row can do, and the dialog that creates one. -->
<script lang="ts">
  import {
    Badge,
    Button,
    ConfirmDialog,
    DataTable,
    Dialog,
    EmptyState,
    Field,
    Input,
    Select,
    type DataColumn,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg, type Api } from "../api";
  import type { Bot } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";

  const {
    api,
    hidden = false,
    onOpen,
    onDeleted,
  }: {
    api: Api;
    /** A bot is open: the list stays loaded, out of sight. */
    hidden?: boolean;
    onOpen: (bot: Bot) => void;
    onDeleted: (bot: Bot) => void;
  } = $props();

  const blank = { name: "", slug: "", agentId: "", audience: "team", toolset: "", greeting: "" };

  let bots = $state<Bot[]>([]);
  let form = $state({ ...blank });
  let adding = $state(false);
  let creating = $state(false);
  let deleting = $state<Bot | null>(null);
  let confirmDelete = $state(false);

  const audience = (b: Bot) => (b.audience === "public" ? "Public" : "Team");

  const columns: DataColumn<Bot>[] = [
    { key: "name", header: "Bot", sortable: true, hideable: false },
    { key: "audience", header: "Audience", sortable: true, value: audience },
    { key: "toolset", header: "Tools", value: (b) => b.toolset || "None" },
    { key: "dailyLimit", header: "Per day", sortable: true, align: "right" },
    { key: "active", header: "State", sortable: true, value: (b) => (b.active ? "On" : "Off") },
  ];

  const data = createLoad(async () => {
    bots = (await api.get<{ data?: Bot[] }>("bots")).data ?? [];
  });

  $effect(() => {
    untrack(data.load);
  });

  async function create() {
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      slug: form.slug.trim(),
      agentId: form.agentId.trim(),
      audience: form.audience,
      greeting: form.greeting.trim() || null,
    };
    if (form.toolset.trim()) body.toolset = form.toolset.trim();
    creating = true;
    try {
      await api.post("bots", body);
      toast.success(`"${body.name}" created`);
      adding = false;
      form = { ...blank };
      await data.load();
    } catch (e) {
      failed("Could not create the bot", e);
    } finally {
      creating = false;
    }
  }

  async function toggle(bot: Bot) {
    try {
      await api.patch(`bots/${seg(bot.id)}`, { active: !bot.active });
      toast.success(`"${bot.name}" switched ${bot.active ? "off" : "on"}`);
      await data.load();
    } catch (e) {
      failed(`Could not switch "${bot.name}" ${bot.active ? "off" : "on"}`, e);
    }
  }

  async function remove() {
    const bot = deleting!;
    try {
      await api.del(`bots/${seg(bot.id)}`);
    } catch (e) {
      failed("Could not delete the bot", e);
      throw e;
    }
    toast.success(`"${bot.name}" deleted`);
    onDeleted(bot);
    await data.load();
  }
</script>

{#if !hidden}
  <Panel title="Bots" description="A bot talks through one of the core's agents: its model, prompt and permissions.">
    {#snippet status()}
      {#if data.ready}<Badge>{bots.length} {bots.length === 1 ? "bot" : "bots"}</Badge>{/if}
    {/snippet}
    {#snippet actions()}
      <Button size="sm" onclick={() => (adding = true)}>New bot</Button>
    {/snippet}
    <DataTable
      caption="Chatbots"
      rows={bots}
      {columns}
      rowKey="id"
      rowLabel={(b) => b.name}
      loading={data.loading}
      error={data.error}
      onRetry={data.load}
    >
      {#snippet cell(b, col)}
        {#if col.key === "name"}
          <span class="name">{b.name}</span> <span class="slug">{b.slug}</span>
        {:else if col.key === "active"}
          <Badge variant={b.active ? "success" : "default"} dot>{b.active ? "On" : "Off"}</Badge>
        {:else if col.key === "dailyLimit"}
          {b.dailyLimit}
        {:else}
          {col.value?.(b)}
        {/if}
      {/snippet}
      {#snippet rowActions(b)}
        <RowMenu
          label={`Actions: ${b.name}`}
          items={[
            { label: "Open", onSelect: () => onOpen(b) },
            { label: b.active ? "Switch off" : "Switch on", onSelect: () => toggle(b) },
            {
              label: "Delete",
              danger: true,
              separated: true,
              onSelect: () => {
                deleting = b;
                confirmDelete = true;
              },
            },
          ]}
        />
      {/snippet}
      {#snippet empty()}
        <EmptyState
          size="sm"
          level={null}
          title="No bots yet"
          description="Create the first one, then teach it and try it."
          actionLabel="New bot"
          onAction={() => (adding = true)}
        />
      {/snippet}
    </DataTable>
  </Panel>
{/if}

<Dialog
  bind:open={adding}
  title="New bot"
  description="A public bot answers anyone on a website from what you teach it, with no tools. A team bot may use one tool group."
  size="xl"
  closeLabel={CLOSE}
>
  <FormGrid label="New bot" onsubmit={create}>
    <Field label="Name" required>
      <Input bind:value={form.name} autocomplete="off" />
    </Field>
    <Field label="Slug" required>
      <Input bind:value={form.slug} placeholder="help" autocomplete="off" spellcheck="false" />
    </Field>
    <Field label="Core agent id" required>
      <Input bind:value={form.agentId} autocomplete="off" spellcheck="false" />
    </Field>
    <Field label="Audience">
      <Select
        bind:value={form.audience}
        options={[
          { value: "team", label: "Team" },
          { value: "public", label: "Public" },
        ]}
      />
    </Field>
    <Field label="Tool group (team only)" class="wide">
      <Input bind:value={form.toolset} placeholder="kon:crm/assistant" autocomplete="off" spellcheck="false" />
    </Field>
    <Field label="Greeting" class="wide">
      <Input bind:value={form.greeting} />
    </Field>
    {#snippet actions()}
      <Button variant="ghost" onclick={() => (adding = false)}>{CANCEL}</Button>
      <Button type="submit" loading={creating}>Create bot</Button>
    {/snippet}
  </FormGrid>
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete "${deleting?.name ?? ""}"?`}
  description="What it knows and its conversations are deleted with it."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={remove}
/>

<style>
  .name {
    font-weight: 600;
  }

  .slug {
    margin-left: 0.25rem;
    white-space: nowrap;
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
