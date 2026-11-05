<!-- How observed values are weighed: the threshold and the kinds of evidence with their weight. -->
<script lang="ts">
  import {
    Button,
    Checkbox,
    Field,
    Input,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { fail, ok, type Api, type Note } from "../api";
  import type { EvidenceKind, EvidencePolicy } from "../types";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import Panel from "../ui/Panel.svelte";
  import Result from "../ui/Result.svelte";
  import Row from "../ui/Row.svelte";

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
  let note = $state<Note | null>(null);
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

  function paint(policy: EvidencePolicy) {
    applyAt = String(policy.applyAt);
    kinds = policy.kinds.map(toRow);
  }

  $effect(() => {
    untrack(async () => {
      try {
        paint(await api.get<EvidencePolicy>("evidence-policy"));
      } catch (e) {
        note = fail(e);
      }
    });
  });

  async function save() {
    saving = true;
    try {
      const policy = await api.put<EvidencePolicy>("evidence-policy", {
        applyAt: Number(applyAt),
        kinds: kinds.map((k) => ({ key: k.key.trim(), label: k.label.trim(), weight: Number(k.weight), active: k.active })),
      });
      paint(policy);
      note = ok("Saved. It applies to what is observed from now on.");
    } catch (e) {
      note = fail(e);
    } finally {
      saving = false;
    }
  }
</script>

<Panel title="Observed data">
  <p class="lead">
    Whoever records a value says what kind of evidence it saw, never how sure it is. The weights of different sources
    that saw the same value add up; from the threshold on, the value is written to the record, below it, it waits for a
    person. A value a person typed is never overwritten.
  </p>
  <div class="threshold">
    <Field label="Written to the record from">
      <Input type="number" min="1" max="100" bind:value={applyAt} />
    </Field>
  </div>
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
          <TableCell><Checkbox bind:checked={kind.active} ariaLabel="On" /></TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={4} text="No kinds of evidence" />
      {/each}
    </TableBody>
  </Table>
  <Row>
    <Button size="sm" variant="outline" onclick={() => kinds.push(toRow({ weight: 0, active: true }))}>Add kind</Button>
    <Button size="sm" loading={saving} onclick={save}>Save</Button>
  </Row>
  <Result {note} />
</Panel>

<style>
  .lead {
    margin: 0 0 0.75rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }

  .threshold {
    max-width: 16rem;
  }
</style>
