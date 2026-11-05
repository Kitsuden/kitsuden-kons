<!--
  The intake inbox: what members and agents proposed. A person approves (it becomes an issue,
  optionally with a state, assignee and priority), declines, or marks it a duplicate of an issue.
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
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Textarea,
  } from "$lib/components";

  import { seg } from "../api";
  import { moment, optional, options, statusVariant, words } from "../format";
  import { INTAKE_STATUSES, PRIORITIES, type Intake, type Issue, type List } from "../types";
  import Actions from "../ui/Actions.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let status = $state("pending");
  let intakes = $state<Intake[]>([]);
  let target = $state<Intake | null>(null);

  let approving = $state(false);
  let approval = $state({ name: "", stateId: "", assigneeId: "", priority: "", reason: "" });
  let saving = $state(false);

  let declining = $state(false);
  let reason = $state("");

  let duplicating = $state(false);
  let duplicateKey = $state("");

  async function load() {
    intakes = (await ws.api.get<List<Intake>>(`/${seg(ws.projectId!)}/intakes`, { status })).docs;
  }

  // Reload on another project, another status, or a change elsewhere.
  $effect(() => {
    void [ws.version, status];
    if (ws.projectId) ws.run(load);
  });

  function openApprove(i: Intake) {
    target = i;
    approval = {
      name: i.title,
      stateId: "",
      assigneeId: "",
      priority: i.suggestedPriority && PRIORITIES.includes(i.suggestedPriority) ? i.suggestedPriority : "",
      reason: "",
    };
    approving = true;
  }

  async function approve() {
    saving = true;
    try {
      await ws.act(
        () =>
          ws.api.post(`/intakes/${seg(target!.id)}/approve`, {
            name: optional(approval.name),
            stateId: optional(approval.stateId),
            assigneeId: optional(approval.assigneeId),
            priority: optional(approval.priority),
            reason: optional(approval.reason),
          }),
        "Intake approved"
      );
      approving = false;
      await load();
    } catch {
      // Shown in the notice.
    } finally {
      saving = false;
    }
  }

  async function decline() {
    await ws.act(() => ws.api.post(`/intakes/${seg(target!.id)}/decline`, { reason: optional(reason) }), "Intake declined");
    await load();
  }

  async function duplicate() {
    const issue = await ws.act(() => ws.api.get<Issue>(`/issues/${seg(duplicateKey.trim().toUpperCase())}`));
    await ws.act(
      () => ws.api.post(`/intakes/${seg(target!.id)}/duplicate`, { duplicateOfId: issue.id }),
      `Marked a duplicate of ${issue.key}`
    );
    await load();
  }
</script>

<Panel title="Intakes">
  {#snippet actions()}
    <Select size="sm" aria-label="Status" bind:value={status} options={options(INTAKE_STATUSES)} />
  {/snippet}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Proposed</TableHead>
        <TableHead>Intake</TableHead>
        <TableHead>Suggested</TableHead>
        <TableHead>Status</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each intakes as i (i.id)}
        <TableRow>
          <TableCell>{moment(i.createdAt)}</TableCell>
          <TableCell>
            <strong>{i.title}</strong>
            {#if i.description}<div class="description">{i.description}</div>{/if}
            {#if i.source}<div class="source">{i.source}</div>{/if}
          </TableCell>
          <TableCell>{[i.suggestedType, i.suggestedPriority].filter(Boolean).map(words).join(" · ") || "—"}</TableCell>
          <TableCell>
            <Badge variant={statusVariant(i.status)}>{words(i.status)}</Badge>
            {#if i.createdIssueKey}<code>{i.createdIssueKey}</code>{/if}
          </TableCell>
          <TableCell>
            {#if i.status === "pending"}
              <Actions>
                <Button size="sm" onclick={() => openApprove(i)}>Approve</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => {
                    target = i;
                    reason = "";
                    declining = true;
                  }}>Decline</Button
                >
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => {
                    target = i;
                    duplicateKey = "";
                    duplicating = true;
                  }}>Duplicate</Button
                >
              </Actions>
            {/if}
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={5} text={`No ${words(status).toLowerCase()} intakes`} />
      {/each}
    </TableBody>
  </Table>
</Panel>

<Dialog bind:open={approving} title={`Approve ${target?.title ?? ""}`} closeLabel={CLOSE} size="lg">
  <FormGrid>
    <div class="wide">
      <Field label="Issue name">
        <Input bind:value={approval.name} maxlength={500} />
      </Field>
    </div>
    <Field label="State">
      <Select bind:value={approval.stateId} options={ws.stateOptions} placeholder="Default" />
    </Field>
    <Field label="Assignee">
      <Select bind:value={approval.assigneeId} options={ws.memberOptions} placeholder="Nobody" />
    </Field>
    <Field label="Priority">
      <Select bind:value={approval.priority} options={options(PRIORITIES)} placeholder="None" />
    </Field>
    <div class="wide">
      <Field label="Note">
        <Textarea bind:value={approval.reason} rows={2} maxlength={2000} />
      </Field>
    </div>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (approving = false)}>{CANCEL}</Button>
    <Button loading={saving} onclick={approve}>Approve</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={declining}
  title={`Decline ${target?.title ?? ""}?`}
  confirmLabel="Decline"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={decline}
>
  <Field label="Reason">
    <Textarea bind:value={reason} rows={2} maxlength={2000} />
  </Field>
</ConfirmDialog>

<ConfirmDialog
  bind:open={duplicating}
  title={`Mark ${target?.title ?? ""} as a duplicate`}
  confirmLabel="Mark duplicate"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="primary"
  onConfirm={duplicate}
>
  <Field label="Of issue" required>
    <Input bind:value={duplicateKey} maxlength={64} placeholder={`${ws.project?.identifier ?? "KEY"}-12`} />
  </Field>
</ConfirmDialog>

<style>
  .description {
    margin-top: 0.25rem;
    color: rgb(var(--ta-text-dim));
    font-size: 0.8125rem;
    white-space: pre-wrap;
    max-width: 40rem;
  }

  .source {
    margin-top: 0.25rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  code {
    margin-left: 0.4rem;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }
</style>
