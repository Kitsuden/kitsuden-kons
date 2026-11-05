<!--
  Who is in the project, with what role, and which members are agents. Adding a member that is
  already there changes its role (the route is an upsert), so role and agent flag are edited in
  place by posting the member again.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    Checkbox,
    ConfirmDialog,
    Field,
    Input,
    Select,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components";

  import { seg } from "../api";
  import { day, options } from "../format";
  import { ROLES, type Member, type Role } from "../types";
  import Actions from "../ui/Actions.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
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

  async function save({ userId, role, isAgent }: Pick<Member, "userId" | "role" | "isAgent">, done: string) {
    // Only the three fields the route takes: a member row also carries createdAt and the project.
    await ws.act(() => ws.api.post(path(), { userId, role, isAgent }), done);
    await ws.reloadProject();
  }

  async function add() {
    adding = true;
    try {
      await save({ userId: userId.trim(), role, isAgent }, "Member added");
      userId = "";
      isAgent = false;
      role = "member";
    } catch {
      // Shown in the notice.
    } finally {
      adding = false;
    }
  }

  async function remove() {
    const m = removing!;
    await ws.act(() => ws.api.del(`${path()}/${seg(m.userId)}`), "Member removed");
    await ws.reloadProject();
  }
</script>

<Panel title="Members">
  <form
    class="add"
    onsubmit={(e) => {
      e.preventDefault();
      add();
    }}
  >
    <Field label="User or agent id" required>
      <Input bind:value={userId} maxlength={128} />
    </Field>
    <Field label="Role">
      <Select bind:value={role} options={options(ROLES)} />
    </Field>
    <div class="check"><Checkbox bind:checked={isAgent} label="Agent" /></div>
    <div class="check"><Button type="submit" loading={adding} disabled={!userId.trim()}>Add</Button></div>
  </form>

  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Member</TableHead>
        <TableHead>Role</TableHead>
        <TableHead>Agent</TableHead>
        <TableHead>Since</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each ws.members as m (m.userId)}
        <TableRow>
          <TableCell>
            <code>{m.userId}</code>
            {#if isCreator(m)}<Badge variant="purple">creator</Badge>{/if}
          </TableCell>
          <TableCell>
            <Select
              size="sm"
              aria-label={`Role of ${m.userId}`}
              value={m.role}
              options={options(ROLES)}
              onchange={(e: Event) =>
                save({ ...m, role: (e.currentTarget as HTMLSelectElement).value as Role }, "Role changed").catch(() => ws.reloadProject())}
            />
          </TableCell>
          <TableCell>
            <Checkbox
              ariaLabel={`${m.userId} is an agent`}
              checked={m.isAgent}
              onchange={(e: Event) =>
                save({ ...m, isAgent: (e.currentTarget as HTMLInputElement).checked }, "Member updated").catch(() =>
                  ws.reloadProject()
                )}
            />
          </TableCell>
          <TableCell>{day(m.createdAt)}</TableCell>
          <TableCell>
            <Actions>
              <Button
                size="sm"
                variant="ghost"
                disabled={isCreator(m)}
                onclick={() => {
                  removing = m;
                  confirmRemove = true;
                }}>Remove</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={5} text="No members" />
      {/each}
    </TableBody>
  </Table>
</Panel>

<ConfirmDialog
  bind:open={confirmRemove}
  title={`Remove ${removing?.userId ?? ""}?`}
  confirmLabel="Remove"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={remove}
/>

<style>
  .add {
    display: grid;
    grid-template-columns: minmax(12rem, 2fr) minmax(8rem, 1fr) auto auto;
    gap: 0.75rem;
    align-items: start;
    margin-bottom: 1rem;
  }

  .check {
    padding-top: 1.6rem;
  }

  code {
    white-space: nowrap;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
    margin-right: 0.5rem;
  }

  @media (max-width: 640px) {
    .add {
      grid-template-columns: minmax(0, 1fr);
    }
    .check {
      padding-top: 0;
    }
  }
</style>
