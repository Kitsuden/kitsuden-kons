<!--
  The agent work queue: totals and cost per agent, every piece of work with its trigger and
  result, cancelling what has not finished, and asking an agent for something by hand.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    ConfirmDialog,
    Dialog,
    Field,
    Input,
    Select,
    Stat,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Textarea,
  } from "$lib/components";

  import { seg } from "../api";
  import { count, money, moment, optional, options, statusVariant, words } from "../format";
  import { WORK_STATUSES, type AgentTotals, type Work } from "../types";
  import Actions from "../ui/Actions.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let work = $state<Work[]>([]);
  let agents = $state<AgentTotals[]>([]);
  let status = $state("");
  let agentId = $state("");

  let requesting = $state(false);
  let request = $state({ agentId: "", issueKey: "", prompt: "" });
  let saving = $state(false);
  let cancelling = $state<Work | null>(null);
  let confirmCancel = $state(false);

  async function load() {
    const res = await ws.api.get<{ docs: Work[]; agents: AgentTotals[] }>(`/${seg(ws.projectId!)}/work`, {
      status,
      agentId,
      limit: 200,
    });
    work = res.docs;
    agents = res.agents;
  }

  // Reload on another project, another filter, or a change elsewhere.
  $effect(() => {
    void [ws.version, status, agentId];
    if (ws.projectId) ws.run(load);
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
        "Work queued"
      );
      requesting = false;
      await load();
    } catch {
      // Shown in the notice.
    } finally {
      saving = false;
    }
  }

  async function cancel() {
    await ws.act(() => ws.api.post(`/work/${seg(cancelling!.id)}/finish`, { status: "cancelled" }), "Work cancelled");
    await load();
  }
</script>

<div class="stack">
  <div class="stats">
    <Stat label="Open" value={count(totals.open)} variant={totals.open ? "warning" : "default"} />
    <Stat label="Done" value={count(totals.done)} variant="success" />
    <Stat label="Failed" value={count(totals.failed)} variant={totals.failed ? "error" : "default"} />
    <Stat label="Tokens" value={count(totals.tokens)} />
    <Stat label="Cost" value={money(totals.cost)} />
  </div>

  <Panel title="Per agent">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Queued</TableHead>
          <TableHead>Running</TableHead>
          <TableHead>Done</TableHead>
          <TableHead>Failed</TableHead>
          <TableHead>Tokens in / out</TableHead>
          <TableHead>Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each agents as a (a.agentId)}
          <TableRow>
            <TableCell><code>{a.agentId}</code></TableCell>
            <TableCell>{a.queued}</TableCell>
            <TableCell>{a.running}</TableCell>
            <TableCell>{a.done}</TableCell>
            <TableCell>{a.failed}</TableCell>
            <TableCell>{count(a.inputTokens)} / {count(a.outputTokens)}</TableCell>
            <TableCell>{money(a.costUsd)}</TableCell>
          </TableRow>
        {:else}
          <EmptyRow columns={7} text="No agent work" />
        {/each}
      </TableBody>
    </Table>
  </Panel>

  <Panel title="Queue">
    {#snippet actions()}
      <Select size="sm" aria-label="Status" bind:value={status} options={options(WORK_STATUSES)} placeholder="Any status" />
      <Select size="sm" aria-label="Agent" bind:value={agentId} options={agentFilter} placeholder="Any agent" />
      <Button
        size="sm"
        disabled={!ws.agentOptions.length}
        onclick={() => {
          request = { agentId: ws.agentOptions[0]?.value ?? "", issueKey: "", prompt: "" };
          requesting = true;
        }}>Ask an agent</Button
      >
    {/snippet}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Queued</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Issue</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Result</TableHead>
          <TableHead>Cost</TableHead>
          <TableHead></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each work as w (w.id)}
          <TableRow>
            <TableCell>{moment(w.createdAt)}</TableCell>
            <TableCell><code>{w.agentId}</code></TableCell>
            <TableCell>{words(w.trigger)}</TableCell>
            <TableCell>{#if w.issueKey}<code>{w.issueKey}</code>{:else}—{/if}</TableCell>
            <TableCell><Badge variant={statusVariant(w.status)}>{words(w.status)}</Badge></TableCell>
            <TableCell><span class="result" title={w.result ?? w.prompt ?? ""}>{w.result ?? w.prompt ?? "—"}</span></TableCell>
            <TableCell>{w.costUsd != null ? money(w.costUsd) : "—"}</TableCell>
            <TableCell>
              {#if w.status === "queued" || w.status === "running"}
                <Actions>
                  <Button
                    size="sm"
                    variant="ghost"
                    onclick={() => {
                      cancelling = w;
                      confirmCancel = true;
                    }}>Cancel</Button
                  >
                </Actions>
              {/if}
            </TableCell>
          </TableRow>
        {:else}
          <EmptyRow columns={8} text="No work" />
        {/each}
      </TableBody>
    </Table>
  </Panel>
</div>

<Dialog bind:open={requesting} title="Ask an agent" closeLabel={CLOSE} size="lg">
  <FormGrid>
    <Field label="Agent" required>
      <Select bind:value={request.agentId} options={ws.agentOptions} />
    </Field>
    <Field label="Issue">
      <Input bind:value={request.issueKey} maxlength={64} placeholder={`${ws.project?.identifier ?? "KEY"}-12`} />
    </Field>
    <div class="wide">
      <Field label="Prompt" required>
        <Textarea bind:value={request.prompt} rows={4} maxlength={10000} />
      </Field>
    </div>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (requesting = false)}>{CANCEL}</Button>
    <Button loading={saving} disabled={!request.agentId || !request.prompt.trim()} onclick={send}>Queue</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmCancel}
  title="Cancel this work?"
  description={cancelling ? `${words(cancelling.trigger)} for ${cancelling.agentId}` : undefined}
  confirmLabel="Cancel work"
  cancelLabel="Keep"
  closeLabel={CLOSE}
  onConfirm={cancel}
/>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
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
