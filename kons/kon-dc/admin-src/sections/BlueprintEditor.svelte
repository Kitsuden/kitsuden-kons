<!--
  The blueprint editor: the definition as an outline (commands and their subcommands, live panels
  with their rows and components, modals, triggers) beside the part you picked. Each part is edited
  as its own JSON, checked by the server's schema as you apply it; the outline marks the parts the
  check points at, and messages (a panel, a command's reply) show as Discord would draw them, with
  the placeholders as written. The whole definition is one tab away.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import {
    Alert,
    Badge,
    Button,
    DropdownMenu,
    Field,
    Input,
    MenuItem,
    Select,
    Tabs,
    Textarea,
    TreeView,
    type TabItem,
    type TreeNode,
  } from "$lib/components";

  import {
    SECTIONS,
    append,
    getAt,
    kindOf,
    outline,
    parentPath,
    previewOf,
    problemsAt,
    setAt,
    starter,
    type Definition,
    type Section,
  } from "../blueprint";
  import { useApi } from "../context";
  import type { Blueprint, StepEntry, Validation } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import Panel from "../ui/Panel.svelte";
  import { failed, toast } from "../ui/notify";
  import { fromJson, toJson } from "../ui/settings";
  import StepsEditor from "./StepsEditor.svelte";

  const {
    blueprint,
    draft = null,
    onclose,
  }: {
    blueprint: Blueprint | null;
    /** A new blueprint that starts from this ("Describe a bot"). */
    draft?: { name: string; description?: string; definition: Record<string, unknown> } | null;
    onclose: (saved: boolean) => void;
  } = $props();
  const api = useApi();

  const STARTER: Definition = {
    commands: [{ name: "hello", description: "Say hello", steps: [{ do: "reply", content: "Hello, {{user.mention}}!" }] }],
  };

  // svelte-ignore state_referenced_locally (the editor opens on one blueprint; the parent remounts it)
  let def = $state<Definition>(JSON.parse(JSON.stringify($state.snapshot(blueprint?.definition ?? draft?.definition) ?? STARTER)) as Definition);
  // svelte-ignore state_referenced_locally
  let meta = $state({
    name: blueprint?.name ?? draft?.name ?? "",
    description: blueprint?.description ?? draft?.description ?? "",
    status: blueprint?.status ?? "draft",
  });

  // The step catalog: what each step takes, from the server (so the block editor follows the format).
  let catalog = $state<StepEntry[]>([]);
  $effect(() => {
    untrack(() => {
      api
        .get<{ docs: StepEntry[] }>("/blueprints/steps")
        .then((r) => (catalog = r.docs))
        .catch((e) => failed("The step catalog did not load", e));
    });
  });
  let selected = $state<string | null>("commands");
  let expanded = $state<string[]>([...SECTIONS]);
  let check = $state<Validation | null>(null);
  let checking = $state(false);
  let saving = $state(false);
  // svelte-ignore state_referenced_locally (a generated draft is unsaved from the start)
  let dirty = $state(!!draft);

  const tabs: TabItem[] = [
    { id: "outline", label: "Outline" },
    { id: "json", label: "JSON" },
  ];
  let tab = $state("outline");

  const problems = $derived(check?.problems ?? []);
  const tree = $derived(outline(def, problems));
  const kind = $derived(selected ? kindOf(selected) : null);
  const part = $derived(selected && kind !== "section" ? getAt(def, selected) : undefined);
  const partProblems = $derived(selected ? problemsAt(problems, selected) : []);
  /** The steps of the selected part, when it has a list of them (a command, a button, a modal…). */
  const partSteps = $derived(
    part && typeof part === "object" && Array.isArray((part as { steps?: unknown }).steps)
      ? (part as { steps: Array<Record<string, unknown> & { do: string }> }).steps
      : null
  );

  // The JSON of the part being edited, kept apart until "Apply".
  let partText = $state("");
  let partError = $state<string | null>(null);
  $effect(() => {
    const p = part;
    untrack(() => {
      partText = p === undefined ? "" : toJson(p);
      partError = null;
    });
  });

  let wholeText = $state("");
  let wholeError = $state<string | null>(null);
  $effect(() => {
    if (tab !== "json") return;
    untrack(() => {
      wholeText = toJson(def);
      wholeError = null;
    });
  });

  // Checks against the server's schema shortly after each change.
  let timer: ReturnType<typeof setTimeout> | undefined;
  function scheduleCheck() {
    clearTimeout(timer);
    timer = setTimeout(() => void validate(), 300);
  }
  $effect(() => {
    untrack(() => void validate());
    return () => clearTimeout(timer);
  });

  async function validate(): Promise<boolean> {
    checking = true;
    try {
      check = await api.post<Validation>("/blueprints/validate", { definition: $state.snapshot(def) });
      return check.valid;
    } catch (e) {
      failed("Could not check the blueprint", e);
      return false;
    } finally {
      checking = false;
    }
  }

  function change(next: Definition) {
    def = next;
    dirty = true;
    scheduleCheck();
  }

  function applyPart() {
    if (!selected) return;
    const parsed = fromJson(partText);
    if (!parsed.ok) {
      partError = parsed.error;
      return;
    }
    change(setAt($state.snapshot(def) as Definition, selected, parsed.value));
  }

  function applyWhole() {
    const parsed = fromJson(wholeText);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
      wholeError = parsed.ok ? "A definition is an object" : parsed.error;
      return;
    }
    change(parsed.value as Definition);
    toast.success("Definition applied");
  }

  function add(section: Section) {
    const r = append($state.snapshot(def) as Definition, section, starter(section, def));
    change(r.def);
    expanded = [...new Set([...expanded, section])];
    selected = r.path;
  }

  function addRowButton() {
    if (!selected || kindOf(selected) !== "panel") return;
    const id = `btn-${Math.random().toString(36).slice(2, 7)}`;
    const r = append($state.snapshot(def) as Definition, `${selected}.components`, [
      { type: "button", id, label: "New button", style: "secondary", steps: [{ do: "reply", content: "Pressed.", ephemeral: true }] },
    ]);
    change(r.def);
    expanded = [...new Set([...expanded, selected])];
  }

  function remove() {
    if (!selected || kind === "section") return;
    const was = selected;
    let next = setAt($state.snapshot(def) as Definition, was, undefined);
    // A row left empty goes too: Discord refuses empty rows.
    const parent = parentPath(was);
    if (kindOf(was) === "component" && parent && ((getAt(next, parent) as unknown[] | undefined) ?? []).length === 0) {
      next = setAt(next, parent, undefined);
    }
    change(next);
    // Select what holds it: the panel or the command, or the section.
    const k = kindOf(was);
    selected = was.split(".").slice(0, k === "component" || k === "row" || k === "subcommand" ? 2 : 1).join(".");
  }

  async function save() {
    if (!meta.name.trim()) {
      toast.error("Give the blueprint a name");
      return;
    }
    if (!(await validate())) {
      toast.error("The blueprint has problems", { description: "The outline marks where." });
      return;
    }
    saving = true;
    try {
      const body = { name: meta.name.trim(), description: meta.description.trim() || null, status: meta.status, definition: $state.snapshot(def) };
      if (blueprint) await api.patch(`/blueprints/${blueprint.id}`, body);
      else await api.post("/blueprints", body);
      toast.success(blueprint ? "Blueprint saved" : "Blueprint created", {
        description: meta.status === "published" ? "Switch it on in a server and sync its commands." : undefined,
      });
      dirty = false;
      onclose(true);
    } catch (e) {
      failed("Could not save the blueprint", e);
    } finally {
      saving = false;
    }
  }

  // What a selected part shows as Discord would draw it.
  const preview = $derived.by(() => {
    if (!selected || !part || typeof part !== "object") return null;
    if (kind === "panel") return previewOf(part as Record<string, unknown>);
    if (kind === "row" || kind === "component") return previewOf(getAt(def, selected.split(".").slice(0, 2).join(".")) as Record<string, unknown>);
    if (kind === "command" || kind === "subcommand" || kind === "modal" || kind === "trigger") {
      const steps = ((part as { steps?: Array<Record<string, unknown>> }).steps ?? []).filter(
        (s) => s.do === "reply" || s.do === "send_message" || s.do === "update_message"
      );
      return steps.length ? previewOf(steps.at(-1)) : null;
    }
    return null;
  });

  const KIND_LABEL: Record<string, string> = {
    command: "Slash command",
    subcommand: "Subcommand",
    trigger: "Trigger",
    modal: "Modal",
    panel: "Live panel",
    row: "Row of components",
    component: "Component",
  };
  const modalFields = $derived(kind === "modal" ? ((part as { inputs?: Array<{ id: string; label: string; style?: string; required?: boolean }> }).inputs ?? []) : []);
  const flatten = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
  const selectedLabel = $derived(flatten(tree).find((n) => n.id === selected)?.label ?? "");
  const sectionName = $derived(kind === "section" ? (selected as Section) : null);
</script>

<Panel title={blueprint ? `Edit ${blueprint.name}` : "New blueprint"}>
  {#snippet status()}
    {#if checking}
      <Badge>Checking…</Badge>
    {:else if check?.valid}
      <Badge variant="success" dot>Valid</Badge>
    {:else if check}
      <Badge variant="error" dot>{check.problems.length} problem{check.problems.length === 1 ? "" : "s"}</Badge>
    {/if}
    {#if dirty}<Badge variant="warning">Unsaved</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button variant="ghost" size="sm" onclick={() => onclose(false)}>Back</Button>
    <Button size="sm" loading={saving} onclick={save}>Save</Button>
  {/snippet}

  <FormGrid label="Blueprint" onsubmit={save}>
    <Field label="Name" required>
      <Input bind:value={meta.name} maxlength={100} />
    </Field>
    <Field label="Status">
      <Select
        bind:value={meta.status}
        options={[
          { value: "draft", label: "Draft" },
          { value: "published", label: "Published" },
        ]}
      />
    </Field>
    <Field label="Description" class="wide">
      <Input bind:value={meta.description} maxlength={2000} />
    </Field>
  </FormGrid>

  <Tabs items={tabs} bind:value={tab} ariaLabel="Edit as">
    {#snippet children(id)}
      {#if id === "outline"}
        <div class="editor">
          <div class="outline">
            <div class="outline-actions">
              <DropdownMenu label="Add a part" placement="bottom-start">
                {#snippet trigger(props)}
                  <Button {...props} variant="secondary" size="sm">Add</Button>
                {/snippet}
                <MenuItem onSelect={() => add("commands")}>Slash command</MenuItem>
                <MenuItem onSelect={() => add("panels")}>Live panel</MenuItem>
                <MenuItem onSelect={() => add("modals")}>Modal</MenuItem>
                <MenuItem onSelect={() => add("triggers")}>Trigger</MenuItem>
              </DropdownMenu>
            </div>
            <TreeView items={tree} bind:selected bind:expanded ariaLabel="Parts of the blueprint" />
          </div>

          <div class="detail">
            {#if sectionName}
              <h3>{tree.find((n) => n.id === sectionName)?.label}</h3>
              <p class="quiet">
                {#if sectionName === "commands"}Slash commands, with options, autocomplete and subcommands.
                {:else if sectionName === "panels"}Messages the bot keeps up to date, with buttons and selects.
                {:else if sectionName === "modals"}Forms a command or a button opens.
                {:else}What runs on a member joining, a message, a reaction or another kon's event.{/if}
              </p>
              <div class="start"><Button size="sm" variant="secondary" onclick={() => add(sectionName)}>
                Add {sectionName === "commands" ? "a command" : sectionName === "panels" ? "a panel" : sectionName === "modals" ? "a modal" : "a trigger"}
              </Button></div>
              {#if partProblems.length}
                <Alert variant="error" title="Problems">
                  <ul class="problems">{#each partProblems as p, i (i)}<li><code>{p.path}</code> {p.message}</li>{/each}</ul>
                </Alert>
              {/if}
            {:else if selected && part !== undefined}
              <div class="detail-head">
                <div>
                  <span class="kind">{KIND_LABEL[kind ?? ""] ?? kind}</span>
                  <h3>{selectedLabel}</h3>
                </div>
                <div class="detail-actions">
                  {#if kind === "panel"}<Button size="sm" variant="secondary" onclick={addRowButton}>Add a row</Button>{/if}
                  <Button size="sm" variant="danger-ghost" onclick={remove}>Remove</Button>
                </div>
              </div>

              {#if partProblems.length}
                <Alert variant="error" title={`${partProblems.length} problem${partProblems.length === 1 ? "" : "s"} here`}>
                  <ul class="problems">{#each partProblems as p, i (i)}<li><code>{p.path}</code> {p.message}</li>{/each}</ul>
                </Alert>
              {/if}

              {#if preview}
                <figure class="preview" aria-label="Preview">
                  <div class="bubble">
                    <span class="bot">BOT</span>
                    {#if preview.content}<p class="content">{preview.content}</p>{/if}
                    {#each preview.embeds as e, i (i)}
                      <div class="embed" style={e.color ? `--embed: ${e.color}` : undefined}>
                        {#if e.title}<strong>{e.title}</strong>{/if}
                        {#if e.description}<p>{e.description}</p>{/if}
                        {#if e.fields.length}
                          <div class="fields">
                            {#each e.fields as f, j (j)}
                              <div class={f.inline ? "inline" : ""}><span class="fname">{f.name}</span><span>{f.value}</span></div>
                            {/each}
                          </div>
                        {/if}
                        {#if e.footer}<small>{e.footer}</small>{/if}
                      </div>
                    {/each}
                    {#each preview.rows as row, r (r)}
                      <div class="row">
                        {#each row as c, k (k)}
                          {#if c.type === "button" || c.type === "link"}
                            <span class={`dbtn dbtn--${c.style}`}>{c.label}{#if c.type === "link"} ↗{/if}</span>
                          {:else}
                            <span class="dselect">{c.label}{#if c.options?.length}<em> · {c.options.slice(0, 3).join(", ")}{c.options.length > 3 ? "…" : ""}</em>{/if}</span>
                          {/if}
                        {/each}
                      </div>
                    {/each}
                  </div>
                  <figcaption class="quiet">Placeholders are filled when it runs.</figcaption>
                </figure>
              {/if}

              {#if partSteps && catalog.length && selected}
                {#key selected}
                  <StepsEditor
                    steps={partSteps}
                    {catalog}
                    problems={partProblems}
                    onchange={(next) => change(setAt($state.snapshot(def) as Definition, `${selected}.steps`, next))}
                  />
                {/key}
              {/if}

              {#if modalFields.length}
                <ul class="modal-fields">
                  {#each modalFields as f (f.id)}
                    <li><span>{f.label}</span> <code>{"{{input." + f.id + "}}"}</code>{#if f.required}<Badge size="sm">required</Badge>{/if}</li>
                  {/each}
                </ul>
              {/if}

              <Field label={partSteps ? "This part, steps included (JSON)" : "This part (JSON)"} error={partError ?? undefined}>
                <Textarea bind:value={partText} rows={16} mono spellcheck="false" />
              </Field>
              <div class="apply">
                <Button size="sm" onclick={applyPart}>Apply</Button>
              </div>
            {:else}
              <p class="quiet">Pick a part in the outline.</p>
            {/if}
          </div>
        </div>
      {:else}
        <Field label="Definition (JSON)" error={wholeError ?? undefined}>
          <Textarea bind:value={wholeText} rows={24} mono spellcheck="false" />
        </Field>
        {#if problemsAt(problems, "").length || (check && !check.valid)}
          <Alert variant="error" title="Problems">
            <ul class="problems">{#each problems as p, i (i)}<li><code>{p.path}</code> {p.message}</li>{/each}</ul>
          </Alert>
        {/if}
        <div class="apply">
          <Button size="sm" onclick={applyWhole}>Apply</Button>
        </div>
      {/if}
    {/snippet}
  </Tabs>
</Panel>

<style>
  .editor {
    display: grid;
    grid-template-columns: minmax(14rem, 18rem) minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
  }

  @media (max-width: 720px) {
    .editor {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .outline {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    max-height: 36rem;
    overflow: auto;
  }

  .outline-actions {
    display: flex;
    justify-content: flex-end;
  }

  .detail {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }

  .detail h3 {
    margin: 0;
    font-size: 1rem;
  }

  .detail-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .detail-actions {
    display: flex;
    gap: 0.5rem;
  }

  .kind {
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgb(var(--ta-text-dim));
  }

  .quiet {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .problems {
    margin: 0.25rem 0 0;
    padding-left: 1rem;
  }

  .start {
    display: flex;
  }

  .apply {
    display: flex;
    justify-content: flex-end;
  }

  .modal-fields {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.8125rem;
  }

  code {
    font-size: 0.75rem;
  }

  /* The preview: Discord's message layout, drawn with the theme's tokens. */
  .preview {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
  }

  .bubble {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    background: rgb(var(--ta-text) / 0.04);
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    font-size: 0.875rem;
  }

  .bot {
    align-self: flex-start;
    padding: 0 0.375rem;
    font-size: 0.625rem;
    font-weight: 700;
    color: rgb(var(--ta-on-accent));
    background: rgb(var(--ta-accent));
    border-radius: 0.25rem;
  }

  .content {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .embed {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    max-width: 32rem;
    padding: 0.5rem 0.75rem;
    background: rgb(var(--ta-surface));
    border-left: 4px solid var(--embed, rgb(var(--ta-border)));
    border-radius: 0.25rem;
  }

  .embed p {
    margin: 0;
    white-space: pre-wrap;
  }

  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
  }

  .fields > div {
    display: flex;
    flex: 1 1 100%;
    flex-direction: column;
  }

  .fields > div.inline {
    flex: 1 1 8rem;
  }

  .fname {
    font-weight: 600;
  }

  .embed small {
    color: rgb(var(--ta-text-dim));
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .dbtn,
  .dselect {
    padding: 0.25rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border-radius: 0.25rem;
  }

  .dbtn--primary {
    color: rgb(var(--ta-on-accent));
    background: rgb(var(--ta-accent));
  }

  .dbtn--success {
    color: rgb(var(--ta-on-success, 9 9 11));
    background: rgb(var(--ta-success));
  }

  .dbtn--danger {
    color: rgb(var(--ta-on-danger, 255 255 255));
    background: rgb(var(--ta-danger));
  }

  .dbtn--secondary,
  .dbtn--link {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-text) / 0.12);
  }

  .dselect {
    flex: 1 1 100%;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
  }
</style>
