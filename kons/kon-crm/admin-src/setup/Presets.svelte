<!-- Ready-made setups: an entity with its fields, a pipeline, templates and the ledger's words. -->
<script lang="ts">
  import { Alert, Button, DataTable, EmptyState, type DataColumn } from "$lib/components";
  import { untrack } from "svelte";

  import { seg, type Api } from "../api";
  import type { Preset, PresetResult } from "../types";
  import { createLoad } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";

  const { api, onApplied }: { api: Api; onApplied: () => void } = $props();

  let presets = $state<Preset[]>([]);
  /** What the last preset added and what to do next: a report to read, so it stays on screen. */
  let report = $state<{ title: string; lines: string[] } | null>(null);
  let applying = $state<string | null>(null);

  const columns: DataColumn<Preset>[] = [
    { key: "name", header: "Setup", sortable: true, hideable: false },
    { key: "description", header: "What it adds" },
  ];

  const data = createLoad(async () => {
    presets = (await api.get<{ data: Preset[] }>("presets")).data;
  });

  $effect(() => {
    untrack(data.load);
  });

  async function apply(preset: Preset) {
    applying = preset.id;
    try {
      const r = await api.post<PresetResult>(`presets/${seg(preset.id)}/apply`, {});
      report = {
        title: r.created.length ? `Added: ${r.created.join(", ")}.` : "Nothing new: it was already applied.",
        lines: [
          r.conta ? "The ledger uses its words." : "kon-conta is not installed here: the ledger was left alone.",
          ...(r.profiles ?? []).map(
            (p) =>
              `Suggested profile "${p.profile}": ${p.records} records, amounts ${p.money ? "yes" : "no"}, sensitive ${p.sensitive ? "yes" : "no"}. Grant it in "Score, evidence and access".`
          ),
          ...(r.nextSteps ?? []).map((s) => `Next: ${s}`),
        ],
      };
      toast.success(`"${preset.name}" applied`);
      onApplied();
    } catch (e) {
      failed(`Could not apply "${preset.name}"`, e);
    } finally {
      applying = null;
    }
  }
</script>

<Panel
  title="Ready-made setups"
  description="A preset adds an entity with its fields, a pipeline, templates and, with kon-conta, the words the ledger uses. What already exists by name stays as it is."
>
  <DataTable
    caption="Ready-made setups"
    rows={presets}
    {columns}
    rowKey="id"
    rowLabel={(p) => p.name}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet rowActions(p)}
      <Button size="sm" variant="outline" ariaLabel={`Apply ${p.name}`} loading={applying === p.id} onclick={() => apply(p)}>
        Apply
      </Button>
    {/snippet}
    {#snippet empty()}
      <EmptyState
        size="sm"
        level={null}
        title="No ready-made setups"
        description="This installation ships none: build the pipeline, forms and templates in the sections below."
      />
    {/snippet}
  </DataTable>
  {#if report}
    <Alert variant="success" title={report.title} onDismiss={() => (report = null)}>
      <ul class="report">
        {#each report.lines as line, i (i)}<li>{line}</li>{/each}
      </ul>
    </Alert>
  {/if}
</Panel>

<style>
  .report {
    margin: 0.25rem 0 0;
    padding-left: 1.125rem;
  }
</style>
