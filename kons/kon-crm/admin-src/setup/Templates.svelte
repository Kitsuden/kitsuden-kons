<!-- Document templates: the list, the one being edited, and a try on a deal that saves nothing. -->
<script lang="ts">
  import {
    Button,
    Checkbox,
    Input,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Textarea,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { fail, ok, seg, type Api, type Note } from "../api";
  import type { DocumentTemplate, RenderedTemplate } from "../types";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import Panel from "../ui/Panel.svelte";
  import Result from "../ui/Result.svelte";
  import Row from "../ui/Row.svelte";

  /** `reload` changes when a preset may have added templates. */
  const { api, reload }: { api: Api; reload: number } = $props();

  let templates = $state<DocumentTemplate[]>([]);
  let editing = $state<string | null>(null);
  let form = $state({ name: "", description: "", body: "", active: true, dealId: "" });
  let preview = $state("");
  let note = $state<Note | null>(null);
  let busy = $state<"save" | "try" | null>(null);

  async function load() {
    try {
      templates = (await api.get<{ data?: DocumentTemplate[] }>("document-templates", { include: "all" })).data ?? [];
    } catch (e) {
      note = fail(e);
    }
  }

  $effect(() => {
    void reload;
    untrack(load);
  });

  function edit(t: DocumentTemplate | null) {
    editing = t?.id ?? null;
    form = { ...form, name: t?.name ?? "", description: t?.description ?? "", body: t?.body ?? "", active: t?.active ?? true };
    preview = "";
    note = ok(t ? `Editing "${t.name}".` : "New template.");
  }

  async function save() {
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      body: form.body,
      active: form.active,
    };
    if (!body.name || !body.body.trim()) return (note = { ok: false, lines: ["A template needs a name and text."] });
    busy = "save";
    try {
      const saved = editing
        ? await api.put<DocumentTemplate>(`document-templates/${seg(editing)}`, body)
        : await api.post<DocumentTemplate>("document-templates", body);
      editing = saved.id;
      note = ok("Saved.");
      await load();
    } catch (e) {
      note = fail(e);
    } finally {
      busy = null;
    }
  }

  async function tryOn() {
    if (!editing) return (note = { ok: false, lines: ["Save the template first."] });
    const dealId = form.dealId.trim();
    busy = "try";
    try {
      const r = await api.post<RenderedTemplate>(`document-templates/${seg(editing)}/render`, dealId ? { dealId } : {});
      preview = r.content;
      note = ok(
        r.missing.length
          ? `Left unfilled: ${r.missing.join(", ")}. Nothing was saved or sent.`
          : "Everything filled. Nothing was saved or sent."
      );
    } catch (e) {
      note = fail(e);
    } finally {
      busy = null;
    }
  }
</script>

<Panel title="Document templates">
  <p class="lead">
    Placeholders: <code>{"{{deal.title}}"}</code>, <code>{"{{contact.firstName}}"}</code>,
    <code>{"{{company.name}}"}</code>, <code>{"{{custom.field}}"}</code>, <code>{"{{date.today}}"}</code>, and
    <code>{"{{ask.anything}}"}</code> for what is asked when filling it.
  </p>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Template</TableHead>
        <TableHead>On</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each templates as t (t.id)}
        <TableRow>
          <TableCell>{t.name}</TableCell>
          <TableCell>{t.active ? "Yes" : "No"}</TableCell>
          <TableCell><Button size="sm" variant="ghost" onclick={() => edit(t)}>Edit</Button></TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={3} text="No templates" />
      {/each}
    </TableBody>
  </Table>
  <Row>
    <Input bind:value={form.name} placeholder="Name" aria-label="Template name" />
    <Input bind:value={form.description} placeholder="Description" aria-label="Template description" />
    <Checkbox bind:checked={form.active} label="On" />
  </Row>
  <div class="mono">
    <Textarea bind:value={form.body} rows={10} aria-label="Template text" />
  </div>
  <Row>
    <Button size="sm" loading={busy === "save"} onclick={save}>Save template</Button>
    <Button size="sm" variant="outline" onclick={() => edit(null)}>New</Button>
    <Input bind:value={form.dealId} placeholder="Deal id to try it on" aria-label="Deal id to try the template on" />
    <Button size="sm" variant="outline" loading={busy === "try"} onclick={tryOn}>Try</Button>
  </Row>
  <Result {note} />
  {#if preview}<pre class="preview">{preview}</pre>{/if}
</Panel>

<style>
  .lead {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }

  code,
  .mono :global(.ta-textarea),
  .preview {
    font-family: var(--ta-font-mono);
  }

  code {
    font-size: 0.75rem;
  }

  .preview {
    margin: 0.5rem 0 0;
    padding: 0.75rem;
    white-space: pre-wrap;
    font-size: 0.75rem;
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
  }
</style>
