<!-- Ready-made setups: an entity with its fields, a pipeline, templates and the ledger's words. -->
<script lang="ts">
  import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components";
  import { untrack } from "svelte";

  import { fail, ok, seg, type Api, type Note } from "../api";
  import type { Preset, PresetResult } from "../types";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import Panel from "../ui/Panel.svelte";
  import Result from "../ui/Result.svelte";

  const { api, onApplied }: { api: Api; onApplied: () => void } = $props();

  let presets = $state<Preset[]>([]);
  let note = $state<Note | null>(null);
  let applying = $state<string | null>(null);

  $effect(() => {
    untrack(async () => {
      try {
        presets = (await api.get<{ data: Preset[] }>("presets")).data;
      } catch (e) {
        note = fail(e);
      }
    });
  });

  async function apply(preset: Preset) {
    applying = preset.id;
    try {
      const r = await api.post<PresetResult>(`presets/${seg(preset.id)}/apply`, {});
      note = ok(
        r.created.length ? `Added: ${r.created.join(", ")}.` : "Nothing new: it was already applied.",
        r.conta ? "The ledger uses its words." : "kon-conta is not installed here: the ledger was left alone.",
        ...(r.profiles ?? []).map(
          (p) =>
            `Suggested profile "${p.profile}": ${p.records} records, amounts ${p.money ? "yes" : "no"}, sensitive ${p.sensitive ? "yes" : "no"}. Grant it in "Score, evidence and access".`
        ),
        ...(r.nextSteps ?? []).map((s) => `Next: ${s}`)
      );
      onApplied();
    } catch (e) {
      note = fail(e);
    } finally {
      applying = null;
    }
  }
</script>

<Panel title="Ready-made setups">
  <p class="lead">
    A preset adds an entity with its fields, a pipeline, templates and, with kon-conta, the words the ledger uses. What
    already exists by name stays as it is.
  </p>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Setup</TableHead>
        <TableHead>What it adds</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each presets as p (p.id)}
        <TableRow>
          <TableCell>{p.name}</TableCell>
          <TableCell>{p.description}</TableCell>
          <TableCell>
            <Button size="sm" variant="outline" loading={applying === p.id} onclick={() => apply(p)}>Apply</Button>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={3} text="No setups" />
      {/each}
    </TableBody>
  </Table>
  <Result {note} />
</Panel>

<style>
  .lead {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
