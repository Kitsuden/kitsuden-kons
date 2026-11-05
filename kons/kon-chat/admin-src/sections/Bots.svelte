<!-- The bots: the list with their switches, and a form to create one. -->
<script lang="ts">
  import {
    Button,
    ConfirmDialog,
    Input,
    Select,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { fail, ok, seg, type Api, type Note } from "../api";
  import type { Bot } from "../types";
  import Actions from "../ui/Actions.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import Result from "../ui/Result.svelte";
  import Row from "../ui/Row.svelte";

  const {
    api,
    onOpen,
    onDeleted,
  }: { api: Api; onOpen: (bot: Bot) => void; onDeleted: (bot: Bot) => void } = $props();

  let bots = $state<Bot[]>([]);
  let note = $state<Note | null>(null);
  let form = $state({ name: "", slug: "", agentId: "", audience: "team", toolset: "", greeting: "" });
  let creating = $state(false);
  let deleting = $state<Bot | null>(null);
  let confirmDelete = $state(false);

  async function load() {
    try {
      bots = (await api.get<{ data?: Bot[] }>("bots")).data ?? [];
    } catch (e) {
      note = fail(e);
    }
  }

  $effect(() => {
    untrack(load);
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
      note = ok("Created.");
      await load();
    } catch (e) {
      note = fail(e);
    } finally {
      creating = false;
    }
  }

  async function toggle(bot: Bot) {
    try {
      await api.patch(`bots/${seg(bot.id)}`, { active: !bot.active });
      await load();
    } catch (e) {
      note = fail(e);
    }
  }

  async function remove() {
    const bot = deleting!;
    try {
      await api.del(`bots/${seg(bot.id)}`);
    } catch (e) {
      note = fail(e);
      throw e;
    }
    onDeleted(bot);
    await load();
  }
</script>

<Panel title="Chatbots">
  <p class="lead">
    A bot talks through one of the core's agents (its model, prompt and permissions). A <b>public</b> bot answers anyone on
    a website from what you teach it, with no tools. A <b>team</b> bot may use one tool group, such as
    <code>kon:crm/assistant</code>.
  </p>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Bot</TableHead>
        <TableHead>Audience</TableHead>
        <TableHead>Tools</TableHead>
        <TableHead>Per day</TableHead>
        <TableHead>On</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each bots as b (b.id)}
        <TableRow>
          <TableCell>{b.name} ({b.slug})</TableCell>
          <TableCell>{b.audience === "public" ? "Public" : "Team"}</TableCell>
          <TableCell>{b.toolset || "none"}</TableCell>
          <TableCell>{b.dailyLimit}</TableCell>
          <TableCell>{b.active ? "Yes" : "No"}</TableCell>
          <TableCell>
            <Actions>
              <Button size="sm" variant="ghost" onclick={() => onOpen(b)}>Open</Button>
              <Button size="sm" variant="ghost" onclick={() => toggle(b)}>{b.active ? "Switch off" : "Switch on"}</Button>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  deleting = b;
                  confirmDelete = true;
                }}>Delete</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={6} text="No bots" />
      {/each}
    </TableBody>
  </Table>
  <Row>
    <Input bind:value={form.name} placeholder="Name" aria-label="Bot name" />
    <Input bind:value={form.slug} placeholder="slug (help, sales-assistant)" aria-label="Bot slug" />
    <Input bind:value={form.agentId} placeholder="Agent id" aria-label="Core agent id" />
    <Select
      bind:value={form.audience}
      options={[
        { value: "team", label: "Team" },
        { value: "public", label: "Public" },
      ]}
      aria-label="Audience"
    />
    <Input bind:value={form.toolset} placeholder="kon:crm/assistant (team only)" aria-label="Tool group" />
    <Input bind:value={form.greeting} placeholder="Greeting" aria-label="Greeting" />
    <Button size="sm" loading={creating} onclick={create}>Create</Button>
  </Row>
  <Result {note} />
</Panel>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete "${deleting?.name ?? ""}" with what it knows and its conversations?`}
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={remove}
/>

<style>
  .lead {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }

  code {
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
  }
</style>
