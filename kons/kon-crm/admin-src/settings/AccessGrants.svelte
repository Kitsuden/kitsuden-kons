<!-- Who reaches how much of the CRM: the grants, and a form to set one. -->
<script lang="ts">
  import {
    Button,
    Checkbox,
    Input,
    Select,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { fail, ok, seg, type Api, type Note } from "../api";
  import type { Grant } from "../types";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import Panel from "../ui/Panel.svelte";
  import Result from "../ui/Result.svelte";
  import Row from "../ui/Row.svelte";

  const { api }: { api: Api } = $props();

  let grants = $state<Grant[]>([]);
  let note = $state<Note | null>(null);
  let saving = $state(false);
  let form = $state({
    subjectType: "user",
    subjectId: "",
    records: "all",
    money: true,
    sensitive: false,
    notes: true,
    sensitiveUntil: "",
    reason: "",
  });

  const yes = (v: unknown) => (v ? "Yes" : "No");
  /** No `notes` on the grant: people read notes and agents do not. */
  const notes = (g: Grant) => (g.notes === null || g.notes === undefined ? (g.subjectType === "agent" ? "No" : "Yes") : yes(g.notes));

  async function load() {
    try {
      grants = (await api.get<{ data?: Grant[] }>("access")).data ?? [];
    } catch (e) {
      note = fail(e);
    }
  }

  $effect(() => {
    untrack(load);
  });

  async function grant() {
    const subjectId = form.subjectId.trim();
    if (!subjectId) return (note = { ok: false, lines: ["Write the user or agent id."] });
    const until = form.sensitiveUntil;
    saving = true;
    try {
      await api.put(`access/${form.subjectType}/${seg(subjectId)}`, {
        records: form.records,
        money: form.money,
        sensitive: form.sensitive,
        notes: form.notes,
        sensitiveUntil: until ? new Date(`${until}T23:59:59Z`).toISOString() : null,
        reason: form.reason.trim(),
      });
      note = ok("Access saved.");
      await load();
    } catch (e) {
      note = fail(e);
    } finally {
      saving = false;
    }
  }

  async function revoke(g: Grant) {
    try {
      await api.del(`access/${g.subjectType}/${seg(g.subjectId)}`);
      await load();
    } catch (e) {
      note = fail(e);
    }
  }
</script>

<Panel title="Who reaches how much">
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Subject</TableHead>
        <TableHead>Records</TableHead>
        <TableHead>Amounts</TableHead>
        <TableHead>Sensitive</TableHead>
        <TableHead>Notes</TableHead>
        <TableHead>Until</TableHead>
        <TableHead>Why</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each grants as g (`${g.subjectType}/${g.subjectId}`)}
        <TableRow>
          <TableCell>{g.subjectType === "agent" ? "Agent" : "Person"} {g.subjectId}</TableCell>
          <TableCell>{g.records === "all" ? "All" : "Assigned"}</TableCell>
          <TableCell>{yes(g.money)}</TableCell>
          <TableCell>{yes(g.sensitive)}</TableCell>
          <TableCell>{notes(g)}</TableCell>
          <TableCell>{g.sensitiveUntil ? String(g.sensitiveUntil).slice(0, 10) : "—"}</TableCell>
          <TableCell>{g.reason}</TableCell>
          <TableCell>
            <Button size="sm" variant="ghost" onclick={() => revoke(g)}>Back to default</Button>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={8} text="No grants" />
      {/each}
    </TableBody>
  </Table>
  <Row>
    <Select
      bind:value={form.subjectType}
      options={[
        { value: "user", label: "Person" },
        { value: "agent", label: "Agent" },
      ]}
      aria-label="Kind of subject"
    />
    <Input bind:value={form.subjectId} placeholder="User or agent id" aria-label="User or agent id" />
    <Select
      bind:value={form.records}
      options={[
        { value: "all", label: "All records" },
        { value: "assigned", label: "Only assigned" },
      ]}
      aria-label="Records"
    />
    <Checkbox bind:checked={form.money} label="Amounts" />
    <Checkbox bind:checked={form.sensitive} label="Sensitive" />
    <Checkbox bind:checked={form.notes} label="Notes" />
    <Input type="date" bind:value={form.sensitiveUntil} aria-label="Sensitive access until" />
    <Input bind:value={form.reason} placeholder="Why" aria-label="Why" />
    <Button size="sm" loading={saving} onclick={grant}>Save access</Button>
  </Row>
  <Result {note} />
</Panel>
