<!--
  The intake inbox: what members and agents proposed. A person approves (it becomes an issue,
  optionally with a state, assignee and priority), declines, or marks it a duplicate of an issue.
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
    Input,
    Select,
    Textarea,
    type DataColumn,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg } from "../api";
  import { moment, optional, options, statusVariant, words } from "../format";
  import { INTAKE_STATUSES, PRIORITIES, type Intake, type Issue, type List } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  // Which intakes are listed (the API filters by status).
  let shown = $state("pending");
  let intakes = $state<Intake[]>([]);
  let target = $state<Intake | null>(null);

  let approving = $state(false);
  let approval = $state({ name: "", stateId: "", assigneeId: "", priority: "", reason: "" });
  let saving = $state(false);

  let declining = $state(false);
  let reason = $state("");

  let duplicating = $state(false);
  let duplicateKey = $state("");

  const suggested = (i: Intake) => [i.suggestedType, i.suggestedPriority].filter(Boolean).map(words).join(" · ") || "—";

  const columns: DataColumn<Intake>[] = [
    { key: "createdAt", header: "Proposed", sortable: true, value: (i) => moment(i.createdAt) },
    { key: "title", header: "Intake", sortable: true, hideable: false },
    { key: "suggested", header: "Suggested", value: suggested },
    { key: "status", header: "Status", value: (i) => words(i.status) },
  ];

  const data = createLoad(async () => {
    intakes = (await ws.api.get<List<Intake>>(`/${seg(ws.projectId!)}/intakes`, { status: shown })).docs;
  });

  // Reload on another project, another status, or a change elsewhere.
  $effect(() => {
    void [ws.version, shown];
    if (ws.projectId) untrack(data.load);
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
        "Intake approved",
        "Could not approve the intake"
      );
      approving = false;
      await data.load();
    } catch {
      // Shown in the toast.
    } finally {
      saving = false;
    }
  }

  async function decline() {
    await ws.act(
      () => ws.api.post(`/intakes/${seg(target!.id)}/decline`, { reason: optional(reason) }),
      "Intake declined",
      "Could not decline the intake"
    );
    await data.load();
  }

  async function duplicate() {
    const issue = await ws.act(() => ws.api.get<Issue>(`/issues/${seg(duplicateKey.trim().toUpperCase())}`), undefined, "Could not find that issue");
    await ws.act(
      () => ws.api.post(`/intakes/${seg(target!.id)}/duplicate`, { duplicateOfId: issue.id }),
      `Marked a duplicate of ${issue.key}`,
      "Could not mark the intake a duplicate"
    );
    await data.load();
  }
</script>

<Panel title="Intakes">
  {#snippet status()}
    {#if data.ready}<Badge>{intakes.length} {words(shown).toLowerCase()}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Select aria-label="Status" bind:value={shown} options={options(INTAKE_STATUSES)} />
  {/snippet}
  <DataTable
    caption="Intakes"
    rows={intakes}
    {columns}
    rowKey="id"
    rowLabel={(i) => i.title}
    pageSize={25}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(i, col)}
      {#if col.key === "title"}
        <div class="intake">
          <strong>{i.title}</strong>
          {#if i.description}<span class="description">{i.description}</span>{/if}
          {#if i.source}<span class="source">{i.source}</span>{/if}
        </div>
      {:else if col.key === "status"}
        <span class="state">
          <Badge variant={statusVariant(i.status)}>{words(i.status)}</Badge>
          {#if i.createdIssueKey}<code>{i.createdIssueKey}</code>{/if}
        </span>
      {:else}
        {col.value?.(i)}
      {/if}
    {/snippet}
    {#snippet rowActions(i)}
      {#if i.status === "pending"}
        <span class="decide">
          <Button size="sm" onclick={() => openApprove(i)}>Approve</Button>
          <RowMenu
            label={`More actions: ${i.title}`}
            items={[
              {
                label: "Mark duplicate",
                onSelect: () => {
                  target = i;
                  duplicateKey = "";
                  duplicating = true;
                },
              },
              {
                label: "Decline",
                danger: true,
                separated: true,
                onSelect: () => {
                  target = i;
                  reason = "";
                  declining = true;
                },
              },
            ]}
          />
        </span>
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState
        size="sm"
        level={null}
        title={`No ${words(shown).toLowerCase()} intakes`}
        description="Members and agents propose work as intakes; each one waits here for a decision."
      />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open={approving} title={`Approve ${target?.title ?? ""}`} closeLabel={CLOSE} size="lg">
  <FormGrid label="Approve the intake" onsubmit={() => !saving && approve()}>
    <Field label="Issue name" class="wide">
      <Input bind:value={approval.name} maxlength={500} />
    </Field>
    <Field label="State">
      <Select bind:value={approval.stateId} options={ws.stateOptions} placeholder="Default" />
    </Field>
    <Field label="Assignee">
      <Select bind:value={approval.assigneeId} options={ws.memberOptions} placeholder="Nobody" />
    </Field>
    <Field label="Priority">
      <Select bind:value={approval.priority} options={options(PRIORITIES)} placeholder="None" />
    </Field>
    <Field label="Note" class="wide">
      <Textarea bind:value={approval.reason} rows={2} maxlength={2000} />
    </Field>
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
  variant="danger"
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
  .intake {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 14rem;
    max-width: 40rem;
  }

  .description {
    color: rgb(var(--ta-text-dim));
    font-size: 0.8125rem;
    white-space: pre-wrap;
  }

  .source {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .state,
  .decide {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  code {
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }
</style>
