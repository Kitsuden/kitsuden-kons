<!--
  A list of steps as blocks: drag (or move with the keyboard) to change the order, add one from the
  catalog by category, open one to edit it as a form (its nested messages or steps stay JSON),
  duplicate or remove it. The server's catalog (GET /blueprints/steps) says what each step takes,
  so this editor never falls behind the format. Problems the server found mark their block.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    DropdownMenu,
    Field,
    MenuItem,
    MenuLabel,
    MenuSeparator,
    SchemaForm,
    SortableList,
    Textarea,
    type JsonSchema,
  } from "$lib/components";

  import type { StepEntry } from "../types";
  import { fromJson, toJson } from "../ui/settings";

  type Step = Record<string, unknown> & { do: string };

  const {
    steps,
    catalog,
    problems = [],
    onchange,
  }: {
    steps: Step[];
    catalog: StepEntry[];
    /** Problems with paths relative to the part (`steps.2.content`). */
    problems?: Array<{ path: string; message: string }>;
    onchange: (steps: Step[]) => void;
  } = $props();

  const byDo = $derived(new Map(catalog.map((e) => [e.do, e])));
  const categories = $derived([...new Set(catalog.map((e) => e.category))]);

  // Keys that follow the steps through moves (steps have no ids of their own).
  let seq = 0;
  const fresh = () => `s${++seq}`;
  // svelte-ignore state_referenced_locally (the parent remounts this editor for another part)
  let keys = $state<string[]>(steps.map(() => fresh()));
  const rows = $derived(steps.map((step, i) => ({ step, key: keys[i] ?? `x${i}` })));

  let open = $state<string | null>(null);
  let formValue = $state<Record<string, unknown>>({});
  let jsonText = $state<Record<string, string>>({});
  let jsonError = $state<string | null>(null);

  const entryOf = (s: Step) => byDo.get(s.do);
  const labelOf = (s: Step) => entryOf(s)?.label ?? s.do;
  const problemsOf = (i: number) => problems.filter((p) => p.path === `steps.${i}` || p.path.startsWith(`steps.${i}.`));

  /** One line that says what a step does with its values. */
  function summaryOf(s: Step): string {
    const embeds = s.embeds as Array<{ title?: string }> | undefined;
    const parts: Array<unknown> = [
      s.content,
      embeds?.[0]?.title,
      s.modal && `form ${s.modal}`,
      s.amount !== undefined && `${s.amount} ${s.currency ?? "coins"}`,
      s.item && `${s.quantity ?? 1} × ${s.item}`,
      s.list && `list ${s.list}`,
      s.roleId && `role ${s.roleId}`,
      s.key && `${s.key}${s.value !== undefined ? ` = ${s.value}` : ""}`,
      s.expr,
      s.seconds && `${s.seconds} s per ${s.per ?? "user"}`,
      s.minutes !== undefined && `${s.minutes} min`,
      s.path && `${s.method ?? "GET"} ${s.path}`,
      s.question,
      s.name,
      s.panel && `panel ${s.panel}`,
      s.emoji,
      s.prompt,
    ];
    const text = parts.find((p) => typeof p === "string" || typeof p === "number");
    const guard = s.if ? "if … · " : "";
    return text === undefined ? guard.replace(" · ", "") : `${guard}${String(text).slice(0, 90)}`;
  }

  /**
   * The catalog's form schema, with nested objects that are optional (an `if`) not demanding their
   * own fields: an empty `if` means "no condition", not a form error.
   */
  function relax(schema: JsonSchema, required = true): JsonSchema {
    const out: JsonSchema = { ...schema };
    if (schema.type === "object" && schema.properties) {
      const req = new Set(schema.required ?? []);
      out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, relax(v, req.has(k))]));
      if (!required) delete out.required;
    }
    if (schema.type === "array" && schema.items) out.items = relax(schema.items, true);
    return out;
  }

  /** Drops what the form left blank: "", null, empty lists and objects (a blank `if`). */
  function clean(v: unknown): unknown {
    if (Array.isArray(v)) {
      const a = v.map(clean).filter((x) => x !== undefined);
      return a.length ? a : undefined;
    }
    if (v && typeof v === "object") {
      const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]).filter(([, x]) => x !== undefined));
      return Object.keys(o).length ? o : undefined;
    }
    return v === "" || v === null ? undefined : v;
  }

  function startEdit(key: string, s: Step) {
    if (open === key) {
      open = null;
      return;
    }
    const entry = entryOf(s);
    const { do: _do, ...rest } = JSON.parse(JSON.stringify(s)) as Step;
    const value: Record<string, unknown> = {};
    const json: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (entry?.jsonFields.includes(k)) json[k] = toJson(v);
      else value[k] = entry?.numberFields.includes(k) && typeof v === "number" ? String(v) : v;
    }
    for (const k of entry?.jsonFields ?? []) json[k] ??= "";
    formValue = value;
    jsonText = json;
    jsonError = null;
    open = key;
  }

  function apply(index: number, v: Record<string, unknown>) {
    const s = steps[index];
    const entry = entryOf(s);
    const next: Step = { do: s.do, ...((clean(v) as Record<string, unknown> | undefined) ?? {}) };
    for (const k of entry?.numberFields ?? []) {
      const raw = next[k];
      if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())) next[k] = Number(raw);
    }
    for (const [k, text] of Object.entries(jsonText)) {
      if (!text.trim()) continue;
      const parsed = fromJson(text);
      if (!parsed.ok) {
        jsonError = `${k}: ${parsed.error}`;
        return;
      }
      next[k] = parsed.value;
    }
    jsonError = null;
    onchange(steps.map((x, i) => (i === index ? next : x)));
    open = null;
  }

  function add(entry: StepEntry) {
    keys = [...keys, fresh()];
    onchange([...steps, JSON.parse(JSON.stringify(entry.example)) as Step]);
  }

  function duplicate(index: number) {
    keys = [...keys.slice(0, index + 1), fresh(), ...keys.slice(index + 1)];
    onchange([...steps.slice(0, index + 1), JSON.parse(JSON.stringify(steps[index])) as Step, ...steps.slice(index + 1)]);
  }

  function remove(index: number) {
    if (open === keys[index]) open = null;
    keys = keys.filter((_, i) => i !== index);
    onchange(steps.filter((_, i) => i !== index));
  }

  function reorder(from: number, to: number) {
    const k = [...keys];
    k.splice(to, 0, k.splice(from, 1)[0]);
    keys = k;
    const s = [...steps];
    s.splice(to, 0, s.splice(from, 1)[0]);
    onchange(s);
  }
</script>

<section class="steps" aria-label="Steps">
  <div class="steps-head">
    <h4>Steps <Badge size="sm">{steps.length}</Badge></h4>
    <DropdownMenu label="Add a step" placement="bottom-end">
      {#snippet trigger(props)}
        <Button {...props} size="sm" variant="secondary">Add a step</Button>
      {/snippet}
      {#each categories as c, ci (c)}
        {#if ci > 0}<MenuSeparator />{/if}
        <MenuLabel>{c}</MenuLabel>
        {#each catalog.filter((e) => e.category === c) as e (e.do)}
          <MenuItem onSelect={() => add(e)}>{e.label}</MenuItem>
        {/each}
      {/each}
    </DropdownMenu>
  </div>

  {#if steps.length === 0}
    <p class="quiet">No steps yet: add one.</p>
  {:else}
    <SortableList ariaLabel="Steps, in the order they run" items={rows} key={(r) => r.key} label={(r) => labelOf(r.step)} onReorder={reorder}>
      {#snippet row(r, i)}
        {@const entry = entryOf(r.step)}
        {@const bad = problemsOf(i)}
        <div class="block" data-category={entry?.category ?? "Other"}>
          <div class="block-head">
            <span class="dot" aria-hidden="true"></span>
            <span class="label">{i + 1}. {labelOf(r.step)}</span>
            <code class="do">{r.step.do}</code>
            {#if bad.length}<Badge size="sm" variant="error">{bad.length} problem{bad.length === 1 ? "" : "s"}</Badge>{/if}
            <span class="spacer"></span>
            <Button size="sm" variant="ghost" aria-expanded={open === r.key} onclick={() => startEdit(r.key, r.step)}>
              {open === r.key ? "Close" : "Edit"}
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Duplicate step ${i + 1}`} onclick={() => duplicate(i)}>Duplicate</Button>
            <Button size="sm" variant="danger-ghost" aria-label={`Remove step ${i + 1}`} onclick={() => remove(i)}>Remove</Button>
          </div>
          {#if summaryOf(r.step)}<p class="summary">{summaryOf(r.step)}</p>{/if}
          {#if bad.length}
            <ul class="problems">{#each bad as p, j (j)}<li><code>{p.path.slice(`steps.${i}`.length + 1) || "(step)"}</code> {p.message}</li>{/each}</ul>
          {/if}
          {#if open === r.key && entry}
            <div class="form">
              {#if entry.description}<p class="quiet">{entry.description}</p>{/if}
              <SchemaForm schema={relax(entry.formSchema as JsonSchema)} bind:value={formValue} submitLabel="Apply" onsubmit={(v) => apply(i, v)}>
                {#each entry.jsonFields as k (k)}
                  <Field label={`${k} (JSON)`} error={jsonError?.startsWith(`${k}:`) ? jsonError : undefined}>
                    <Textarea bind:value={jsonText[k]} rows={6} mono spellcheck="false" />
                  </Field>
                {/each}
              </SchemaForm>
            </div>
          {/if}
        </div>
      {/snippet}
    </SortableList>
  {/if}
</section>

<style>
  .steps {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .steps-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  h4 {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    font-size: 0.875rem;
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    --cat: var(--ta-text-dim);
  }

  .block[data-category="Messages"] {
    --cat: var(--ta-accent);
  }
  .block[data-category="Discord"] {
    --cat: var(--ta-info, 96 165 250);
  }
  .block[data-category="Rewards"] {
    --cat: var(--ta-warning, 255 171 0);
  }
  .block[data-category="Flow and data"] {
    --cat: var(--ta-success);
  }

  .block-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
  }

  .dot {
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 999px;
    background: rgb(var(--cat));
  }

  .label {
    font-weight: 600;
    font-size: 0.875rem;
  }

  .do {
    font-size: 0.6875rem;
    color: rgb(var(--ta-text-dim));
  }

  .spacer {
    flex: 1 1 auto;
  }

  .summary,
  .quiet {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
    overflow-wrap: anywhere;
  }

  .problems {
    margin: 0;
    padding-left: 1rem;
    font-size: 0.8125rem;
    color: rgb(var(--ta-danger));
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.25rem;
    padding-top: 0.5rem;
    border-top: 1px solid rgb(var(--ta-border));
  }
</style>
