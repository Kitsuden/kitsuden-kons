<!-- How observed values are weighed: the threshold and the kinds of evidence with their weight. -->
<script lang="ts">
  import {
    Button,
    Checkbox,
    EmptyState,
    Field,
    Input,
    SaveBar,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components";
  import { untrack } from "svelte";

  import type { Api } from "../api";
  import type { EvidenceKind, EvidencePolicy } from "../types";
  import { createLoad } from "../ui/load.svelte";
  import Loadable from "../ui/Loadable.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";

  const { api }: { api: Api } = $props();

  interface KindRow {
    rowKey: number;
    key: string;
    /** A saved kind keeps its key: observations already point at it. */
    saved: boolean;
    label: string;
    weight: string;
    active: boolean;
    description: string;
  }

  let applyAt = $state("");
  let kinds = $state<KindRow[]>([]);
  let loaded = $state<EvidencePolicy | null>(null);
  let saving = $state(false);
  let keys = 0;

  const toRow = (k: Partial<EvidenceKind>): KindRow => ({
    rowKey: ++keys,
    key: k.key ?? "",
    saved: Boolean(k.key),
    label: k.label ?? "",
    weight: String(k.weight ?? 0),
    active: k.active !== false,
    description: k.description ?? "",
  });

  const body = () => ({
    applyAt: Number(applyAt),
    kinds: kinds.map((k) => ({ key: k.key.trim(), label: k.label.trim(), weight: Number(k.weight), active: k.active })),
  });

  let saved = $state("");
  const dirty = $derived(saved !== "" && JSON.stringify(body()) !== saved);

  function paint(policy: EvidencePolicy) {
    loaded = policy;
    applyAt = String(policy.applyAt);
    kinds = policy.kinds.map(toRow);
    saved = JSON.stringify(body());
  }

  const data = createLoad(async () => {
    paint(await api.get<EvidencePolicy>("evidence-policy"));
  });

  $effect(() => {
    untrack(data.load);
  });

  async function save() {
    saving = true;
    try {
      paint(await api.put<EvidencePolicy>("evidence-policy", body()));
      toast.success("Evidence weights saved", { description: "They apply to what is observed from now on." });
    } catch (e) {
      failed("Could not save the evidence weights", e);
    } finally {
      saving = false;
    }
  }

  const addKind = () => kinds.push(toRow({ weight: 0, active: true }));
</script>

<Panel
  title="Observed data"
  description="Whoever records a value says what kind of evidence it saw, never how sure it is. The weights of different sources that saw the same value add up; from the threshold on, the value is written to the record, below it, it waits for a person. A value a person typed is never overwritten."
>
  <Loadable load={data} errorTitle="The evidence weights did not load" lines={5}>
    <div class="threshold">
      <Field label="Written to the record from">
        <Input type="number" min="1" max="100" bind:value={applyAt} />
      </Field>
    </div>
    {#if kinds.length}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Kind of evidence</TableHead>
            <TableHead>Weight</TableHead>
            <TableHead>On</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each kinds as kind (kind.rowKey)}
            <TableRow>
              <TableCell>
                <Input bind:value={kind.key} readonly={kind.saved} title={kind.description || undefined} aria-label="Key" />
              </TableCell>
              <TableCell><Input bind:value={kind.label} aria-label="Kind of evidence" /></TableCell>
              <TableCell><Input type="number" bind:value={kind.weight} aria-label="Weight" /></TableCell>
              <TableCell><Checkbox bind:checked={kind.active} ariaLabel={`${kind.label || kind.key || "New kind"}: on`} /></TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
      <div><Button size="sm" variant="outline" onclick={addKind}>Add kind</Button></div>
    {:else}
      <EmptyState
        size="sm"
        level={3}
        title="No kinds of evidence yet"
        description="Without kinds, nothing observed can be written to a record."
        actionLabel="Add kind"
        onAction={addKind}
      />
    {/if}
    <SaveBar
      sticky={false}
      savedText="No unsaved changes"
      {dirty}
      {saving}
      saveLabel="Save"
      cancelLabel="Discard"
      ariaLabel="Save the evidence weights"
      onSave={save}
      onCancel={dirty && loaded ? () => paint(loaded!) : undefined}
    />
  </Loadable>
</Panel>

<style>
  .threshold {
    max-width: 16rem;
  }
</style>
