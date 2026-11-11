<!--
  Who is in the project, with what role, and which members are agents. Adding a member that is
  already there changes its role (the route is an upsert), so the role and the agent flag are
  changed from the row's menu by posting the member again.
-->
<script lang="ts">
  import { Badge, Button, Checkbox, ConfirmDialog, DataTable, EmptyState, Field, Input, Select, type DataColumn } from "$lib/components";

  import { seg } from "../api";
  import { day, options, words } from "../format";
  import { ROLES, type Member, type Role } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import RowMenu, { type RowAction } from "../ui/RowMenu.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let userId = $state("");
  let role = $state<Role>("member");
  let isAgent = $state(false);
  let adding = $state(false);
  let removing = $state<Member | null>(null);
  let confirmRemove = $state(false);

  const path = () => `/projects/${seg(ws.projectId!)}/members`;
  const isCreator = (m: Member) => m.userId === ws.project?.createdBy;
  const kind = (m: Member) => (m.isAgent ? "Agent" : "Person");

  const columns: DataColumn<Member>[] = [
    { key: "userId", header: "Member", sortable: true, hideable: false },
    { key: "role", header: "Role", sortable: true, value: (m) => words(m.role) },
    { key: "kind", header: "Kind", sortable: true, value: kind },
    { key: "createdAt", header: "Since", sortable: true, value: (m) => day(m.createdAt) },
  ];

  async function save({ userId, role, isAgent }: Pick<Member, "userId" | "role" | "isAgent">, done: string, what: string) {
    // Only the three fields the route takes: a member row also carries createdAt and the project.
    await ws.act(() => ws.api.post(path(), { userId, role, isAgent }), done, what);
    await ws.reloadProject();
  }

  async function add() {
    if (!userId.trim()) return;
    adding = true;
    try {
      await save({ userId: userId.trim(), role, isAgent }, "Member added", "Could not add the member");
      userId = "";
      isAgent = false;
      role = "member";
    } catch {
      // Shown in the toast.
    } finally {
      adding = false;
    }
  }

  async function remove() {
    const m = removing!;
    await ws.act(() => ws.api.del(`${path()}/${seg(m.userId)}`), "Member removed", "Could not remove the member");
    await ws.reloadProject();
  }

  const menu = (m: Member): RowAction[] => [
    ...ROLES.filter((r) => r !== m.role).map((r) => ({
      label: `Make ${r}`,
      onSelect: () => {
        save({ ...m, role: r }, "Role changed", "Could not change the role").catch(() => ws.reloadProject());
      },
    })),
    {
      label: m.isAgent ? "Mark as a person" : "Mark as an agent",
      separated: true,
      onSelect: () => {
        save({ ...m, isAgent: !m.isAgent }, "Member updated", "Could not update the member").catch(() => ws.reloadProject());
      },
    },
    {
      label: "Remove",
      danger: true,
      separated: true,
      disabled: isCreator(m),
      onSelect: () => {
        removing = m;
        confirmRemove = true;
      },
    },
  ];
</script>

<Panel title="Members">
  {#snippet status()}
    <Badge>{ws.members.length} {ws.members.length === 1 ? "member" : "members"}</Badge>
  {/snippet}
  <DataTable caption="Project members" rows={ws.members} {columns} rowKey="userId" rowLabel={(m) => m.userId}>
    {#snippet cell(m, col)}
      {#if col.key === "userId"}
        <span class="member">
          <code>{m.userId}</code>
          {#if isCreator(m)}<Badge variant="purple">Creator</Badge>{/if}
        </span>
      {:else if col.key === "role"}
        <Badge variant={m.role === "owner" ? "accent" : m.role === "viewer" ? "secondary" : "default"}>{words(m.role)}</Badge>
      {:else if col.key === "kind"}
        <Badge variant={m.isAgent ? "info" : "default"}>{kind(m)}</Badge>
      {:else}
        <span class="nowrap">{col.value?.(m)}</span>
      {/if}
    {/snippet}
    {#snippet rowActions(m)}
      <RowMenu label={`Actions: ${m.userId}`} items={menu(m)} />
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="No members yet" description="Add the first one with the form below." />
    {/snippet}
  </DataTable>

  <h3 class="sub">Add a member</h3>
  <FormGrid label="Add a member" onsubmit={add}>
    <Field label="User or agent id" required>
      <Input bind:value={userId} maxlength={128} />
    </Field>
    <Field label="Role">
      <Select bind:value={role} options={options(ROLES)} />
    </Field>
    <div>
      <Checkbox bind:checked={isAgent} label="Agent" />
    </div>
    {#snippet actions()}
      <Button type="submit" loading={adding} disabled={!userId.trim()}>Add member</Button>
    {/snippet}
  </FormGrid>
</Panel>

<ConfirmDialog
  bind:open={confirmRemove}
  title={`Remove ${removing?.userId ?? ""}?`}
  confirmLabel="Remove"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={remove}
/>

<style>
  .nowrap {
    white-space: nowrap;
  }

  .sub {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .member {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  code {
    white-space: nowrap;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }
</style>
