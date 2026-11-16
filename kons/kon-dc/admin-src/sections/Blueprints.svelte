<!--
  Blueprints: the bot's behaviour as data. The list, an editor that checks the definition against the
  server's own schema before saving (and says where each problem is), publishing (a published
  blueprint becomes a module every server can switch on), and the ready-made templates with the
  settings and the agent-key scopes each one needs.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import {
    Alert,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    ConfirmDialog,
    DataTable,
    Dialog,
    Field,
    Input,
    SchemaForm,
    Textarea,
    type DataColumn,
  } from "$lib/components";

  import { useApi, when } from "../context";
  import type { Blueprint, Generated, Template } from "../types";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Loadable from "../ui/Loadable.svelte";
  import Panel from "../ui/Panel.svelte";
  import BlueprintEditor from "./BlueprintEditor.svelte";
  import RowMenu, { type RowAction } from "../ui/RowMenu.svelte";
  import { createLoad, message } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import { formable, fromJson, toJson } from "../ui/settings";

  const api = useApi();

  let blueprints = $state<Blueprint[]>([]);
  const list = createLoad(async () => {
    blueprints = (await api.get<{ docs: Blueprint[] }>("/blueprints")).docs;
  });
  let templates = $state<Template[]>([]);
  const templatesLoad = createLoad(async () => {
    templates = (await api.get<{ docs: Template[] }>("/templates")).docs;
  });
  $effect(() => {
    untrack(() => {
      void list.load();
      void templatesLoad.load();
    });
  });

  const columns: DataColumn<Blueprint>[] = [
    { key: "name", header: "Name", sortable: true },
    { key: "status", header: "Status", sortable: true },
    { key: "revision", header: "Revision", align: "right" },
    { key: "updatedAt", header: "Changed", sortable: true, value: (b) => when(b.updatedAt) },
  ];

  // ── Editor: the visual one, in place of the list ───────────────────────────
  let editorFor = $state<{ blueprint: Blueprint | null; draft?: { name: string; definition: Record<string, unknown> } } | null>(null);
  const edit = (b: Blueprint | null) => (editorFor = { blueprint: b });

  // ── Describe a bot: a core agent writes the blueprint, the editor opens on it ─
  let describe = $state({ prompt: "", agentId: "" });
  let generating = $state(false);
  async function generate() {
    if (describe.prompt.trim().length < 10 || !describe.agentId.trim()) {
      toast.error("Describe the bot (a sentence or more) and name the agent that writes it");
      return;
    }
    generating = true;
    try {
      const r = await api.post<Generated>("/blueprints/generate", { prompt: describe.prompt.trim(), agentId: describe.agentId.trim() });
      if (!r.definition) {
        toast.error("The agent did not write a blueprint", { description: r.problems[0]?.message });
        return;
      }
      if (r.problems.length) {
        toast.warning(`Opened with ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"} to fix`, { description: "The outline marks where." });
      }
      editorFor = { blueprint: null, draft: { name: describe.prompt.trim().slice(0, 60), definition: r.definition } };
    } catch (e) {
      failed("Could not write the blueprint", e);
    } finally {
      generating = false;
    }
  }
  function closeEditor(saved: boolean) {
    editorFor = null;
    if (saved) void list.load();
  }

  async function setStatus(b: Blueprint, status: "draft" | "published") {
    try {
      await api.patch(`/blueprints/${b.id}`, { status });
      toast.success(status === "published" ? `${b.name} published` : `${b.name} back to draft`);
      await list.load();
    } catch (e) {
      failed("Could not change the blueprint", e);
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  let deleting = $state<Blueprint | null>(null);
  let confirmOpen = $state(false);
  async function remove() {
    if (!deleting) return;
    try {
      await api.del(`/blueprints/${deleting.id}`);
      toast.success(`${deleting.name} deleted`);
      await list.load();
    } catch (e) {
      failed("Could not delete the blueprint", e);
    }
  }

  const menu = (b: Blueprint): RowAction[] => [
    { label: "Edit", onSelect: () => edit(b) },
    b.status === "published"
      ? { label: "Back to draft", onSelect: () => void setStatus(b, "draft") }
      : { label: "Publish", onSelect: () => void setStatus(b, "published") },
    {
      label: "Delete",
      danger: true,
      separated: true,
      onSelect: () => {
        deleting = b;
        confirmOpen = true;
      },
    },
  ];

  // ── Templates ──────────────────────────────────────────────────────────────
  let installOpen = $state(false);
  let installing = $state<Template | null>(null);
  let installValue = $state<Record<string, unknown>>({});
  let installJson = $state("{}");
  let installName = $state("");
  let installError = $state<string | null>(null);
  let busy = $state(false);
  const installAsForm = $derived(installing ? formable(installing.optionsSchema) : false);

  function openInstall(t: Template) {
    installing = t;
    installValue = {};
    installJson = "{}";
    installName = t.name;
    installError = null;
    installOpen = true;
  }

  async function install(options: unknown) {
    if (!installing) return;
    busy = true;
    installError = null;
    try {
      await api.post(`/templates/${installing.id}/install`, { name: installName.trim() || undefined, options });
      toast.success(`${installName || installing.name} installed as a draft`, { description: "Review it, then publish it." });
      installOpen = false;
      await list.load();
    } catch (e) {
      installError = message(e);
    } finally {
      busy = false;
    }
  }

  function installFromJson() {
    const parsed = fromJson(installJson);
    if (!parsed.ok) installError = parsed.error;
    else void install(parsed.value);
  }
</script>

{#if editorFor}
  {#key editorFor}
    <BlueprintEditor blueprint={editorFor.blueprint} draft={editorFor.draft ?? null} onclose={closeEditor} />
  {/key}
{:else}
<Panel title="Blueprints">
  {#snippet status()}
    <Badge>{blueprints.length}</Badge>
  {/snippet}
  {#snippet actions()}
    <Button size="sm" onclick={() => edit(null)}>New blueprint</Button>
  {/snippet}
  <DataTable
    caption="Blueprints"
    rows={blueprints}
    {columns}
    rowKey="id"
    rowLabel={(b) => b.name}
    loading={list.loading}
    error={list.error}
    onRetry={list.load}
    emptyText="No blueprints yet"
  >
    {#snippet cell(b, col)}
      {#if col.key === "status"}
        <Badge variant={b.status === "published" ? "success" : "default"}>{b.status === "published" ? "Published" : "Draft"}</Badge>
      {:else if col.key === "name"}
        <span class="name">{b.name}</span>
      {:else}
        {col.value ? col.value(b) : b[col.key as keyof Blueprint]}
      {/if}
    {/snippet}
    {#snippet rowActions(b)}
      <RowMenu label={`Actions: ${b.name}`} items={menu(b)} />
    {/snippet}
  </DataTable>
</Panel>

<Panel title="Describe a bot">
  <form
    class="describe"
    onsubmit={(e) => {
      e.preventDefault();
      void generate();
    }}
  >
    <Field label="What should it do?">
      <Textarea bind:value={describe.prompt} rows={4} maxlength={2000} placeholder="E.g. a /daily that gives 100 coins once a day, and a shop button that sells the VIP role for 500." />
    </Field>
    <Field label="Agent (a core agent id; its model writes it, with no tools)">
      <Input bind:value={describe.agentId} maxlength={100} placeholder="e.g. builder" />
    </Field>
    <div class="describe-actions"><Button type="submit" size="sm" loading={generating}>Write the blueprint</Button></div>
  </form>
</Panel>

<Panel title="Templates">
  <Loadable load={templatesLoad} empty={templates.length === 0} emptyTitle="No templates" errorTitle="The templates did not load">
    <div class="templates">
      {#each templates as t (t.id)}
        <Card>
          <CardHeader>
            <CardTitle level={3}>{t.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <p class="quiet">{t.description}</p>
            {#if t.needs.kons.length}
              <div class="needs">
                {#each t.needs.kons as k (k)}<Badge variant="info">{k}</Badge>{/each}
              </div>
            {/if}
            {#if t.needs.scopes.length}
              <details>
                <summary>Scopes for the bot's agent key ({t.needs.scopes.length})</summary>
                <ul class="scopes">
                  {#each t.needs.scopes as s (s)}<li><code>{s}</code></li>{/each}
                </ul>
              </details>
            {/if}
            <div class="end">
              <Button size="sm" variant="secondary" onclick={() => openInstall(t)}>Install</Button>
            </div>
          </CardContent>
        </Card>
      {/each}
    </div>
  </Loadable>
</Panel>

{/if}

<Dialog bind:open={installOpen} title={installing ? `Install ${installing.name}` : "Install"} closeLabel={CLOSE} size="lg">
  <div class="dialog-stack">
  {#if installing}
    <Field label="Name">
      <Input bind:value={installName} maxlength={100} />
    </Field>
    {#if installError}<Alert variant="error" title="Not installed">{installError}</Alert>{/if}
    {#if installAsForm}
      <SchemaForm schema={installing.optionsSchema} bind:value={installValue} submitLabel="Install" onsubmit={(v) => void install(v)} />
    {:else}
      <Field label="Settings (JSON)">
        <Textarea bind:value={installJson} rows={8} mono spellcheck="false" />
      </Field>
      <details>
        <summary>What the settings take</summary>
        <pre>{toJson(installing.optionsSchema.properties)}</pre>
      </details>
    {/if}
  {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (installOpen = false)}>{CANCEL}</Button>
    {#if !installAsForm}<Button loading={busy} onclick={installFromJson}>Install</Button>{/if}
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmOpen}
  title={deleting ? `Delete ${deleting.name}?` : "Delete?"}
  description="It is switched off in every server and its live panels stop updating. Export first to keep a copy."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={remove}
/>

<style>
  .dialog-stack {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .name {
    font-weight: 500;
  }

  .quiet {
    margin: 0 0 0.5rem;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .describe {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .describe-actions {
    display: flex;
    justify-content: flex-end;
  }

  .templates {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
    gap: 1rem;
  }

  .needs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
  }

  .scopes {
    margin: 0.25rem 0 0;
    padding-left: 1rem;
  }

  .end {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.75rem;
  }

  details summary {
    cursor: pointer;
    font-size: 0.8125rem;
  }

  pre {
    max-height: 16rem;
    overflow: auto;
    font-size: 0.75rem;
  }

  code {
    font-size: 0.75rem;
  }
</style>
