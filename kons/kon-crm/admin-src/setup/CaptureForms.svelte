<!-- Capture forms: the public endpoints a website posts leads to. -->
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
  import type { CaptureForm, Pipeline } from "../types";
  import Actions from "../ui/Actions.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import Result from "../ui/Result.svelte";
  import Row from "../ui/Row.svelte";

  /** `reload` changes when a preset may have added forms. */
  const { api, reload }: { api: Api; reload: number } = $props();

  let forms = $state<CaptureForm[]>([]);
  let pipelines = $state<Pipeline[]>([]);
  let note = $state<Note | null>(null);
  let form = $state({ name: "", target: "", source: "" });
  let creating = $state(false);
  let deleting = $state<CaptureForm | null>(null);
  let confirmDelete = $state(false);

  const targets = $derived([
    { value: "", label: "Only create the contact" },
    ...pipelines.flatMap((p) => (p.stages ?? []).map((s) => ({ value: `${p.id}|${s.id}`, label: `${p.name} → ${s.name}` }))),
  ]);

  function where(f: CaptureForm) {
    const p = pipelines.find((x) => x.id === f.pipelineId);
    const s = p?.stages?.find((x) => x.id === f.stageId);
    return p ? `${p.name} → ${s?.name ?? "?"}` : "Contact only";
  }

  async function load() {
    try {
      const [{ data }, list] = await Promise.all([
        api.get<{ data: CaptureForm[] }>("capture-forms"),
        api.get<{ data?: Pipeline[] } | Pipeline[]>("pipelines"),
      ]);
      const ids = Array.isArray(list) ? list : (list.data ?? []);
      pipelines = await Promise.all(
        ids.map((p) => api.get<{ data?: Pipeline } & Pipeline>(`pipelines/${seg(p.id)}`).then((r) => r.data ?? r))
      );
      forms = data;
    } catch (e) {
      note = fail(e);
    }
  }

  $effect(() => {
    void reload;
    untrack(load);
  });

  async function create() {
    const name = form.name.trim();
    if (!name) return (note = { ok: false, lines: ["Give the form a name."] });
    const [pipelineId, stageId] = form.target ? form.target.split("|") : [null, null];
    creating = true;
    try {
      const created = await api.post<CaptureForm>("capture-forms", {
        name,
        source: form.source.trim() || null,
        pipelineId,
        stageId,
      });
      note = ok(`Created. Websites post to /api/crm/public/forms/${created.id}`);
      await load();
    } catch (e) {
      note = fail(e);
    } finally {
      creating = false;
    }
  }

  async function toggle(f: CaptureForm) {
    try {
      await api.patch(`capture-forms/${seg(f.id)}`, { active: !f.active });
      await load();
    } catch (e) {
      note = fail(e);
    }
  }

  async function remove() {
    try {
      await api.del(`capture-forms/${seg(deleting!.id)}`);
    } catch (e) {
      note = fail(e);
      throw e;
    }
    await load();
  }
</script>

<Panel title="Capture forms">
  <p class="lead">
    A website posts to <code>/api/crm/public/forms/&lt;id&gt;</code> with <code>email</code>, <code>firstName</code>,
    <code>lastName</code>, <code>phone</code>, <code>companyName</code>, <code>message</code>, and an empty hidden
    <code>website</code> field that catches bots.
  </p>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Form</TableHead>
        <TableHead>Leads go to</TableHead>
        <TableHead>Source</TableHead>
        <TableHead>On</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each forms as f (f.id)}
        <TableRow>
          <TableCell>{f.name}<br /><code class="id">{f.id}</code></TableCell>
          <TableCell>{where(f)}</TableCell>
          <TableCell>{f.source ?? "form"}</TableCell>
          <TableCell>{f.active ? "Yes" : "No"}</TableCell>
          <TableCell>
            <Actions>
              <Button size="sm" variant="ghost" onclick={() => toggle(f)}>{f.active ? "Switch off" : "Switch on"}</Button>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  deleting = f;
                  confirmDelete = true;
                }}>Delete</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={5} text="No forms" />
      {/each}
    </TableBody>
  </Table>
  <Row>
    <Input bind:value={form.name} placeholder="Form name" aria-label="Form name" />
    <Select bind:value={form.target} options={targets} aria-label="Where leads go" />
    <Input bind:value={form.source} placeholder="Source, e.g. website" aria-label="Source" />
    <Button size="sm" loading={creating} onclick={create}>Create form</Button>
  </Row>
  <Result {note} />
</Panel>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete "${deleting?.name ?? ""}"?`}
  description="Websites posting to it will get 404. Contacts already captured stay."
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

  .id {
    color: rgb(var(--ta-text-dim));
  }
</style>
