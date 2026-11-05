<!--
  The score rules as a table anyone can read, and the guide in Markdown. Saving makes a new version;
  "Try on a contact" shows what the rules on screen give before anything is saved.
-->
<script lang="ts">
  import {
    Button,
    Field,
    Input,
    Select,
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
  import type { ScoreModel, ScorePreview, ScoreRule } from "../types";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import Panel from "../ui/Panel.svelte";
  import Result from "../ui/Result.svelte";
  import Row from "../ui/Row.svelte";

  const { api }: { api: Api } = $props();

  const OPS = ["==", "!=", ">=", "<="].map((o) => ({ value: o, label: o }));

  interface RuleRow {
    /** Only for the list on screen; `id` is what the API keeps. */
    key: number;
    id: string;
    label: string;
    signal: string;
    op: string;
    value: string;
    points: string;
  }

  let model = $state<ScoreModel | null>(null);
  let rules = $state<RuleRow[]>([]);
  let guide = $state("");
  let contactId = $state("");
  let note = $state<Note | null>(null);
  let busy = $state<"save" | "try" | "recalculate" | null>(null);
  let keys = 0;

  const signals = $derived(Object.entries(model?.signals ?? {}));

  /** The catalog, plus the rule's own signal when the catalog no longer has it. */
  function signalOptions(signal: string) {
    const list = signals.map(([value, label]) => ({ value, label }));
    if (signal && !signals.some(([k]) => k === signal)) list.push({ value: signal, label: signal });
    return list;
  }

  function toRow(rule: ScoreRule): RuleRow {
    return {
      key: ++keys,
      id: rule.id ?? `rule-${Date.now()}`,
      label: rule.label ?? "",
      signal: rule.signal ?? signals[0]?.[0] ?? "",
      op: rule.op ?? "==",
      value: String(rule.value ?? ""),
      points: String(rule.points ?? 0),
    };
  }

  /** `true`, `false` and numbers go as what they are: `"true"` would never match a signal. */
  function parseValue(text: string): string | number | boolean {
    if (text === "true") return true;
    if (text === "false") return false;
    return text !== "" && !Number.isNaN(Number(text)) ? Number(text) : text;
  }

  const body = () =>
    rules.map((r) => ({
      id: r.id,
      label: r.label,
      signal: r.signal,
      op: r.op,
      value: parseValue(String(r.value)),
      points: Number(r.points),
    }));

  async function load() {
    try {
      model = await api.get<ScoreModel>("score-model");
      guide = model.guide ?? "";
      rules = (model.rules ?? []).map(toRow);
    } catch (e) {
      note = fail(e);
    }
  }

  $effect(() => {
    untrack(load);
  });

  async function save() {
    busy = "save";
    try {
      const saved = await api.put<ScoreModel>("score-model", { rules: body(), guide });
      model = { ...model, ...saved };
      note = ok(`Saved as version ${saved.version}. Scores change when you recalculate.`);
    } catch (e) {
      note = fail(e);
    } finally {
      busy = null;
    }
  }

  async function tryOn() {
    const id = contactId.trim();
    if (!id) return (note = { ok: false, lines: ["Write a contact id first."] });
    busy = "try";
    try {
      const r = await api.post<ScorePreview>(`contacts/${seg(id)}/score`, { rules: body() });
      const why = r.matched.map((m) => `${m.label} (${m.points > 0 ? "+" : ""}${m.points})`).join(", ") || "no rule holds";
      note = ok(`Score ${r.score}: ${why}. Nothing was saved.`);
    } catch (e) {
      note = fail(e);
    } finally {
      busy = null;
    }
  }

  async function recalculate() {
    busy = "recalculate";
    try {
      let after: string | undefined;
      let total = 0;
      do {
        const r = await api.post<{ scored: number; next?: string | null }>("scores/recalculate", after ? { after } : {});
        total += r.scored;
        after = r.next ?? undefined;
        note = ok(`Recalculated ${total} contacts…`);
      } while (after);
      note = ok(`Recalculated ${total} contacts.`);
    } catch (e) {
      note = fail(e);
    } finally {
      busy = null;
    }
  }
</script>

<Panel title="Contact score">
  <p class="lead">
    Score = the sum of the points of every rule that holds, between 0 and 100.{#if model}{" "}Version
      {model.version}.{/if}
  </p>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Rule</TableHead>
        <TableHead>Signal</TableHead>
        <TableHead>Is</TableHead>
        <TableHead>Value</TableHead>
        <TableHead>Points</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each rules as rule (rule.key)}
        <TableRow>
          <TableCell><Input bind:value={rule.label} aria-label="Rule name" /></TableCell>
          <TableCell>
            <Select bind:value={rule.signal} options={signalOptions(rule.signal)} aria-label="Signal" />
          </TableCell>
          <TableCell><Select bind:value={rule.op} options={OPS} aria-label="Comparison" /></TableCell>
          <TableCell><Input bind:value={rule.value} aria-label="Value" /></TableCell>
          <TableCell><Input type="number" bind:value={rule.points} aria-label="Points" /></TableCell>
          <TableCell>
            <Button size="sm" variant="ghost" onclick={() => (rules = rules.filter((r) => r !== rule))}>Remove</Button>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={6} text="No rules" />
      {/each}
    </TableBody>
  </Table>
  <Row>
    <Button size="sm" variant="outline" onclick={() => rules.push(toRow({ label: "", op: "==", points: 0 }))}>Add rule</Button>
  </Row>
  <div class="mono">
    <Field label="Guide (Markdown)">
      <Textarea bind:value={guide} rows={8} />
    </Field>
  </div>
  <Row>
    <Button size="sm" loading={busy === "save"} onclick={save}>Save new version</Button>
    <Input bind:value={contactId} placeholder="Contact id" aria-label="Contact id to try the rules on" />
    <Button size="sm" variant="outline" loading={busy === "try"} onclick={tryOn}>Try on a contact</Button>
    <Button size="sm" variant="outline" loading={busy === "recalculate"} onclick={recalculate}>Recalculate all</Button>
  </Row>
  <Result {note} />
</Panel>

<style>
  .lead {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }

  .mono :global(.ta-textarea) {
    font-family: var(--ta-font-mono);
  }
</style>
