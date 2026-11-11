<!-- Capture forms: the public endpoints a website posts leads to. -->
<script lang="ts">
  import {
    Badge,
    Button,
    ConfirmDialog,
    DataTable,
    EmptyState,
    Field,
    Input,
    Select,
    type DataColumn,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg, type Api } from "../api";
  import type { CaptureForm, Pipeline } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";

  /** `reload` changes when a preset may have added forms. */
  const { api, reload }: { api: Api; reload: number } = $props();

  let forms = $state<CaptureForm[]>([]);
  let pipelines = $state<Pipeline[]>([]);
  let form = $state({ name: "", target: "", source: "" });
  let creating = $state(false);
  let deleting = $state<CaptureForm | null>(null);
  let confirmDelete = $state(false);
  let nameInput = $state<HTMLElement | null>(null);

  const targets = $derived([
    { value: "", label: "Only create the contact" },
    ...pipelines.flatMap((p) => (p.stages ?? []).map((s) => ({ value: `${p.id}|${s.id}`, label: `${p.name} → ${s.name}` }))),
  ]);

  function where(f: CaptureForm) {
    const p = pipelines.find((x) => x.id === f.pipelineId);
    const s = p?.stages?.find((x) => x.id === f.stageId);
    return p ? `${p.name} → ${s?.name ?? "?"}` : "Contact only";
  }

  const columns: DataColumn<CaptureForm>[] = [
    { key: "name", header: "Form", sortable: true, hideable: false },
    { key: "target", header: "Leads go to", sortable: true, value: where },
    { key: "source", header: "Source", sortable: true, value: (f) => f.source ?? "form" },
    { key: "active", header: "State", sortable: true, value: (f) => (f.active ? "On" : "Off") },
  ];

  const data = createLoad(async () => {
    const [{ data: list }, pipes] = await Promise.all([
      api.get<{ data: CaptureForm[] }>("capture-forms"),
      api.get<{ data?: Pipeline[] } | Pipeline[]>("pipelines"),
    ]);
    const ids = Array.isArray(pipes) ? pipes : (pipes.data ?? []);
    pipelines = await Promise.all(
      ids.map((p) => api.get<{ data?: Pipeline } & Pipeline>(`pipelines/${seg(p.id)}`).then((r) => r.data ?? r))
    );
    forms = list;
  });

  $effect(() => {
    void reload;
    untrack(data.load);
  });

  async function create() {
    const name = form.name.trim();
    if (!name) return toast.error("Give the form a name");
    const [pipelineId, stageId] = form.target ? form.target.split("|") : [null, null];
    creating = true;
    try {
      const created = await api.post<CaptureForm>("capture-forms", {
        name,
        source: form.source.trim() || null,
        pipelineId,
        stageId,
      });
      toast.success("Form created", { description: `Websites post to /api/crm/public/forms/${created.id}` });
      await data.load();
    } catch (e) {
      failed("Could not create the form", e);
    } finally {
      creating = false;
    }
  }

  async function toggle(f: CaptureForm) {
    try {
      await api.patch(`capture-forms/${seg(f.id)}`, { active: !f.active });
      toast.success(`"${f.name}" switched ${f.active ? "off" : "on"}`);
      await data.load();
    } catch (e) {
      failed(`Could not switch "${f.name}" ${f.active ? "off" : "on"}`, e);
    }
  }

  async function remove() {
    const f = deleting!;
    try {
      await api.del(`capture-forms/${seg(f.id)}`);
    } catch (e) {
      failed(`Could not delete "${f.name}"`, e);
      throw e;
    }
    toast.success(`"${f.name}" deleted`);
    await data.load();
  }
</script>

<Panel title="Capture forms" description="The public endpoints a website posts leads to.">
  {#snippet status()}
    {#if data.ready}<Badge>{forms.length} {forms.length === 1 ? "form" : "forms"}</Badge>{/if}
  {/snippet}
  <p class="lead">
    A website posts to <code>/api/crm/public/forms/&lt;id&gt;</code> with <code>email</code>, <code>firstName</code>,
    <code>lastName</code>, <code>phone</code>, <code>companyName</code>, <code>message</code>, and an empty hidden
    <code>website</code> field that catches bots.
  </p>
  <DataTable
    caption="Capture forms"
    rows={forms}
    {columns}
    rowKey="id"
    rowLabel={(f) => f.name}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(f, col)}
      {#if col.key === "name"}
        {f.name}<br /><code class="id">{f.id}</code>
      {:else if col.key === "active"}
        <Badge variant={f.active ? "success" : "default"} dot>{f.active ? "On" : "Off"}</Badge>
      {:else}
        {col.value?.(f)}
      {/if}
    {/snippet}
    {#snippet rowActions(f)}
      <RowMenu
        label={`Actions: ${f.name}`}
        items={[
          { label: f.active ? "Switch off" : "Switch on", onSelect: () => toggle(f) },
          {
            label: "Delete",
            danger: true,
            separated: true,
            onSelect: () => {
              deleting = f;
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
        title="No capture forms yet"
        description="Create one and point a website's form at it."
        actionLabel="New form"
        onAction={() => nameInput?.querySelector("input")?.focus()}
      />
    {/snippet}
  </DataTable>

  <h3 class="sub">New form</h3>
  <FormGrid label="New capture form" onsubmit={create}>
    <div bind:this={nameInput}>
      <Field label="Form name" required>
        <Input bind:value={form.name} />
      </Field>
    </div>
    <Field label="Where leads go">
      <Select bind:value={form.target} options={targets} />
    </Field>
    <Field label="Source">
      <Input bind:value={form.source} placeholder="website" />
    </Field>
    {#snippet actions()}
      <Button type="submit" loading={creating}>Create form</Button>
    {/snippet}
  </FormGrid>
</Panel>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete "${deleting?.name ?? ""}"?`}
  description="Websites posting to it will get 404. Contacts already captured stay."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={remove}
/>

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

  code {
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }

  .id {
    color: rgb(var(--ta-text-dim));
  }
</style>
