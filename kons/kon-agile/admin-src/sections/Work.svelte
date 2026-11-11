<!--
  The agent work queue: totals and cost per agent, every piece of work with its trigger and
  result, cancelling what has not finished, and asking an agent for something by hand.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    ConfirmDialog,
    DataTable,
    Dialog,
    EmptyState,
    Field,
    FilterBar,
    Input,
    Select,
    Stat,
    Textarea,
    type DataColumn,
    type FilterValues,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg } from "../api";
  import { count, money, moment, optional, options, statusVariant, words } from "../format";
  import { WORK_STATUSES, type AgentTotals, type Work } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CLOSE, CANCEL } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let work = $state<Work[]>([]);
  let agents = $state<AgentTotals[]>([]);
  // What the queue is filtered by: the API takes both as query parameters.
  let query = $state<FilterValues>({});
  const byStatus = $derived(String(query.status ?? ""));
  const byAgent = $derived(String(query.agentId ?? ""));

  let requesting = $state(false);
  let request = $state({ agentId: "", issueKey: "", prompt: "" });
  let saving = $state(false);
  let cancelling = $state<Work | null>(null);
  let confirmCancel = $state(false);

  const open = (w: Work) => w.status === "queued" || w.status === "running";

  const agentColumns: DataColumn<AgentTotals>[] = [
    { key: "agentId", header: "Agent", sortable: true, hideable: false },
    { key: "queued", header: "Queued", sortable: true, align: "right" },
    { key: "running", header: "Running", sortable: true, align: "right" },
    { key: "done", header: "Done", sortable: true, align: "right" },
    { key: "failed", header: "Failed", sortable: true, align: "right" },
    { key: "inputTokens", header: "Tokens in", sortable: true, align: "right" },
    { key: "outputTokens", header: "Tokens out", sortable: true, align: "right" },
    { key: "costUsd", header: "Cost", sortable: true, align: "right" },
  ];

  const workColumns: DataColumn<Work>[] = [
    { key: "createdAt", header: "Queued", sortable: true, value: (w) => moment(w.createdAt) },
    { key: "agentId", header: "Agent", sortable: true },
    { key: "trigger", header: "Trigger", sortable: true, value: (w) => words(w.trigger) },
    { key: "issueKey", header: "Issue", sortable: true, value: (w) => w.issueKey ?? null },
    { key: "status", header: "Status", sortable: true, value: (w) => words(w.status) },
    { key: "result", header: "Result", value: (w) => w.result ?? w.prompt ?? "—" },
    { key: "costUsd", header: "Cost", sortable: true, align: "right", value: (w) => (w.costUsd != null ? Number(w.costUsd) : null) },
  ];

  const data = createLoad(async () => {
    const res = await ws.api.get<{ docs: Work[]; agents: AgentTotals[] }>(`/${seg(ws.projectId!)}/work`, {
      status: byStatus,
      agentId: byAgent,
      limit: 200,
    });
    work = res.docs;
    agents = res.agents;
  });

  // Reload on another project, another filter, or a change elsewhere.
  $effect(() => {
    void [ws.version, byStatus, byAgent];
    if (ws.projectId) untrack(data.load);
  });

  const totals = $derived(
    agents.reduce(
      (t, a) => ({
        open: t.open + a.queued + a.running,
        done: t.done + a.done,
        failed: t.failed + a.failed,
        tokens: t.tokens + a.inputTokens + a.outputTokens,
        cost: t.cost + a.costUsd,
      }),
      { open: 0, done: 0, failed: 0, tokens: 0, cost: 0 }
    )
  );

  const agentFilter = $derived([
    ...ws.agentOptions,
    ...agents.filter((a) => !ws.agentOptions.some((o) => o.value === a.agentId)).map((a) => ({ value: a.agentId, label: a.agentId })),
  ]);

  const valid = $derived(!!request.agentId && !!request.prompt.trim());

  async function send() {
    saving = true;
    try {
      await ws.act(
        () =>
          ws.api.post(`/${seg(ws.projectId!)}/work`, {
            agentId: request.agentId,
            issueKey: optional(request.issueKey.toUpperCase()),
            prompt: request.prompt.trim(),
          }),
        "Work queued",
        "Could not queue the work"
      );
      requesting = false;
      await data.load();
    } catch {
      // Shown in the toast.
    } finally {
      saving = false;
    }
  }

  async function cancel() {
    await ws.act(
      () => ws.api.post(`/work/${seg(cancelling!.id)}/finish`, { status: "cancelled" }),
      "Work cancelled",
      "Could not cancel the work"
    );
    await data.load();
  }
</script>

<Panel title="Per agent">
  {#if data.ready && agents.length}
    <div class="stats">
      <Stat label="Open" value={count(totals.open)} variant={totals.open ? "warning" : "default"} />
      <Stat label="Done" value={count(totals.done)} variant="success" />
      <Stat label="Failed" value={count(totals.failed)} variant={totals.failed ? "error" : "default"} />
      <Stat label="Tokens" value={count(totals.tokens)} />
      <Stat label="Cost" value={money(totals.cost)} />
    </div>
  {/if}
  <DataTable
    caption="Work per agent"
    rows={agents}
    columns={agentColumns}
    rowKey="agentId"
    rowLabel={(a) => a.agentId}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(a, col)}
      {#if col.key === "agentId"}
        <code>{a.agentId}</code>
      {:else if col.key === "costUsd"}
        {money(a.costUsd)}
      {:else if col.key === "inputTokens"}
        {count(a.inputTokens)}
      {:else if col.key === "outputTokens"}
        {count(a.outputTokens)}
      {:else}
        {a[col.key as "queued" | "running" | "done" | "failed"]}
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="No agent work yet" description="Work appears when an agent is assigned an issue, a schedule runs, or someone asks an agent." />
    {/snippet}
  </DataTable>
</Panel>

<Panel title="Queue">
  {#snippet status()}
    {#if data.ready}<Badge>{work.length} {work.length === 1 ? "piece of work" : "pieces of work"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button
      disabled={!ws.agentOptions.length}
      onclick={() => {
        request = { agentId: ws.agentOptions[0]?.value ?? "", issueKey: "", prompt: "" };
        requesting = true;
      }}>Ask an agent</Button
    >
  {/snippet}
  <FilterBar
    bind:value={query}
    search={false}
    ariaLabel="Filter the queue"
    filters={[
      { key: "status", label: "Status", type: "select", options: options(WORK_STATUSES) },
      { key: "agentId", label: "Agent", type: "select", options: agentFilter },
    ]}
  />
  <DataTable
    caption="Agent work queue"
    rows={work}
    columns={workColumns}
    rowKey="id"
    rowLabel={(w) => `${words(w.trigger)} for ${w.agentId}`}
    pageSize={25}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(w, col)}
      {#if col.key === "agentId"}
        <code>{w.agentId}</code>
      {:else if col.key === "issueKey"}
        {#if w.issueKey}<code>{w.issueKey}</code>{:else}—{/if}
      {:else if col.key === "status"}
        <Badge variant={statusVariant(w.status)} dot={open(w)}>{words(w.status)}</Badge>
      {:else if col.key === "result"}
        <span class="result" title={w.result ?? w.prompt ?? ""}>{w.result ?? w.prompt ?? "—"}</span>
      {:else if col.key === "costUsd"}
        {w.costUsd != null ? money(w.costUsd) : "—"}
      {:else}
        <span class="nowrap">{col.value?.(w)}</span>
      {/if}
    {/snippet}
    {#snippet rowActions(w)}
      {#if open(w)}
        <Button
          size="sm"
          variant="ghost"
          ariaLabel={`Cancel: ${words(w.trigger)} for ${w.agentId}`}
          onclick={() => {
            cancelling = w;
            confirmCancel = true;
          }}>Cancel</Button
        >
      {/if}
    {/snippet}
    {#snippet empty()}
      {#if byStatus || byAgent}
        <EmptyState size="sm" level={null} variant="no-results" onClearFilters={() => (query = {})} />
      {:else}
        <EmptyState
          size="sm"
          level={null}
          title="No work in the queue"
          actionLabel={ws.agentOptions.length ? "Ask an agent" : undefined}
          onAction={() => {
            request = { agentId: ws.agentOptions[0]?.value ?? "", issueKey: "", prompt: "" };
            requesting = true;
          }}
        />
      {/if}
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open={requesting} title="Ask an agent" closeLabel={CLOSE} size="lg">
  <FormGrid label="Ask an agent" onsubmit={() => valid && !saving && send()}>
    <Field label="Agent" required>
      <Select bind:value={request.agentId} options={ws.agentOptions} />
    </Field>
    <Field label="Issue">
      <Input bind:value={request.issueKey} maxlength={64} placeholder={`${ws.project?.identifier ?? "KEY"}-12`} />
    </Field>
    <Field label="Prompt" required class="wide">
      <Textarea bind:value={request.prompt} rows={4} maxlength={10000} />
    </Field>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (requesting = false)}>{CANCEL}</Button>
    <Button loading={saving} disabled={!valid} onclick={send}>Queue</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmCancel}
  title="Cancel this work?"
  description={cancelling ? `${words(cancelling.trigger)} for ${cancelling.agentId}` : undefined}
  confirmLabel="Cancel work"
  cancelLabel="Keep"
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={cancel}
/>

<style>
  .nowrap {
    white-space: nowrap;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
    gap: 0.75rem;
  }

  code {
    white-space: nowrap;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }

  .result {
    display: inline-block;
    max-width: 22rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }
</style>
