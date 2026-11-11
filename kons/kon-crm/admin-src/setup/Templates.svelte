<!-- Document templates: the list, the one being edited, and a try on a deal that saves nothing. -->
<script lang="ts">
  import {
    Alert,
    Badge,
    Button,
    Checkbox,
    DataTable,
    EmptyState,
    Field,
    Input,
    SaveBar,
    Textarea,
    type DataColumn,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg, type Api } from "../api";
  import type { DocumentTemplate, RenderedTemplate } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { createLoad } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";

  /** `reload` changes when a preset may have added templates. */
  const { api, reload }: { api: Api; reload: number } = $props();

  const blank = { name: "", description: "", body: "", active: true };

  let templates = $state<DocumentTemplate[]>([]);
  let editing = $state<string | null>(null);
  let form = $state({ ...blank, dealId: "" });
  let preview = $state("");
  /** What the try left unfilled: read next to the preview. */
  let outcome = $state<string | null>(null);
  let busy = $state<"save" | "try" | null>(null);
  let editor = $state<HTMLElement | null>(null);

  const fields = () => JSON.stringify({ name: form.name, description: form.description, body: form.body, active: form.active });
  let saved = $state(JSON.stringify(blank));
  const dirty = $derived(fields() !== saved);
  const editingName = $derived(templates.find((t) => t.id === editing)?.name);

  const columns: DataColumn<DocumentTemplate>[] = [
    { key: "name", header: "Template", sortable: true, hideable: false },
    { key: "description", header: "Description", value: (t) => t.description ?? "—" },
    { key: "active", header: "State", sortable: true, value: (t) => (t.active ? "On" : "Off") },
  ];

  const data = createLoad(async () => {
    templates = (await api.get<{ data?: DocumentTemplate[] }>("document-templates", { include: "all" })).data ?? [];
  });

  $effect(() => {
    void reload;
    untrack(data.load);
  });

  function edit(t: DocumentTemplate | null) {
    editing = t?.id ?? null;
    form = { ...form, name: t?.name ?? "", description: t?.description ?? "", body: t?.body ?? "", active: t?.active ?? true };
    saved = fields();
    preview = "";
    outcome = null;
    editor?.querySelector("input")?.focus();
  }

  async function save() {
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      body: form.body,
      active: form.active,
    };
    if (!body.name || !body.body.trim()) return toast.error("A template needs a name and text");
    busy = "save";
    try {
      const answer = editing
        ? await api.put<DocumentTemplate>(`document-templates/${seg(editing)}`, body)
        : await api.post<DocumentTemplate>("document-templates", body);
      editing = answer.id;
      saved = fields();
      toast.success(`"${body.name}" saved`);
      await data.load();
    } catch (e) {
      failed("Could not save the template", e);
    } finally {
      busy = null;
    }
  }

  async function tryOn() {
    if (!editing) return toast.error("Save the template first");
    const dealId = form.dealId.trim();
    busy = "try";
    try {
      const r = await api.post<RenderedTemplate>(`document-templates/${seg(editing)}/render`, dealId ? { dealId } : {});
      preview = r.content;
      outcome = r.missing.length
        ? `Left unfilled: ${r.missing.join(", ")}. Nothing was saved or sent.`
        : "Everything filled. Nothing was saved or sent.";
    } catch (e) {
      failed("Could not try the template", e);
    } finally {
      busy = null;
    }
  }
</script>

<Panel title="Document templates" description="The texts a deal is turned into: letters, proposals, contracts.">
  {#snippet status()}
    {#if data.ready}<Badge>{templates.length} {templates.length === 1 ? "template" : "templates"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button size="sm" onclick={() => edit(null)}>New template</Button>
  {/snippet}
  <DataTable
    caption="Document templates"
    rows={templates}
    {columns}
    rowKey="id"
    rowLabel={(t) => t.name}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(t, col)}
      {#if col.key === "active"}
        <Badge variant={t.active ? "success" : "default"} dot>{t.active ? "On" : "Off"}</Badge>
      {:else if col.key === "name"}
        {t.name}{#if t.id === editing}<span class="now"><Badge variant="accent">Editing</Badge></span>{/if}
      {:else}
        {col.value?.(t)}
      {/if}
    {/snippet}
    {#snippet rowActions(t)}
      <Button size="sm" variant="ghost" ariaLabel={`Edit ${t.name}`} onclick={() => edit(t)}>Edit</Button>
    {/snippet}
    {#snippet empty()}
      <EmptyState
        size="sm"
        level={null}
        title="No templates yet"
        description="Write the first one in the editor below, or apply a ready-made setup."
      />
    {/snippet}
  </DataTable>

  <h3 class="sub">{editing ? `Editing "${editingName ?? "…"}"` : "New template"}</h3>
  <p class="lead">
    Placeholders: <code>{"{{deal.title}}"}</code>, <code>{"{{contact.firstName}}"}</code>,
    <code>{"{{company.name}}"}</code>, <code>{"{{custom.field}}"}</code>, <code>{"{{date.today}}"}</code>, and
    <code>{"{{ask.anything}}"}</code> for what is asked when filling it.
  </p>
  <div class="editor" bind:this={editor}>
    <Field label="Name" required>
      <Input bind:value={form.name} />
    </Field>
    <Field label="Description">
      <Input bind:value={form.description} />
    </Field>
    <div class="mono wide">
      <Field label="Text" required>
        <Textarea bind:value={form.body} rows={10} />
      </Field>
    </div>
    <div class="wide"><Checkbox bind:checked={form.active} label="On: it can be used on deals" /></div>
  </div>
  <SaveBar
    sticky={false}
    savedText="No unsaved changes"
    {dirty}
    saving={busy === "save"}
    saveLabel="Save template"
    cancelLabel="Discard"
    ariaLabel="Save the template"
    onSave={save}
    onCancel={dirty ? () => edit(templates.find((t) => t.id === editing) ?? null) : undefined}
  />

  <h3 class="sub">Try it on a deal</h3>
  <FormGrid label="Try the template on a deal" onsubmit={tryOn}>
    <Field label="Deal id (empty: no deal)">
      <Input bind:value={form.dealId} />
    </Field>
    {#snippet actions()}
      <Button type="submit" variant="secondary" loading={busy === "try"}>Try</Button>
    {/snippet}
  </FormGrid>
  {#if outcome}<Alert variant="info" onDismiss={() => (outcome = null)}>{outcome}</Alert>{/if}
  {#if preview}<pre class="preview" aria-label="The template filled in">{preview}</pre>{/if}
</Panel>

<style>
  .lead {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .sub {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .now {
    margin-left: 0.5rem;
  }

  .editor {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
    gap: 0.75rem;
  }

  .wide {
    grid-column: 1 / -1;
  }

  code,
  .mono :global(.ta-textarea),
  .preview {
    font-family: var(--ta-font-mono);
  }

  code {
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }

  .preview {
    margin: 0;
    padding: 0.75rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.75rem;
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
  }
</style>
