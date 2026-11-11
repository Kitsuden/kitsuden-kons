<!--
  The score rules as a table anyone can read, and the guide in Markdown. Saving makes a new version;
  "Try on a contact" shows what the rules on screen give before anything is saved.
-->
<script lang="ts">
  import {
    Alert,
    Badge,
    Button,
    EmptyState,
    Field,
    Input,
    SaveBar,
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

  import { seg, type Api } from "../api";
  import type { ScoreModel, ScorePreview, ScoreRule } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { createLoad } from "../ui/load.svelte";
  import Loadable from "../ui/Loadable.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";

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
  /** What "Try on a contact" and "Recalculate all" answered: read on screen, not a passing notice. */
  let outcome = $state<string | null>(null);
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

  /** What is on screen, to compare with what was loaded or saved last. */
  const snapshot = () => JSON.stringify({ rules: body(), guide });
  let saved = $state("");
  const dirty = $derived(saved !== "" && snapshot() !== saved);

  function paint(next: ScoreModel) {
    guide = next.guide ?? "";
    rules = (next.rules ?? []).map(toRow);
    saved = snapshot();
  }

  const data = createLoad(async () => {
    model = await api.get<ScoreModel>("score-model");
    paint(model);
  });

  $effect(() => {
    untrack(data.load);
  });

  async function save() {
    busy = "save";
    try {
      const answer = await api.put<ScoreModel>("score-model", { rules: body(), guide });
      model = { ...model, ...answer };
      saved = snapshot();
      toast.success(`Saved as version ${answer.version}`, { description: "Scores change when you recalculate." });
    } catch (e) {
      failed("Could not save the score rules", e);
    } finally {
      busy = null;
    }
  }

  async function tryOn() {
    const id = contactId.trim();
    if (!id) return toast.error("Write a contact id first");
    busy = "try";
    try {
      const r = await api.post<ScorePreview>(`contacts/${seg(id)}/score`, { rules: body() });
      const why = r.matched.map((m) => `${m.label} (${m.points > 0 ? "+" : ""}${m.points})`).join(", ") || "no rule holds";
      outcome = `Score ${r.score}: ${why}. Nothing was saved.`;
    } catch (e) {
      failed("Could not try the rules on that contact", e);
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
        outcome = `Recalculated ${total} contacts…`;
      } while (after);
      outcome = `Recalculated ${total} contacts.`;
      toast.success(`Recalculated ${total} contacts`);
    } catch (e) {
      failed("Could not recalculate the scores", e);
    } finally {
      busy = null;
    }
  }

  const addRule = () => rules.push(toRow({ label: "", op: "==", points: 0 }));
</script>

<Panel title="Contact score" description="Score = the sum of the points of every rule that holds, between 0 and 100.">
  {#snippet status()}
    {#if model}<Badge>Version {model.version}</Badge>{/if}
  {/snippet}
  <Loadable load={data} errorTitle="The score rules did not load" lines={6}>
    {#if rules.length}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Rule</TableHead>
            <TableHead>Signal</TableHead>
            <TableHead>Is</TableHead>
            <TableHead>Value</TableHead>
            <TableHead>Points</TableHead>
            <TableHead><span class="sr-anchor"><span class="sr-only">Actions</span></span></TableHead>
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
                <Button
                  size="sm"
                  variant="ghost"
                  ariaLabel={`Remove rule ${rule.label || "without a name"}`}
                  onclick={() => (rules = rules.filter((r) => r !== rule))}>Remove</Button
                >
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
      <div><Button size="sm" variant="outline" onclick={addRule}>Add rule</Button></div>
    {:else}
      <EmptyState
        size="sm"
        level={3}
        title="No rules yet"
        description="Without rules every contact scores 0."
        actionLabel="Add rule"
        onAction={addRule}
      />
    {/if}
    <div class="mono">
      <Field label="Guide (Markdown)">
        <Textarea bind:value={guide} rows={8} />
      </Field>
    </div>
    <SaveBar
      sticky={false}
      savedText="No unsaved changes"
      {dirty}
      saving={busy === "save"}
      saveLabel="Save new version"
      cancelLabel="Discard"
      ariaLabel="Save the score rules"
      onSave={save}
      onCancel={dirty && model ? () => paint(model!) : undefined}
    />

    <h3 class="sub">Check before it counts</h3>
    <FormGrid label="Try the rules on a contact" onsubmit={tryOn}>
      <Field label="Contact id">
        <Input bind:value={contactId} />
      </Field>
      {#snippet actions()}
        <Button variant="outline" loading={busy === "recalculate"} disabled={busy === "try"} onclick={recalculate}>
          Recalculate all
        </Button>
        <Button type="submit" variant="secondary" loading={busy === "try"} disabled={busy === "recalculate"}>
          Try on a contact
        </Button>
      {/snippet}
    </FormGrid>
    {#if outcome}<Alert variant="info" onDismiss={() => (outcome = null)}>{outcome}</Alert>{/if}
  </Loadable>
</Panel>

<style>
  .mono :global(.ta-textarea) {
    font-family: var(--ta-font-mono);
  }

  .sub {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  /* Keeps the hidden text inside the table's scroll area: on its own it would widen the page. */
  .sr-anchor {
    position: relative;
    display: block;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
